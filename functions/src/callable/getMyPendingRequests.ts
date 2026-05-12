// Chrome extension bridge: returns the FIFO list of pending requests
// for a stake to a caller who is a Kindoo Manager of that stake. The
// extension's side-panel surfaces this list while the manager works the
// Kindoo UI in the host tab.
//
// Auth: same authority check as `runImportNow` — read the
// `kindooManagers/{canonical}` doc directly. Custom claims can be ~1h
// stale on idle sessions per `firebase-schema.md` §2, so the doc is
// the source of truth at call time.
//
// Output ordering: oldest-first by `requested_at` ASC (the SPA Queue
// page uses the same predicate via the `(status ASC, requested_at ASC)`
// composite index; the Admin SDK path bypasses rules but still uses
// the same index when present).

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { canonicalEmail } from '@kindoo/shared';
import type {
  AccessRequest,
  GetMyPendingRequestsInput,
  GetMyPendingRequestsOutput,
  KindooManager,
} from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';

export const getMyPendingRequests = onCall(
  { serviceAccount: APP_SA },
  async (req): Promise<GetMyPendingRequestsOutput> => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'sign in required');
    }
    const data = (req.data ?? {}) as Partial<GetMyPendingRequestsInput>;
    const stakeId = data.stakeId;
    if (!stakeId || typeof stakeId !== 'string') {
      throw new HttpsError('invalid-argument', 'stakeId required');
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

    const snap = await db
      .collection(`stakes/${stakeId}/requests`)
      .where('status', '==', 'pending')
      .orderBy('requested_at', 'asc')
      .get();

    const requests = snap.docs.map((d) => d.data() as AccessRequest);
    return { requests };
  },
);
