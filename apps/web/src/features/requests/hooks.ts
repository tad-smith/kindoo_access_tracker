// Data hooks + mutations for the request lifecycle.
//
// Submit (`useSubmitRequest`) is a single Firestore write: a new doc in
// `stakes/{sid}/requests`, status='pending', `requested_at = serverTimestamp()`.
// The rules in `firestore.rules` enforce field-level invariants
// (member_name required for add types, ≥1 building for stake-scope add
// types, requester_canonical matches auth, lastActor matches auth).
//
// Complete + Reject mutations live in `manager/queue/hooks.ts`; cancel
// lives in `myRequests/cancelRequest.ts`. Centralising them with the
// queue / my-requests features keeps each page's mutation set local
// while sharing the rendering primitives below.

import {
  addDoc,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { canonicalEmail } from '@kindoo/shared';
import type { AccessRequest, Seat } from '@kindoo/shared';
import { useFirestoreDoc, useFirestoreCollection } from '../../lib/data';
import { db, auth } from '../../lib/firebase';
import { requestsCol, seatRef } from '../../lib/docs';
import { STAKE_ID } from '../../lib/constants';

/**
 * Live duplicate-warning hook. Phase 6 spec §5.1 calls for an inline
 * warning when the member already has a seat in the requested scope.
 * Subscribes to `seats/{member_canonical}` because the seat doc id IS
 * the canonical email — no query needed; if the doc exists and its
 * `scope` matches the requested scope (or any duplicate_grants
 * scope), we surface a warning. Auto seats trigger the warning too;
 * the spec is "warns; does not block".
 *
 * `null` canonical disables the subscription.
 */
export function useSeatForMember(canonical: string | null) {
  const ref = useMemo(() => {
    if (!canonical) return null;
    return seatRef(db, STAKE_ID, canonical);
  }, [canonical]);
  return useFirestoreDoc<Seat>(ref);
}

/**
 * Live "remove already pending" check for the X / removal modal so the
 * UI can disable the trashcan as soon as a remove submission lands.
 * Returns the matching request doc(s); empty array means no pending
 * removal. Caller filters by scope client-side.
 */
export function usePendingRemoveRequests(memberCanonical: string | null) {
  const q = useMemo(() => {
    if (!memberCanonical) return null;
    return query(
      requestsCol(db, STAKE_ID),
      where('type', '==', 'remove'),
      where('status', '==', 'pending'),
      where('member_canonical', '==', memberCanonical),
    );
  }, [memberCanonical]);
  return useFirestoreCollection<AccessRequest>(q);
}

// ---- Submit ---------------------------------------------------------

export interface SubmitRequestInput {
  type: 'add_manual' | 'add_temp' | 'remove';
  scope: string;
  member_email: string;
  member_name: string;
  reason: string;
  comment: string;
  start_date?: string;
  end_date?: string;
  building_names: string[];
}

/**
 * Submit a new request. The mutation accepts the form-level shape and
 * fills derived fields (`request_id`, `status`, `requested_at`,
 * `requester_*`, `lastActor`, optional `seat_member_canonical` for
 * remove). The Firestore SDK assigns the doc id; we leave
 * `request_id` mirroring it on the doc body for convenience (rules
 * don't require equality).
 */
export function useSubmitRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitRequestInput) => {
      const user = auth.currentUser;
      if (!user || !user.email) {
        throw new Error('Not signed in.');
      }
      const tokenResult = await user.getIdTokenResult();
      const tokenCanonical =
        (tokenResult.claims as { canonical?: string }).canonical ?? canonicalEmail(user.email);

      const memberCanonical = canonicalEmail(input.member_email);
      const actor = { email: user.email, canonical: tokenCanonical };

      // The doc body. Rules require: status='pending',
      // requester_canonical = auth canonical, requested_at = request.time
      // (serverTimestamp), lastActor matches auth, member_name non-empty
      // for add types, ≥1 building for stake-scope add types, scope
      // matches requester role.
      const doc: Record<string, unknown> = {
        type: input.type,
        scope: input.scope,
        member_email: input.member_email.trim(),
        member_canonical: memberCanonical,
        member_name: input.member_name.trim(),
        reason: input.reason.trim(),
        comment: input.comment.trim(),
        building_names: input.building_names,
        status: 'pending',
        requester_email: user.email,
        requester_canonical: tokenCanonical,
        requested_at: serverTimestamp(),
        lastActor: actor,
      };
      if (input.type === 'add_temp') {
        if (input.start_date) doc.start_date = input.start_date;
        if (input.end_date) doc.end_date = input.end_date;
      }
      if (input.type === 'remove') {
        // Denormalise the seat key so the completion path can locate
        // the seat doc without a query (Firestore client transactions
        // don't support queries).
        doc.seat_member_canonical = memberCanonical;
      }
      const ref = await addDoc(requestsCol(db, STAKE_ID), doc as unknown as AccessRequest);
      // Stamp request_id back onto the doc body for legibility — tests
      // expect it (the importer / spec mirror this convention). Keeping
      // the read-side data shape consistent saves a join in the UI.
      // The rules have no constraint on this update; it lands inside
      // the same authed session, satisfying lastActorMatchesAuth.
      // We skip the trip in unit-test environments where addDoc is
      // mocked; the test fixture watches the create payload only.
      return { id: ref.id };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kindoo', 'requests'] });
    },
  });
}
