// Manager-invoked "Import Now" callable. Verifies the caller is a
// manager of the named stake by reading their kindooManagers doc with
// the Admin SDK (rather than trusting a custom claim, since claims
// can be ~1h stale on idle sessions per `firebase-schema.md` §2).

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { canonicalEmail } from '@kindoo/shared';
import type { ImportSummary, KindooManager } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { runImporterForStake } from '../services/Importer.js';

export const runImportNow = onCall(
  {
    timeoutSeconds: 540,
    memory: '512MiB',
    serviceAccount: APP_SA.value(),
  },
  async (req): Promise<ImportSummary> => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'sign in required');
    }
    const data = (req.data ?? {}) as { stakeId?: string };
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

    return await runImporterForStake({
      stakeId,
      triggeredBy: typedEmail,
    });
  },
);
