// Chrome extension bridge: flips a `pending` request to `complete`.
// Mirrors the SPA's `useCompleteAddRequest` / `useCompleteRemoveRequest`
// hooks so the callable produces the same Firestore state. The SPA
// hooks remain the path for some flows (reject, cancel) and for any
// flow that needs manager-supplied building overrides.
//
// Behaviour by request type:
//   - `add_manual` / `add_temp`: read the seat doc inside the
//     transaction. If absent → create it from the request body. If
//     present → fail with `failed-precondition` (mirrors the SPA's
//     "already has a seat" guard; the SPA tells the manager to
//     reconcile via All Seats first). Both the seat write and the
//     request flip land in the same transaction; the `seats.create`
//     rule's `tiedToRequestCompletion` invariant is satisfied because
//     the request flip happens in the same write.
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
  KindooManager,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
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

      // Add-type: create the seat in the same transaction.
      // Remove-type: pre-read the seat to know whether to stamp the
      // R-1 system note; the `removeSeatOnRequestComplete` trigger
      // does the Admin-SDK delete.
      let seatExists = false;
      let seatBody: Record<string, unknown> | null = null;
      let newSeatRef: FirebaseFirestore.DocumentReference | null = null;
      if (cur.type === 'add_manual' || cur.type === 'add_temp') {
        const seatTarget = cur.member_canonical;
        newSeatRef = db.doc(`stakes/${stakeId}/seats/${seatTarget}`);
        const seatSnap = await tx.get(newSeatRef);
        if (seatSnap.exists) {
          // Mirrors the SPA: the rules' seat-create predicate would
          // reject a re-create anyway; surface a friendlier message.
          // Manager must reconcile via All Seats before re-trying.
          throw new HttpsError(
            'failed-precondition',
            `${cur.member_email} already has a seat. Reconcile via All Seats first.`,
          );
        }
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
        seatBody = body;
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
      tx.update(reqRef, update);
    });

    return { ok: true };
  },
);
