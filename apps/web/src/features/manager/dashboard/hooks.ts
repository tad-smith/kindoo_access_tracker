// Manager Dashboard data hooks. The dashboard fans out to five live
// Firestore subscriptions, each rendered in its own card. They share
// the same WebSocket channel so latency stays predictable.
//
// One hook per card:
//   - usePendingRequests(): all `status == 'pending'` requests, used
//     for the per-type counts.
//   - useRecentAuditLog(): the most-recent 10 audit rows. We rely on
//     `audit_id` reverse-lex sorting (the doc-id format is
//     `<ISO-timestamp>_<uuid-suffix>`) so newest-first is a single
//     orderBy on `__name__`.
//   - useStakeSeats(): every seat in the stake (used for utilization).
//   - useStakeWards(): the ward list (used for utilization labels).
//   - useStakeDoc(): the parent stake doc (used for warnings + last
//     ops + stake_seat_cap).

import { limit, orderBy, query, where } from 'firebase/firestore';
import { useMemo } from 'react';
import type { AccessRequest, AuditLog, Seat, Ward } from '@kindoo/shared';
import { useFirestoreCollection, useFirestoreDoc } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import { auditLogCol, requestsCol, seatsCol, stakeRef, wardsCol } from '../../../lib/docs';
import { useActiveStake } from '../../../lib/useActiveStake';

const RECENT_AUDIT_LIMIT = 10;

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

export function useRecentAuditLog() {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () =>
      activeStakeId
        ? query(
            auditLogCol(db, activeStakeId),
            orderBy('timestamp', 'desc'),
            limit(RECENT_AUDIT_LIMIT),
          )
        : null,
    [activeStakeId],
  );
  return useFirestoreCollection<AuditLog>(q);
}

export function useStakeSeats() {
  const activeStakeId = useActiveStake();
  const q = useMemo(() => (activeStakeId ? seatsCol(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreCollection<Seat>(q);
}

export function useStakeWards() {
  const activeStakeId = useActiveStake();
  const q = useMemo(() => (activeStakeId ? wardsCol(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreCollection<Ward>(q);
}

export function useStakeDoc() {
  const activeStakeId = useActiveStake();
  const ref = useMemo(() => (activeStakeId ? stakeRef(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreDoc(ref);
}
