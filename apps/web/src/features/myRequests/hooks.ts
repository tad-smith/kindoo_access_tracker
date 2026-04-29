// Cross-role MyRequests data hooks. The Apps Script app shipped one
// MyRequests template for every role (bishopric + stake + manager); we
// keep that single shared page at `/my-requests` in the SPA. Live
// subscription scoped to the signed-in user's `requester_canonical`.

import { query, where, orderBy } from 'firebase/firestore';
import { useMemo } from 'react';
import type { AccessRequest } from '@kindoo/shared';
import { useFirestoreCollection } from '../../lib/data';
import { db } from '../../lib/firebase';
import { requestsCol } from '../../lib/docs';
import { STAKE_ID } from '../../lib/constants';

/**
 * Live request list for the signed-in user. `null` canonical disables
 * the subscription. Newest first via the `requester_canonical ASC,
 * requested_at DESC` composite index declared in
 * `firestore.indexes.json`.
 */
export function useMyRequests(canonical: string | null) {
  const reqQuery = useMemo(() => {
    if (!canonical) return null;
    return query(
      requestsCol(db, STAKE_ID),
      where('requester_canonical', '==', canonical),
      orderBy('requested_at', 'desc'),
    );
  }, [canonical]);
  return useFirestoreCollection<AccessRequest>(reqQuery);
}
