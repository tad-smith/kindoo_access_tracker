// Superadmin-facing data hooks. Covers the top-level `stakes/`
// collection — readable by platform superadmins via the
// `isPlatformSuperadmin()` clause on the `stakes/{stakeId}` rule
// (12.2 backend lane). Page-scope reads only; cross-stake aggregate
// reads aren't part of 12.2.
//
// Per architecture D11 the actual subscription lives in
// `useFirestoreCollection`; this module is a thin per-feature wrapper.

import { useMemo } from 'react';
import type { Stake } from '@kindoo/shared';
import { useFirestoreCollection } from '../../lib/data';
import { db } from '../../lib/firebase';
import { stakesCol } from '../../lib/docs';

/**
 * Subscribe to every stake parent doc. Restricted by the
 * `isPlatformSuperadmin()` clause on the `stakes/{stakeId}` rule —
 * non-superadmin reads of this query are denied. Callers must already
 * be inside the Superadmin gate (`useRequireRole('platformSuperadmin')`
 * or the equivalent render-level check).
 */
export function useStakes() {
  const q = useMemo(() => stakesCol(db), []);
  return useFirestoreCollection<Stake>(q);
}
