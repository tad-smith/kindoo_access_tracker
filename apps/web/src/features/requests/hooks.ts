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

import { doc, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
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
 * removal.
 *
 * The query MUST filter by scope as well as member, because the
 * requests rule's read predicate keys off scope (a bishopric of CO
 * may only list requests where `scope='CO'` — Firestore rejects
 * queries whose filter set doesn't statically prove the result set
 * is allowable). Callers pass both the seat's `member_canonical`
 * and `scope`; the badge fires when a pending remove exists for the
 * exact (scope, member) pair.
 */
export function usePendingRemoveRequests(memberCanonical: string | null, scope: string | null) {
  const q = useMemo(() => {
    if (!memberCanonical || !scope) return null;
    return query(
      requestsCol(db, STAKE_ID),
      where('scope', '==', scope),
      where('type', '==', 'remove'),
      where('status', '==', 'pending'),
      where('member_canonical', '==', memberCanonical),
    );
  }, [memberCanonical, scope]);
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
  /** Defaults to false on the wire; missing → false on read. */
  urgent?: boolean;
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
      // Force-refresh the ID token so a freshly-minted claim (e.g.
      // operator just added themselves to kindooManagers / access)
      // lands on this request. The default cached token can lag the
      // server-side `setCustomUserClaims` + `revokeRefreshTokens` by
      // up to an hour; rules then deny because
      // `request.auth.token.canonical` / `.stakes[sid].stake` are
      // absent or stale.
      const tokenResult = await user.getIdTokenResult(true);
      const claims = tokenResult.claims as {
        canonical?: string;
        email?: string;
        stakes?: Record<string, { manager?: boolean; stake?: boolean; wards?: string[] }>;
      };
      const tokenCanonical = claims.canonical ?? canonicalEmail(user.email);

      const memberCanonical = canonicalEmail(input.member_email);
      const actor = { email: user.email, canonical: tokenCanonical };

      // Pre-allocate the doc id so we can stamp it on the body in one
      // create call. `addDoc` would split the create + update across
      // two writes, but the second write would have to flip status off
      // pending to satisfy the rules' update rule — which would defeat
      // the purpose. Pre-allocating the ref keeps the body internally
      // consistent in a single rules-allowed create.
      const ref = doc(requestsCol(db, STAKE_ID));

      // The doc body. Rules require: status='pending',
      // requester_canonical = auth canonical, requested_at = request.time
      // (serverTimestamp), lastActor matches auth, member_name non-empty
      // for add types, ≥1 building for stake-scope add types, scope
      // matches requester role.
      const body: Record<string, unknown> = {
        request_id: ref.id,
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
        if (input.start_date) body.start_date = input.start_date;
        if (input.end_date) body.end_date = input.end_date;
      }
      if (input.type === 'remove') {
        // Denormalise the seat key so the completion path can locate
        // the seat doc without a query (Firestore client transactions
        // don't support queries).
        body.seat_member_canonical = memberCanonical;
      }
      if (input.urgent === true) {
        // Stamp only when truthy; missing field reads as false. Keeps
        // the on-disk doc lean for the common non-urgent path.
        body.urgent = true;
      }
      // Diagnostic log: pasted into staging by the operator to surface
      // which rule predicate denied a permission-error submit. Pairs
      // the auth-token shape against the doc body so the rule check
      // can be reproduced byte-by-byte. Quiet in tests (NODE_ENV).
      // Remove or gate behind a flag once staging is happy.
      if (typeof console !== 'undefined' && process.env['NODE_ENV'] !== 'test') {
        console.log('[submit-request] payload', {
          docPath: `stakes/${STAKE_ID}/requests/${ref.id}`,
          body,
          authEmail: user.email,
          tokenEmail: claims.email,
          tokenCanonical: claims.canonical,
          tokenStakes: claims.stakes,
        });
      }
      try {
        await setDoc(ref, body as unknown as AccessRequest);
      } catch (err) {
        if (typeof console !== 'undefined' && process.env['NODE_ENV'] !== 'test') {
          console.error('[submit-request] denied', {
            docPath: `stakes/${STAKE_ID}/requests/${ref.id}`,
            scope: input.scope,
            type: input.type,
            tokenCanonical: claims.canonical,
            stakes: claims.stakes,
            err,
          });
        }
        throw err;
      }
      return { id: ref.id };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kindoo', 'requests'] });
    },
  });
}
