// Manager Queue data hooks.
//
// Read side only — the queue is a read-only visibility surface. The
// actionable request workflow (complete / reject) lives entirely in the
// Chrome extension; the app no longer carries those write paths.
//
//   - `usePendingRequests()` — live list of requests with status='pending',
//     ordered FIFO (oldest first). Indexed via the
//     `(status ASC, requested_at ASC)` composite from
//     `firestore.indexes.json`.

import { orderBy, query, where } from 'firebase/firestore';
import { useMemo } from 'react';
import type { AccessRequest } from '@kindoo/shared';
import { useFirestoreCollection } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import { requestsCol } from '../../../lib/docs';
import { useActiveStake } from '../../../lib/useActiveStake';

/** Live FIFO pending-requests list. */
export function usePendingRequests() {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () =>
      activeStakeId
        ? query(
            requestsCol(db, activeStakeId),
            where('status', '==', 'pending'),
            orderBy('requested_at', 'asc'),
          )
        : null,
    [activeStakeId],
  );
  return useFirestoreCollection<AccessRequest>(q);
}
