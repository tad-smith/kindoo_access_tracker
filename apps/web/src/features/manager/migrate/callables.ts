// One-shot admin migration: callable wrapper around
// `backfillKindooSiteId`. T-42 Phase A's migration step ran once via
// this thin SPA surface (the route at `/admin/migrate`); kept here for
// idempotent re-runs on demand.
//
// The callable is gated server-side on caller-is-active-manager — see
// `functions/src/callable/backfillKindooSiteId.ts`. The route adds a
// client-side manager-role gate via `useRequireRole`.

import { httpsCallable, type HttpsCallableResult } from 'firebase/functions';
import { functions } from '../../../lib/firebase';

export interface BackfillKindooSiteIdResult {
  ok: true;
  seats_total: number;
  seats_updated: number;
  primary_kindoo_site_id_skipped: number;
  duplicates_updated: number;
  duplicates_skipped_missing_ward: number;
  warnings: string[];
}

/**
 * Invoke `backfillKindooSiteId` for the named stake. Returns the
 * counters payload the function emits. Surfaces a friendly error when
 * the callable isn't deployed yet (matches the pattern in
 * `features/bootstrap/callables.ts`).
 */
export async function invokeBackfillKindooSiteId(
  stakeId: string,
): Promise<BackfillKindooSiteIdResult> {
  const fn = httpsCallable<{ stakeId: string }, BackfillKindooSiteIdResult>(
    functions,
    'backfillKindooSiteId',
  );
  try {
    const res: HttpsCallableResult<BackfillKindooSiteIdResult> = await fn({ stakeId });
    return res.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not[- ]?found/i.test(message)) {
      throw new Error('Migration callable is not available in this environment.');
    }
    throw err;
  }
}
