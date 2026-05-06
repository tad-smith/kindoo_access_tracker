// Cancel-pending-request mutation. The single write path Phase 5 ships
// (per `firebase-migration.md` §Phase 5 plan).
//
// The Firestore rules at `firestore/firestore.rules` allow this update
// when:
//   - `resource.data.status == 'pending'`
//   - the new status is `'cancelled'`
//   - `lastActor` matches the auth token's email + canonical
//   - `resource.data.requester_canonical == authedCanonical()`
//
// We wrap the mutation in TanStack Query so callers (the Cancel
// button) get loading + error state alongside the live snapshot
// re-render that the listener fires after the write.

import { updateDoc } from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { db } from '../../lib/firebase';
import { requestRef } from '../../lib/docs';
import { STAKE_ID } from '../../lib/constants';
import { auth } from '../../lib/firebase';

export interface CancelRequestInput {
  requestId: string;
}

export function useCancelRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ requestId }: CancelRequestInput) => {
      const user = auth.currentUser;
      if (!user || !user.email) {
        throw new Error('Not signed in.');
      }
      // The auth token's `canonical` claim is the source-of-truth;
      // mirror it on the write so the rules' lastActorMatchesAuth check
      // passes. We refresh the token first so a stale canonical from a
      // 1-hour-old token is replaced before the write.
      const tokenResult = await user.getIdTokenResult();
      const canonical = (tokenResult.claims as { canonical?: string }).canonical ?? user.email;

      await updateDoc(requestRef(db, STAKE_ID, requestId), {
        status: 'cancelled',
        lastActor: { email: user.email, canonical },
      });
    },
    onSuccess: () => {
      // Fire-and-forget. The DIY live hooks at `apps/web/src/lib/data/`
      // key under `__kindoo_firestore__` so this `['kindoo', 'requests']`
      // invalidate cannot match a never-resolving placeholder queryFn,
      // but `void` keeps the pattern uniform with the rest of the
      // codebase and forecloses the hang if a future engineer registers
      // a non-DIY query under this prefix.
      void queryClient.invalidateQueries({ queryKey: ['kindoo', 'requests'] });
    },
  });
}
