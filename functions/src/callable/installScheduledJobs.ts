// Bootstrap-wizard "Complete Setup" hook. The single-loop scheduler
// pattern means there are no per-stake jobs to install — the
// `runImporter` / `runExpiry` / `reconcileAuditGaps` Cloud Scheduler
// jobs are platform-managed and exist after the first deploy. This
// callable is therefore idempotent: it verifies the caller is a
// manager of the stake and confirms the stakes' schedule fields are
// set (which the wizard guarantees), but performs no creates.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { canonicalEmail } from '@kindoo/shared';
import type { KindooManager, Stake } from '@kindoo/shared';
import { getDb } from '../lib/admin.js';

export const installScheduledJobs = onCall(async (req): Promise<{ ok: true }> => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'sign in required');
  const data = (req.data ?? {}) as { stakeId?: string };
  const stakeId = data.stakeId;
  if (!stakeId || typeof stakeId !== 'string') {
    throw new HttpsError('invalid-argument', 'stakeId required');
  }

  const typedEmail = req.auth.token.email;
  if (!typedEmail) throw new HttpsError('failed-precondition', 'auth token has no email');
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

  const stakeSnap = await db.doc(`stakes/${stakeId}`).get();
  if (!stakeSnap.exists) throw new HttpsError('failed-precondition', 'stake not found');
  const stake = stakeSnap.data() as Stake;
  // Defensive — wizard validation already caught these. Surfaces here
  // so the wizard can show a clean error message if a config knob is
  // mis-stamped.
  if (typeof stake.import_hour !== 'number' || stake.import_hour < 0 || stake.import_hour > 23) {
    throw new HttpsError('failed-precondition', 'stake.import_hour invalid');
  }
  if (typeof stake.expiry_hour !== 'number' || stake.expiry_hour < 0 || stake.expiry_hour > 23) {
    throw new HttpsError('failed-precondition', 'stake.expiry_hour invalid');
  }
  if (!stake.import_day) {
    throw new HttpsError('failed-precondition', 'stake.import_day invalid');
  }
  if (!stake.timezone) {
    throw new HttpsError('failed-precondition', 'stake.timezone invalid');
  }
  return { ok: true };
});
