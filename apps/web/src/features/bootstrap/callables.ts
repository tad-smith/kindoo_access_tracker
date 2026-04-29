// Cloud Function callable stubs invoked from the bootstrap wizard +
// the manager Import page. Phase 7 wires the UI; Phase 8 (backend
// engineer) ships the actual function implementations:
//   - `installScheduledJobs` — bootstrap-wizard "Complete Setup" calls
//     this to install Cloud Scheduler jobs for the importer + expiry
//     triggers; idempotent (Cloud Scheduler jobs are platform-managed).
//   - `runImportNow` — manager-invoked one-shot importer run. Returns
//     a summary of inserted/deleted/warnings.
//
// Both wrappers `httpsCallable` the function and surface a friendly
// error message when the function isn't deployed yet ("not-found"). The
// caller (BootstrapWizardPage / ImportPage) decides whether to surface
// that as a warn toast vs error toast.

import { getFunctions, httpsCallable, type HttpsCallableResult } from 'firebase/functions';
import { firebaseApp } from '../../lib/firebase';

const functions = getFunctions(firebaseApp);

export interface InstallScheduledJobsResult {
  ok: boolean;
}

/**
 * Invoke `installScheduledJobs`. Phase 8 ships the function; Phase 7
 * users hit a "not-found" path that bubbles a friendly error to the
 * caller (which surfaces a warn toast — setup completion is not rolled
 * back on this failure since the function is best-effort).
 */
export async function invokeInstallScheduledJobs(): Promise<InstallScheduledJobsResult> {
  const fn = httpsCallable<unknown, InstallScheduledJobsResult>(functions, 'installScheduledJobs');
  try {
    const res: HttpsCallableResult<InstallScheduledJobsResult> = await fn();
    return res.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not[- ]?found/i.test(message)) {
      throw new Error('Scheduled-jobs installer not yet enabled (deploy Phase 8 backend).');
    }
    throw err;
  }
}

export interface RunImportNowResult {
  ok: boolean;
  summary?: string;
  inserted?: number;
  deleted?: number;
  warnings?: string[];
}

/**
 * Invoke `runImportNow` for the current stake. The Phase 8 backend
 * passes the stake id; v1 single-stake hardcodes `csnorth` (per F15)
 * and the function reads `STAKE_ID` from the request payload.
 */
export async function invokeRunImportNow(stakeId: string): Promise<RunImportNowResult> {
  const fn = httpsCallable<{ stakeId: string }, RunImportNowResult>(functions, 'runImportNow');
  try {
    const res: HttpsCallableResult<RunImportNowResult> = await fn({ stakeId });
    return res.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not[- ]?found/i.test(message)) {
      throw new Error('Import not yet enabled — Phase 8 ships this.');
    }
    throw err;
  }
}
