// Bishopric data hooks. Live subscriptions to the seats + requests
// collections, scoped per spec.md §5.1 to the principal's own ward.
//
// `useBishopricRoster(wardCode)` — every seat with `scope == wardCode`.
// `useBishopricMyRequests(canonical)` — every request the signed-in
// bishopric submitted (across types and scopes).
//
// Per architecture D11 (DIY hooks): we wrap the SDK
// `useFirestoreCollection` from `lib/data/` rather than calling
// `getDocs`/`onSnapshot` directly. The wrapper memoizes the underlying
// `Query` so the listener doesn't churn on every render.

import { query, where, orderBy } from 'firebase/firestore';
import { useMemo } from 'react';
import type { AccessRequest, Seat } from '@kindoo/shared';
import { useFirestoreCollection } from '../../lib/data';
import { db } from '../../lib/firebase';
import { requestsCol, seatsCol } from '../../lib/docs';
import { STAKE_ID } from '../../lib/constants';

/**
 * Live seats list for one ward. Pass `null` to disable the subscription
 * (e.g. when the principal has no bishopric ward yet selected).
 */
export function useBishopricRoster(wardCode: string | null) {
  const seatsQuery = useMemo(() => {
    if (!wardCode) return null;
    return query(seatsCol(db, STAKE_ID), where('scope', '==', wardCode));
  }, [wardCode]);
  return useFirestoreCollection<Seat>(seatsQuery);
}

/**
 * Live MyRequests list for the signed-in user. Returns every request
 * keyed to `requester_canonical`, newest-first via `requested_at DESC`.
 *
 * Pass `null` for the canonical when the principal hasn't loaded yet so
 * the hook stays disabled.
 */
export function useMyRequests(canonical: string | null) {
  const requestsQuery = useMemo(() => {
    if (!canonical) return null;
    return query(
      requestsCol(db, STAKE_ID),
      where('requester_canonical', '==', canonical),
      orderBy('requested_at', 'desc'),
    );
  }, [canonical]);
  return useFirestoreCollection<AccessRequest>(requestsQuery);
}
