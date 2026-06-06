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
import { useMutation } from '@tanstack/react-query';
import type { CreateStakeInput, CreateStakeResult, Stake } from '@kindoo/shared';
import type { Query } from 'firebase/firestore';
import { useFirestoreCollection } from '../../lib/data';
import { db, functions } from '../../lib/firebase';
import { stakesCol } from '../../lib/docs';

/**
 * A `Stake` doc body plus its Firestore doc id. Stake identity is the
 * doc id (the slug); the persisted body carries no id field. This is a
 * read-layer augmentation — `useStakes()` injects `id` from `doc.id`
 * via `useFirestoreCollection`'s `idField` — NOT part of the zod schema.
 */
export type StakeWithId = Stake & { id: string };

/**
 * Subscribe to every stake parent doc, each augmented with its doc id
 * as `id`. Restricted by the `isPlatformSuperadmin()` clause on the
 * `stakes/{stakeId}` rule — non-superadmin reads of this query are
 * denied. Callers must already be inside the Superadmin gate
 * (`useRequireRole('platformSuperadmin')` or the equivalent
 * render-level check).
 */
export function useStakes() {
  // The collection ref is typed `Query<Stake>`; the read layer augments
  // each doc with `id` (= doc.id), so the result type is `StakeWithId`.
  const q = useMemo(() => stakesCol(db) as unknown as Query<StakeWithId>, []);
  return useFirestoreCollection<StakeWithId>(q, { idField: 'id' });
}

/**
 * Invoke the `createStake` callable. Returns the typed envelope
 * (`{success:true, stakeId}` or `{success:false, error}`); shape /
 * auth `HttpsError`s bubble as thrown errors. The Create Stake form
 * inspects `success` and either resets the form or maps the error
 * code onto the right inline field error.
 *
 * No `onSuccess` invalidate: per D11, the live `useStakes()`
 * subscription is driven by `onSnapshot` against a never-resolving
 * `queryFn`, so `invalidateQueries` is a no-op against it. The new
 * stake row arrives via the snapshot listener on its own; the form
 * owns the success toast + reset off the mutation hook directly.
 */
export function useCreateStake() {
  return useMutation<CreateStakeResult, Error, CreateStakeInput>({
    mutationFn: async (input) => {
      const fn = httpsCallable<CreateStakeInput, CreateStakeResult>(functions, 'createStake');
      const res = await fn(input);
      return res.data;
    },
  });
}

/** Input to a stake-fix run: which callable, against which stake. */
export interface ApplyStakeFixInput {
  /** The callable to invoke (from a `StakeFix.callable`). */
  callable: string;
  /** The stake the fix runs against. */
  stakeId: string;
}

/**
 * Invoke an arbitrary superadmin-gated stake-fix callable as
 * `fn({ stakeId })`. The result is kept FIX-AGNOSTIC — `Record<string,
 * unknown>` — so the Result dialog can render any fix's output
 * generically and adding a new fix needs no hook change. Auth /
 * permission `HttpsError`s bubble as thrown errors for the dialog's
 * error branch.
 */
export function useApplyStakeFix() {
  return useMutation<Record<string, unknown>, Error, ApplyStakeFixInput>({
    mutationFn: async ({ callable, stakeId }) => {
      const fn = httpsCallable<{ stakeId: string }, Record<string, unknown>>(functions, callable);
      const res = await fn({ stakeId });
      return res.data;
    },
  });
}
