// Cloud Function callable wrappers used by the bootstrap wizard.
//   - `installScheduledJobs` — bootstrap-wizard "Complete Setup" calls
//     this to install Cloud Scheduler jobs for the expiry trigger;
//     idempotent (Cloud Scheduler jobs are platform-managed).
//
// The wrapper `httpsCallable`s the function and surfaces a friendly
// error message when the function isn't deployed yet ("not-found").

import { httpsCallable, type HttpsCallableResult } from 'firebase/functions';
import { functions } from '../../lib/firebase';

export interface InstallScheduledJobsResult {
  ok: boolean;
}

/**
 * Invoke `installScheduledJobs` for the named stake. The callable
 * verifies the caller is an active manager of the stake and that the
 * stake's schedule fields are populated. If the callable is
 * unavailable we bubble a friendly error (which surfaces a warn
 * toast — setup completion is not rolled back since the function is
 * best-effort).
 */
export async function invokeInstallScheduledJobs(
  stakeId: string,
): Promise<InstallScheduledJobsResult> {
  const fn = httpsCallable<{ stakeId: string }, InstallScheduledJobsResult>(
    functions,
    'installScheduledJobs',
  );
  try {
    const res: HttpsCallableResult<InstallScheduledJobsResult> = await fn({ stakeId });
    return res.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not[- ]?found/i.test(message)) {
      throw new Error('Scheduled jobs are not available in this environment yet.');
    }
    throw err;
  }
}
