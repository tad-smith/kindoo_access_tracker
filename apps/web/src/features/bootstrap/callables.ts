// Cloud Function callable wrappers used by the bootstrap wizard and
// the manager Import page:
//   - `installScheduledJobs` — bootstrap-wizard "Complete Setup" calls
//     this to install Cloud Scheduler jobs for the importer + expiry
//     triggers; idempotent (Cloud Scheduler jobs are platform-managed).
//   - `runImportNow` — manager-invoked one-shot importer run. Returns
//     the typed `ImportSummary` from `@kindoo/shared`.
//
// Both wrappers `httpsCallable` the function and surface a friendly
// error message when the function isn't deployed yet ("not-found").

import { httpsCallable, type HttpsCallableResult } from 'firebase/functions';
import type { ImportSummary } from '@kindoo/shared';
import { functions } from '../../lib/firebase';

export interface InstallScheduledJobsResult {
  ok: boolean;
}

/**
 * Invoke `installScheduledJobs` for the named stake. The callable
 * verifies the caller is an active manager of the stake and that the
 * stake's schedule fields are populated. Phase 7 users hit a "not-found"
 * path that bubbles a friendly error (which surfaces a warn toast —
 * setup completion is not rolled back since the function is
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

/**
 * Invoke `runImportNow` for the named stake. Returns the full
 * `ImportSummary` (insert / update / delete counts, duration, errors,
 * over-cap pools) — the SPA renders this inline on the Import page.
 */
export async function invokeRunImportNow(stakeId: string): Promise<ImportSummary> {
  const fn = httpsCallable<{ stakeId: string }, ImportSummary>(functions, 'runImportNow');
  try {
    const res: HttpsCallableResult<ImportSummary> = await fn({ stakeId });
    return res.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not[- ]?found/i.test(message)) {
      throw new Error('Import is not available in this environment yet.');
    }
    throw err;
  }
}
