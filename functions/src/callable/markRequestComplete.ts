// Chrome extension bridge: flips a `pending` request to `complete`.
// Mirrors the SPA's `useCompleteAddRequest` / `useCompleteRemoveRequest`
// hooks so the callable produces the same Firestore state. The SPA
// hooks remain the path for some flows (reject, cancel) and for any
// flow that needs manager-supplied building overrides.
//
// Behaviour by request type:
//   - `add_manual` / `add_temp`: read the seat doc inside the
//     transaction. If absent → create it from the request body
//     (ward-scope requests with empty `building_names` fall back to
//     the ward's `building_name` so the seat is never created with
//     no building reference). If present → auto-merge the new grant
//     into the existing seat (extension v2.2: the extension has no
//     "reconcile via All Seats" UI to fall back to, so the callable
//     diverges from the SPA hook and merges in place). Match the
//     existing primary grant or any `duplicate_grants[]` entry by
//     `(scope, type)`; on hit, extend the matched grant's
//     `building_names` (dedup, preserve order). On miss, append a
//     new entry to `duplicate_grants[]`. Both the seat write and the
//     request flip land in the same transaction.
//   - `remove`: just flip the request to complete. The existing
//     `removeSeatOnRequestComplete` trigger handles the Admin-SDK
//     seat delete. On the R-1 race (seat already gone) we append the
//     system note to `completion_note` so the audit trail explains
//     why no delete fired — matching `resolveRemoveCompletionNote` in
//     the SPA hook.
//   - `edit_auto` / `edit_manual` / `edit_temp`: locate the seat by
//     `member_canonical`, find the matching slot by (scope, type)
//     (primary first, then `duplicate_grants[]`), and replace the
//     editable fields in place via `planEditSeat`. `edit_auto` is
//     rejected when `scope === 'stake'` (Policy 1 — stake auto seats
//     are Church-granted to all stake buildings and can't be edited).
//     Edits don't change scope/type, so no over-cap recompute. The
//     seat write + request flip land in the same transaction.
//
// Over-cap policy (post-2026-05-12 pivot): Kindoo is the source of
// truth — if Kindoo accepted the user, SBA reflects that. Completion
// never rejects for cap. Instead the callable recomputes the full
// over-cap state from the post-write seat set inside the same
// transaction and writes it to `stake.last_over_caps_json`. The
// existing `notifyOnOverCap` trigger fires its email on the
// empty-to-non-empty transition. The output payload echoes the same
// snapshot so the extension can render a warning banner inline.
//
// The audit row is fanned in by `auditRequestWrites` from the
// resulting write; `notifyOnRequestWrite` fires the requester email
// from the same write. No extra wiring here.
//
// Auth: same authority check as `runImportNow` — read the
// `kindooManagers/{canonical}` doc directly.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
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
  Stake,
  Ward,
} from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { computeOverCaps } from '../lib/overCaps.js';

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
  /**
   * Kindoo site the request's scope targets — derived by the caller
   * from the ward's `kindoo_site_id` (stake-scope ⇒ home ⇒ null). T-42:
   * stamped onto a newly-appended `duplicate_grants[]` entry so per-
   * site provision walks find the new grant under the right site.
   *
   * `undefined` signals the caller couldn't resolve the request's
   * ward (uniform missing-ward skip-with-warning policy); the
   * resulting duplicate omits the field so the ward-fallback
   * resolver handles classification at read time.
   */
  requestSiteId: string | null | undefined;
}): {
  update: {
    building_names?: string[];
    duplicate_grants?: DuplicateGrant[];
    /**
     * T-42 / T-43: denormalised mirror of `duplicate_grants[].scope`.
     * Returned alongside `duplicate_grants` so the caller can apply
     * both in one transaction. Absent when `duplicate_grants` is
     * unchanged.
     */
    duplicate_scopes?: string[];
  };
  touchedScopes: Set<string>;
} {
  const { existingSeat, request, detectedAt, requestSiteId } = opts;
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
    // Scopes set is unchanged — only `building_names` extended on the
    // matched entry. No `duplicate_scopes` write needed.
    return { update: { duplicate_grants: next }, touchedScopes };
  }

  // No (scope, type) match anywhere — append a new DuplicateGrant.
  // T-42: stamp `kindoo_site_id` from the caller-supplied site so the
  // per-site provision walk finds this grant under the right site.
  // `undefined` (caller couldn't resolve the ward) leaves the field
  // unset on the new entry.
  const entry: DuplicateGrant = {
    scope: reqScope,
    type: reqType,
    building_names: reqBuildings,
    detected_at: detectedAt as DuplicateGrant['detected_at'],
  };
  if (requestSiteId !== undefined) entry.kindoo_site_id = requestSiteId;
  if (request.reason) entry.reason = request.reason;
  if (request.type === 'add_temp') {
    if (request.start_date) entry.start_date = request.start_date;
    if (request.end_date) entry.end_date = request.end_date;
  }
  const nextDupes = [...dupes, entry];
  return {
    update: {
      duplicate_grants: nextDupes,
      // T-42 / T-43: keep the primitive mirror in sync. Append-only
      // here, but rebuild from the array to keep one source of truth.
      duplicate_scopes: nextDupes.map((d) => d.scope),
    },
    touchedScopes,
  };
}

/**
 * Plan an edit against an existing seat. Symmetric with `planAddMerge`
 * but the edit replaces fields on the matching slot rather than merging.
 *
 * Slot-resolution order: primary `{scope, type}` match wins; otherwise
 * walk `duplicate_grants[]` for the first `{scope, type}` match. If no
 * slot matches, returns `null` — caller throws a `failed-precondition`
 * error.
 *
 * `edit_auto`: replaces `building_names` only. Per Policy B the template's
 * `allowed_buildings` are pre-checked AND disabled in the modal so the
 * incoming `building_names` is the template's set plus extras; no extra
 * server-side enforcement needed.
 *
 * `edit_manual`: replaces `reason` + `building_names`. Manual seats
 * store the operator-typed calling name in `reason`. `seat.callings`
 * for manual seats is left untouched — manual seats by convention
 * carry `callings: []`, and the existing convention is preserved.
 *
 * `edit_temp`: replaces `reason` + `building_names` + `start_date` +
 * `end_date`. All four fields are operator-editable in the modal.
 */
export function planEditSeat(
  existingSeat: Seat,
  targetType: Seat['type'],
  scope: string,
  fields: {
    building_names: string[];
    reason?: string;
    start_date?: string;
    end_date?: string;
  },
): { update: Record<string, unknown>; slot: 'primary' | 'duplicate'; index: number } | null {
  // Primary match: scope + type.
  if (existingSeat.scope === scope && existingSeat.type === targetType) {
    const update: Record<string, unknown> = {
      building_names: fields.building_names,
    };
    if (fields.reason !== undefined) update.reason = fields.reason;
    if (fields.start_date !== undefined) update.start_date = fields.start_date;
    if (fields.end_date !== undefined) update.end_date = fields.end_date;
    return { update, slot: 'primary', index: -1 };
  }

  // Walk duplicate_grants[] for a (scope, type) match.
  const dupes = existingSeat.duplicate_grants ?? [];
  const matchIdx = dupes.findIndex((d) => d.scope === scope && d.type === targetType);
  if (matchIdx >= 0) {
    const matched = dupes[matchIdx]!;
    const next = dupes.slice();
    const replacement: DuplicateGrant = {
      ...matched,
      building_names: fields.building_names,
    };
    if (fields.reason !== undefined) replacement.reason = fields.reason;
    if (fields.start_date !== undefined) replacement.start_date = fields.start_date;
    if (fields.end_date !== undefined) replacement.end_date = fields.end_date;
    next[matchIdx] = replacement;
    return {
      update: { duplicate_grants: next },
      slot: 'duplicate',
      index: matchIdx,
    };
  }

  return null;
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
    const seatsRef = db.collection(`stakes/${stakeId}/seats`);
    const wardsRef = db.collection(`stakes/${stakeId}/wards`);

    const overCaps = await db.runTransaction<OverCapEntry[]>(async (tx) => {
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

      // Add-type: read the target seat + all seats + all wards + stake
      // doc so we can plan the seat write AND recompute over-caps from
      // the post-write seat set, all inside the same transaction.
      // Remove-type: pre-read only the target seat to detect the R-1
      // race; over-cap recompute on remove is the seat-delete trigger's
      // job, not ours (per spec — keeps responsibilities split).
      //
      // Firestore transactions require all reads precede all writes,
      // so we gather every read up front.
      let seatExists = false;
      let seatBody: Record<string, unknown> | null = null;
      let newSeatRef: FirebaseFirestore.DocumentReference | null = null;
      let mergeSeatRef: FirebaseFirestore.DocumentReference | null = null;
      let mergeUpdate: Record<string, unknown> | null = null;
      // The post-write seat set we will hand to `computeOverCaps`.
      // Empty array means "no recompute needed" (the remove path).
      let postWriteSeats: Seat[] | null = null;
      let stakeSeatCap = 0;
      let wards: Ward[] = [];

      if (cur.type === 'add_manual' || cur.type === 'add_temp') {
        const seatTarget = cur.member_canonical;
        const seatRef = seatsRef.doc(seatTarget);
        const [seatSnap, allSeatsSnap, allWardsSnap, stakeSnap] = await Promise.all([
          tx.get(seatRef),
          tx.get(seatsRef),
          tx.get(wardsRef),
          tx.get(stakeRef),
        ]);
        const allSeats = allSeatsSnap.docs.map((d) => d.data() as Seat);
        wards = allWardsSnap.docs.map((d) => d.data() as Ward);
        stakeSeatCap = (stakeSnap.data() as Stake | undefined)?.stake_seat_cap ?? 0;

        if (!seatSnap.exists) {
          // No existing seat → create. For a ward-scope request with
          // empty `building_names` (legacy data from before the
          // extension's building-name fix), fall back to the ward's
          // own `building_name` so the new seat is never created
          // without a building reference.
          const now = Timestamp.now();
          const seatType: Seat['type'] = cur.type === 'add_manual' ? 'manual' : 'temp';
          let buildingNames = cur.building_names ?? [];
          if (buildingNames.length === 0 && cur.scope !== 'stake') {
            const ward = wards.find((w) => w.ward_code === cur.scope);
            if (ward?.building_name) {
              buildingNames = [ward.building_name];
            }
          }
          // T-42: stamp `kindoo_site_id` on the new seat when the
          // request's scope resolves to a known ward (or stake → home).
          // Uniform missing-ward skip-with-warning policy: an unknown
          // ward leaves the field unset so the downstream ward-fallback
          // resolver handles classification at read time — same shape
          // as the migration's primary-side skip. A misconfigured
          // request shouldn't silently become home-categorised.
          let newSeatSite: string | null | undefined;
          if (cur.scope === 'stake') {
            newSeatSite = null;
          } else {
            const wardDoc = wards.find((w) => w.ward_code === cur.scope);
            if (wardDoc) {
              newSeatSite = wardDoc.kindoo_site_id ?? null;
            } else {
              newSeatSite = undefined; // leave the field unset on the seat
              logger.warn(
                `markRequestComplete: ward '${cur.scope}' not found while creating seat for ${cur.member_canonical}; leaving kindoo_site_id unset (ward-fallback handles classification at read time)`,
              );
            }
          }
          const body: Record<string, unknown> = {
            member_canonical: cur.member_canonical,
            member_email: cur.member_email,
            member_name: cur.member_name,
            scope: cur.scope,
            type: seatType,
            callings: [],
            building_names: buildingNames,
            duplicate_grants: [],
            // T-42 / T-43: server-maintained primitive mirror; always
            // set, even when empty.
            duplicate_scopes: [],
            granted_by_request: cur.request_id,
            created_at: now,
            last_modified_at: now,
            last_modified_by: actor,
            lastActor: actor,
          };
          if (newSeatSite !== undefined) body.kindoo_site_id = newSeatSite;
          if (cur.type === 'add_temp') {
            if (cur.start_date) body.start_date = cur.start_date;
            if (cur.end_date) body.end_date = cur.end_date;
          }
          if (cur.reason) body.reason = cur.reason;
          newSeatRef = seatRef;
          seatBody = body;

          // Post-write seat set = existing seats + the new seat. Only
          // `scope` matters for `computeOverCaps`; we synthesize a
          // minimal Seat-shaped projection.
          const projected = { scope: cur.scope } as unknown as Seat;
          postWriteSeats = [...allSeats, projected];
        } else {
          // Seat exists → plan an auto-merge. Cap is NOT a guard here
          // (post-2026-05-12 pivot: Kindoo is source of truth, SBA
          // reflects). We compute the post-write seat set with the
          // modified seat substituted in, then recompute over-caps for
          // the notification path.
          const existingSeat = seatSnap.data() as Seat;
          // Per-array timestamps must be client-side `Timestamp` values;
          // Firestore rejects `FieldValue.serverTimestamp()` sentinels
          // inside arrays. Mirrors the importer's `nowTs` pattern in
          // `Importer.ts`.
          const detectedAt = Timestamp.now();
          // T-42: derive the request's target site so a newly-appended
          // duplicate carries `kindoo_site_id`. Stake-scope ⇒ home;
          // ward-scope ⇒ ward's `kindoo_site_id` (home wards → null).
          // Uniform missing-ward skip-with-warning policy: an unknown
          // ward leaves the new duplicate's `kindoo_site_id` unset so
          // the downstream ward-fallback resolver handles classification
          // — same shape as the migration's duplicate-side skip.
          let requestSiteId: string | null | undefined;
          if (cur.scope === 'stake') {
            requestSiteId = null;
          } else {
            const wardDoc = wards.find((w) => w.ward_code === cur.scope);
            if (wardDoc) {
              requestSiteId = wardDoc.kindoo_site_id ?? null;
            } else {
              requestSiteId = undefined; // leave the new duplicate's field unset
              logger.warn(
                `markRequestComplete: ward '${cur.scope}' not found while merging into seat for ${cur.member_canonical}; leaving new duplicate's kindoo_site_id unset (ward-fallback handles classification at read time)`,
              );
            }
          }
          const plan = planAddMerge({
            existingSeat,
            request: cur,
            detectedAt,
            requestSiteId,
          });
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
          // Merge paths never change the primary scope, so per-pool
          // counts are unchanged. We still recompute to keep the code
          // path uniform and to surface any pre-existing over-cap state
          // captured by the importer.
          const merged: Seat = { ...existingSeat, ...(plan.update as Partial<Seat>) };
          postWriteSeats = allSeats.map((s) =>
            s.member_canonical === existingSeat.member_canonical ? merged : s,
          );
        }
      } else if (cur.type === 'remove') {
        const seatTarget = cur.seat_member_canonical ?? cur.member_canonical;
        const seatRef = seatsRef.doc(seatTarget);
        const seatSnap = await tx.get(seatRef);
        seatExists = seatSnap.exists;
      } else if (
        cur.type === 'edit_auto' ||
        cur.type === 'edit_manual' ||
        cur.type === 'edit_temp'
      ) {
        // Stake auto seats are non-editable — Church-granted access to
        // all stake buildings, nothing to remove. Three layers of
        // defense (UI hides Edit, rules reject edit_auto create at
        // scope='stake', and this callable check). Policy 1.
        if (cur.type === 'edit_auto' && cur.scope === 'stake') {
          throw new HttpsError(
            'permission-denied',
            'edit_auto requests with scope=stake are not allowed (stake auto seats are not editable)',
          );
        }

        const seatRef = seatsRef.doc(cur.member_canonical);
        const seatSnap = await tx.get(seatRef);
        if (!seatSnap.exists) {
          throw new HttpsError(
            'failed-precondition',
            `no seat found for member ${cur.member_canonical} — cannot ${cur.type}`,
          );
        }
        const existingSeat = seatSnap.data() as Seat;
        const targetType: Seat['type'] =
          cur.type === 'edit_auto' ? 'auto' : cur.type === 'edit_manual' ? 'manual' : 'temp';

        const fields: {
          building_names: string[];
          reason?: string;
          start_date?: string;
          end_date?: string;
        } = { building_names: cur.building_names ?? [] };
        if (cur.type === 'edit_manual' || cur.type === 'edit_temp') {
          fields.reason = cur.reason ?? '';
        }
        if (cur.type === 'edit_temp') {
          if (cur.start_date) fields.start_date = cur.start_date;
          if (cur.end_date) fields.end_date = cur.end_date;
        }

        const plan = planEditSeat(existingSeat, targetType, cur.scope, fields);
        if (plan === null) {
          throw new HttpsError(
            'failed-precondition',
            `no editable slot found for (scope=${cur.scope}, type=${targetType}) on member ${cur.member_canonical}`,
          );
        }

        const seatUpdate: Record<string, unknown> = {
          ...plan.update,
          last_modified_at: FieldValue.serverTimestamp(),
          last_modified_by: actor,
          lastActor: actor,
        };
        mergeSeatRef = seatRef;
        mergeUpdate = seatUpdate;

        // Edits never change scope/type, so per-pool counts are
        // unchanged. We deliberately leave `postWriteSeats` null so the
        // over-cap recompute (and the `stake.last_over_caps_json` write)
        // is skipped — same responsibility split as the remove path.
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

      // Recompute over-caps from the post-write seat set. Only the
      // add-type paths populate `postWriteSeats`; remove leaves it null
      // (the seat-delete trigger owns its own recompute). We write
      // `last_over_caps_json` unconditionally on add-type — including
      // the empty-array case — so `notifyOnOverCap` sees a true
      // transition rather than a stale snapshot.
      let computedOverCaps: OverCapEntry[] = [];
      if (postWriteSeats !== null) {
        computedOverCaps = computeOverCaps({
          seats: postWriteSeats,
          wards,
          stakeSeatCap,
        });
      }

      if (newSeatRef && seatBody) {
        tx.set(newSeatRef, seatBody);
      }
      if (mergeSeatRef && mergeUpdate) {
        tx.update(mergeSeatRef, mergeUpdate);
      }
      if (postWriteSeats !== null) {
        tx.set(
          stakeRef,
          {
            last_over_caps_json: computedOverCaps,
            last_modified_at: FieldValue.serverTimestamp(),
            last_modified_by: actor,
            lastActor: actor,
          },
          { merge: true },
        );
      }
      tx.update(reqRef, update);

      return computedOverCaps;
    });

    return { ok: true, over_caps: overCaps };
  },
);
