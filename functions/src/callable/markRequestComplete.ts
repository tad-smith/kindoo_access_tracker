// Chrome extension bridge: flips a `pending` request to `complete`.
// Mirrors the SPA's `useCompleteAddRequest` / `useCompleteRemoveRequest`
// hooks so the callable produces the same Firestore state. The SPA
// hooks remain the path for some flows (reject, cancel) and for any
// flow that needs manager-supplied building overrides.
//
// Behaviour by request type:
//   - `add_manual` / `add_temp`: read the seat doc inside the
//     transaction. If absent → create it from the request body. If
//     present → auto-merge the new grant into the existing seat
//     (extension v2.2: the extension has no "reconcile via All Seats"
//     UI to fall back to, so the callable diverges from the SPA hook
//     and merges in place). Match the existing primary grant or any
//     `duplicate_grants[]` entry by `(scope, type)`; on hit, extend
//     the matched grant's `building_names` (dedup, preserve order).
//     On miss, append a new entry to `duplicate_grants[]`. Cap is
//     enforced against `stake.last_over_caps_json`: if any pool the
//     merge touches is already over cap, reject. Both the seat write
//     and the request flip land in the same transaction.
//   - `remove`: just flip the request to complete. The existing
//     `removeSeatOnRequestComplete` trigger handles the Admin-SDK
//     seat delete. On the R-1 race (seat already gone) we append the
//     system note to `completion_note` so the audit trail explains
//     why no delete fired — matching `resolveRemoveCompletionNote` in
//     the SPA hook.
//
// The audit row is fanned in by `auditRequestWrites` from the
// resulting write; `notifyOnRequestWrite` fires the requester email
// from the same write. No extra wiring here.
//
// Auth: same authority check as `runImportNow` — read the
// `kindooManagers/{canonical}` doc directly.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { canonicalEmail } from '@kindoo/shared';
import type {
  AccessRequest,
  DuplicateGrant,
  KindooManager,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
  OverCapEntry,
  Seat,
} from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';

/** R-1 race tag — mirrors `R1_AUTO_NOTE` in `apps/web/.../queue/hooks.ts`. */
const R1_AUTO_NOTE = 'Seat already removed at completion time (no-op).';

/**
 * Resolve the `completion_note` for a remove-complete write. Manager's
 * prose wins; on the R-1 race we append the `[System: ...]` tag so the
 * email body surfaces both signals. Mirrors `resolveRemoveCompletionNote`
 * in the SPA hook byte-for-byte.
 */
function resolveRemoveCompletionNote(seatExists: boolean, trimmedNote: string): string | undefined {
  if (!seatExists) {
    return trimmedNote.length > 0 ? `${trimmedNote}\n\n[System: ${R1_AUTO_NOTE}]` : R1_AUTO_NOTE;
  }
  return trimmedNote.length > 0 ? trimmedNote : undefined;
}

/** De-duplicate while preserving first-seen order. */
function mergeBuildings(existing: string[], incoming: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of existing) {
    if (!seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  }
  for (const b of incoming) {
    if (!seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  }
  return out;
}

/**
 * Plan an add-type merge against an existing seat. Returns the fields
 * to write on the seat doc + the set of pool scopes the merge touches
 * (for the cap check). Match rule: primary first, then walk
 * `duplicate_grants[]`, looking for the first `(scope, type)` match. On
 * hit, extend the matched grant's `building_names` (dedup, preserve
 * order). On miss, append a new entry to `duplicate_grants[]`. Primary
 * grant identity (callings, reason, dates) is never modified.
 */
export function planAddMerge(opts: {
  existingSeat: Seat;
  request: AccessRequest;
  detectedAt: FirebaseFirestore.Timestamp;
}): {
  update: {
    building_names?: string[];
    duplicate_grants?: DuplicateGrant[];
  };
  touchedScopes: Set<string>;
} {
  const { existingSeat, request, detectedAt } = opts;
  const reqType: Seat['type'] = request.type === 'add_manual' ? 'manual' : 'temp';
  const reqScope = request.scope;
  const reqBuildings = request.building_names ?? [];
  const touchedScopes = new Set<string>([reqScope]);

  // Primary match: scope + type.
  if (existingSeat.scope === reqScope && existingSeat.type === reqType) {
    const merged = mergeBuildings(existingSeat.building_names ?? [], reqBuildings);
    if (merged.length === (existingSeat.building_names ?? []).length) {
      // No-op merge — request adds no new building. Still touch the
      // pool for cap-check purposes; emit an empty update so the
      // caller knows no seat write is needed.
      return { update: {}, touchedScopes };
    }
    return { update: { building_names: merged }, touchedScopes };
  }

  // Walk duplicate_grants[] for a (scope, type) match.
  const dupes = existingSeat.duplicate_grants ?? [];
  const matchIdx = dupes.findIndex((d) => d.scope === reqScope && d.type === reqType);
  if (matchIdx >= 0) {
    const matched = dupes[matchIdx]!;
    const merged = mergeBuildings(matched.building_names ?? [], reqBuildings);
    if (merged.length === (matched.building_names ?? []).length) {
      // No new building added; skip the write.
      return { update: {}, touchedScopes };
    }
    const next = dupes.slice();
    next[matchIdx] = { ...matched, building_names: merged };
    return { update: { duplicate_grants: next }, touchedScopes };
  }

  // No (scope, type) match anywhere — append a new DuplicateGrant.
  const entry: DuplicateGrant = {
    scope: reqScope,
    type: reqType,
    building_names: reqBuildings,
    detected_at: detectedAt as DuplicateGrant['detected_at'],
  };
  if (request.reason) entry.reason = request.reason;
  if (request.type === 'add_temp') {
    if (request.start_date) entry.start_date = request.start_date;
    if (request.end_date) entry.end_date = request.end_date;
  }
  return {
    update: { duplicate_grants: [...dupes, entry] },
    touchedScopes,
  };
}

/**
 * Inspect `stake.last_over_caps_json` for any pool the merge touches.
 * Returns the first over-cap entry whose pool is touched, or `undefined`
 * if all touched pools are within cap. The importer is the source of
 * truth for over-cap state; this is a defensive guard so managers can't
 * stack new grants onto an already-over-cap pool.
 */
export function findTouchedOverCap(
  overCaps: OverCapEntry[],
  touchedScopes: Set<string>,
): OverCapEntry | undefined {
  for (const e of overCaps) {
    if (touchedScopes.has(e.pool)) return e;
  }
  return undefined;
}

export const markRequestComplete = onCall(
  { serviceAccount: APP_SA },
  async (req): Promise<MarkRequestCompleteOutput> => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'sign in required');
    }
    const data = (req.data ?? {}) as Partial<MarkRequestCompleteInput>;
    const stakeId = data.stakeId;
    const requestId = data.requestId;
    if (!stakeId || typeof stakeId !== 'string') {
      throw new HttpsError('invalid-argument', 'stakeId required');
    }
    if (!requestId || typeof requestId !== 'string') {
      throw new HttpsError('invalid-argument', 'requestId required');
    }

    const typedEmail = req.auth.token.email;
    if (!typedEmail) {
      throw new HttpsError('failed-precondition', 'auth token has no email');
    }
    const canonical = canonicalEmail(typedEmail);

    const db = getDb();
    const mgrSnap = await db.doc(`stakes/${stakeId}/kindooManagers/${canonical}`).get();
    if (!mgrSnap.exists) {
      throw new HttpsError('permission-denied', 'caller is not a manager of this stake');
    }
    const mgr = mgrSnap.data() as KindooManager;
    if (mgr.active !== true) {
      throw new HttpsError('permission-denied', 'manager record is inactive');
    }

    const trimmedNote = (data.completionNote ?? '').trim();

    // Extension v2.2 — optional Kindoo provisioning metadata. Both
    // fields are validated structurally (string type) and the
    // provisioning note is bounded so a runaway client cannot bloat
    // the request doc. Trimming mirrors `completionNote`; an empty
    // result drops the field from the write so the doc stays clean.
    const PROVISIONING_NOTE_MAX_LEN = 500;
    let kindooUid: string | undefined;
    if (data.kindooUid !== undefined) {
      if (typeof data.kindooUid !== 'string') {
        throw new HttpsError('invalid-argument', 'kindooUid must be a string');
      }
      const trimmed = data.kindooUid.trim();
      if (trimmed.length > 0) kindooUid = trimmed;
    }
    let provisioningNote: string | undefined;
    if (data.provisioningNote !== undefined) {
      if (typeof data.provisioningNote !== 'string') {
        throw new HttpsError('invalid-argument', 'provisioningNote must be a string');
      }
      if (data.provisioningNote.length > PROVISIONING_NOTE_MAX_LEN) {
        throw new HttpsError(
          'invalid-argument',
          `provisioningNote exceeds ${PROVISIONING_NOTE_MAX_LEN} chars`,
        );
      }
      const trimmed = data.provisioningNote.trim();
      if (trimmed.length > 0) provisioningNote = trimmed;
    }

    const actor = { email: typedEmail, canonical };
    const reqRef = db.doc(`stakes/${stakeId}/requests/${requestId}`);
    const stakeRef = db.doc(`stakes/${stakeId}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(reqRef);
      if (!snap.exists) {
        throw new HttpsError('not-found', 'request not found');
      }
      const cur = snap.data() as AccessRequest;
      if (cur.status !== 'pending') {
        throw new HttpsError(
          'failed-precondition',
          `request is not pending (current status: ${cur.status})`,
        );
      }

      // Add-type: either create the seat (no existing) or merge into
      // it. Remove-type: pre-read the seat to know whether to stamp
      // the R-1 system note; the `removeSeatOnRequestComplete` trigger
      // does the Admin-SDK delete.
      //
      // Firestore transactions require all reads precede all writes,
      // so we gather every read up front: seat (always), stake (for
      // cap check on the merge path). The stake read is cheap and
      // unconditional — emitting it on the create path too keeps the
      // read graph stable, which avoids transaction-retry surprises.
      let seatExists = false;
      let seatBody: Record<string, unknown> | null = null;
      let newSeatRef: FirebaseFirestore.DocumentReference | null = null;
      let mergeSeatRef: FirebaseFirestore.DocumentReference | null = null;
      let mergeUpdate: Record<string, unknown> | null = null;
      if (cur.type === 'add_manual' || cur.type === 'add_temp') {
        const seatTarget = cur.member_canonical;
        const seatRef = db.doc(`stakes/${stakeId}/seats/${seatTarget}`);
        const seatSnap = await tx.get(seatRef);
        // Stake doc is only needed for the merge path's cap check.
        // Reading conditionally keeps the create path's read graph
        // minimal (it had only `request` + `seat` before).
        const stakeSnap = seatSnap.exists ? await tx.get(stakeRef) : null;

        if (!seatSnap.exists) {
          // No existing seat → create.
          const now = Timestamp.now();
          const seatType: Seat['type'] = cur.type === 'add_manual' ? 'manual' : 'temp';
          const body: Record<string, unknown> = {
            member_canonical: cur.member_canonical,
            member_email: cur.member_email,
            member_name: cur.member_name,
            scope: cur.scope,
            type: seatType,
            callings: [],
            building_names: cur.building_names ?? [],
            duplicate_grants: [],
            granted_by_request: cur.request_id,
            created_at: now,
            last_modified_at: now,
            last_modified_by: actor,
            lastActor: actor,
          };
          if (cur.type === 'add_temp') {
            if (cur.start_date) body.start_date = cur.start_date;
            if (cur.end_date) body.end_date = cur.end_date;
          }
          if (cur.reason) body.reason = cur.reason;
          newSeatRef = seatRef;
          seatBody = body;
        } else {
          // Seat exists → plan an auto-merge. Cap-check against the
          // stake's `last_over_caps_json` for any pool the merge
          // would touch. The SPA hook still throws "reconcile via All
          // Seats" here; the callable diverges because the extension
          // has no reconcile UI to fall back to.
          const existingSeat = seatSnap.data() as Seat;
          // Per-array timestamps must be client-side `Timestamp` values;
          // Firestore rejects `FieldValue.serverTimestamp()` sentinels
          // inside arrays. Mirrors the importer's `nowTs` pattern in
          // `Importer.ts`.
          const detectedAt = Timestamp.now();
          const plan = planAddMerge({
            existingSeat,
            request: cur,
            detectedAt,
          });
          const overCaps = (stakeSnap?.data()?.last_over_caps_json ?? []) as OverCapEntry[];
          const offender = findTouchedOverCap(overCaps, plan.touchedScopes);
          if (offender) {
            throw new HttpsError(
              'failed-precondition',
              `Pool '${offender.pool}' is over cap (${offender.count}/${offender.cap}); cannot add another grant. Reconcile first.`,
            );
          }
          // Only write if the plan changed something. A no-op merge
          // (e.g. request building_names already present) still flips
          // the request to complete but skips the seat write.
          if (plan.update.building_names || plan.update.duplicate_grants) {
            const seatUpdate: Record<string, unknown> = {
              ...plan.update,
              last_modified_at: FieldValue.serverTimestamp(),
              last_modified_by: actor,
              lastActor: actor,
            };
            mergeSeatRef = seatRef;
            mergeUpdate = seatUpdate;
          }
        }
      } else if (cur.type === 'remove') {
        const seatTarget = cur.seat_member_canonical ?? cur.member_canonical;
        const seatRef = db.doc(`stakes/${stakeId}/seats/${seatTarget}`);
        const seatSnap = await tx.get(seatRef);
        seatExists = seatSnap.exists;
      }

      const update: Record<string, unknown> = {
        status: 'complete',
        completer_email: typedEmail,
        completer_canonical: canonical,
        completed_at: FieldValue.serverTimestamp(),
        lastActor: actor,
      };
      if (cur.type === 'remove') {
        const resolved = resolveRemoveCompletionNote(seatExists, trimmedNote);
        if (resolved !== undefined) update.completion_note = resolved;
      } else if (trimmedNote.length > 0) {
        update.completion_note = trimmedNote;
      }
      if (kindooUid !== undefined) update.kindoo_uid = kindooUid;
      if (provisioningNote !== undefined) update.provisioning_note = provisioningNote;

      if (newSeatRef && seatBody) {
        tx.set(newSeatRef, seatBody);
      }
      if (mergeSeatRef && mergeUpdate) {
        tx.update(mergeSeatRef, mergeUpdate);
      }
      tx.update(reqRef, update);
    });

    return { ok: true };
  },
);
