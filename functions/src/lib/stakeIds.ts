// Runtime-derived list of every stake the platform serves.
//
// Reads `stakes/` doc IDs via `listDocuments()` and caches the result
// in module scope for the lifetime of the Cloud Function instance. The
// only consumer is `seedClaimsFromRoleData`, fired by
// `onAuthUserCreate` on first sign-in (rare: ≤ ~250 events/lifetime
// for v1 stake size), so the cache trades freshness for one
// `listDocuments` call per cold start.
//
// Cache staleness window: when a new stake is added to Firestore,
// already-warm function instances keep returning the pre-existing
// list until they recycle (~few hours under typical traffic). A user
// signing in for the new stake during that window may not get their
// claims seeded; the operator can recover by touching the user's
// `kindooManagers` / `access` doc to fire the per-stake sync triggers
// (which extract `stakeId` from the doc path and are unaffected by
// this cache). Acceptable given the expected growth pattern of
// rare additions.
//
// `listDocuments()` returns refs (not full snapshots) and includes
// docs that exist only as ancestors of subcollection writes — for
// the `stakes/` root collection that is exactly the set we want
// (every stake doc is explicitly created).

import type { Firestore } from 'firebase-admin/firestore';

let cachedStakeIds: string[] | null = null;

/**
 * Return every stake ID present in the `stakes/` collection. Cached in
 * module scope after the first call; subsequent calls in the same
 * function instance reuse the cached result.
 *
 * Exported separately from the seed-claims path so tests can inject a
 * Firestore handle and so callers don't have to thread `getDb()`
 * themselves when they already have a handle.
 */
export async function getStakeIds(db: Firestore): Promise<string[]> {
  if (cachedStakeIds) return cachedStakeIds;
  const refs = await db.collection('stakes').listDocuments();
  cachedStakeIds = refs.map((ref) => ref.id);
  return cachedStakeIds;
}

/**
 * Test-only: drop the cached list so the next call rereads. Production
 * code has no reason to call this — instance recycling handles it.
 */
export function resetStakeIdsCache(): void {
  cachedStakeIds = null;
}
