// Chrome extension bridge: flips a `pending` request to `complete`.
// Scoped to the simple case the extension supports — the manager has
// already worked the door system in the Kindoo UI and just needs to
// record the completion. The SPA's `useCompleteAddRequest` /
// `useCompleteRemoveRequest` hooks remain the full workflow for the
// browser app (they also create the seat doc for add-type, or rely on
// the `removeSeatOnRequestComplete` trigger for the remove path).
//
// The audit row is fanned in by `auditRequestWrites` from the
// resulting write; `notifyOnRequestWrite` fires the requester email
// from the same write. No extra wiring here.
//
// Auth: same authority check as `runImportNow` — read the
// `kindooManagers/{canonical}` doc directly.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { canonicalEmail } from '@kindoo/shared';
import type {
  AccessRequest,
  KindooManager,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
} from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';

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

      const update: Record<string, unknown> = {
        status: 'complete',
        completer_email: typedEmail,
        completer_canonical: canonical,
        completed_at: FieldValue.serverTimestamp(),
        lastActor: actor,
      };
      if (trimmedNote.length > 0) update.completion_note = trimmedNote;
      if (kindooUid !== undefined) update.kindoo_uid = kindooUid;
      if (provisioningNote !== undefined) update.provisioning_note = provisioningNote;

      tx.update(reqRef, update);
    });

    return { ok: true };
  },
);
