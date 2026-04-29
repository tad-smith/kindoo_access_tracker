// Manager Dashboard data hooks. The Apps Script app collapsed the
// dashboard render into a single ApiManager_dashboard rpc; the SPA
// fans out to five live Firestore subscriptions instead, each rendered
// in its own card. Latency is comparable since Firestore subscriptions
// share the same WebSocket channel; the live behaviour is a strict
// upgrade.
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
import { STAKE_ID } from '../../../lib/constants';

const RECENT_AUDIT_LIMIT = 10;

export function usePendingRequests() {
  const q = useMemo(
    () =>
      query(
        requestsCol(db, STAKE_ID),
        where('status', '==', 'pending'),
        orderBy('requested_at', 'asc'),
      ),
    [],
  );
  return useFirestoreCollection<AccessRequest>(q);
}

export function useRecentAuditLog() {
  const q = useMemo(
    () => query(auditLogCol(db, STAKE_ID), orderBy('timestamp', 'desc'), limit(RECENT_AUDIT_LIMIT)),
    [],
  );
  return useFirestoreCollection<AuditLog>(q);
}

export function useStakeSeats() {
  const q = useMemo(() => seatsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Seat>(q);
}

export function useStakeWards() {
  const q = useMemo(() => wardsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Ward>(q);
}

export function useStakeDoc() {
  const ref = useMemo(() => stakeRef(db, STAKE_ID), []);
  return useFirestoreDoc(ref);
}
