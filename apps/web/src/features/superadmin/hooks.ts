// Superadmin-facing data hooks. Covers the top-level `stakes/`
// collection — readable by platform superadmins via the
// `isPlatformSuperadmin()` clause on the `stakes/{stakeId}` rule
// (12.2 backend lane). Page-scope reads only; cross-stake aggregate
// reads aren't part of 12.2.
//
// Per architecture D11 the actual subscription lives in
// `useFirestoreCollection`; this module is a thin per-feature wrapper.

import { useMemo } from 'react';
import { httpsCallable } from 'firebase/functions';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateStakeInput, CreateStakeResult, Stake } from '@kindoo/shared';
import { useFirestoreCollection } from '../../lib/data';
import { db, functions } from '../../lib/firebase';
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

/**
 * Invoke the `createStake` callable. Returns the typed envelope
 * (`{success:true, stakeId}` or `{success:false, error}`); shape /
 * auth `HttpsError`s bubble as thrown errors. The Create Stake form
 * inspects `success` and either resets + invalidates or maps the
 * error code onto the right inline field error.
 *
 * On `success` we fire-and-forget invalidate every TanStack Query
 * entry so the live stakes-collection subscription re-snapshots with
 * the new row. (Live hooks have a never-resolving `queryFn`, so we
 * don't await — awaiting would hang.)
 */
export function useCreateStake() {
  const qc = useQueryClient();
  return useMutation<CreateStakeResult, Error, CreateStakeInput>({
    mutationFn: async (input) => {
      const fn = httpsCallable<CreateStakeInput, CreateStakeResult>(functions, 'createStake');
      const res = await fn(input);
      return res.data;
    },
    onSuccess: (result) => {
      if (result.success) {
        void qc.invalidateQueries();
      }
    },
  });
}
