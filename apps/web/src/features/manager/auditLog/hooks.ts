// Manager Audit Log data hooks. Infinite-scroll pagination via
// TanStack `useInfiniteQuery` over `getDocs`. The audit log doesn't
// live-subscribe — pagination doesn't compose with `onSnapshot`.
//
// Filters compose as AND on top of an `orderBy('timestamp', 'desc')`
// base query so the default view is newest-first. Only one filter at a
// time can use a range bound (Firestore restriction); equality filters
// layer on top. Index set declared in `firestore.indexes.json`.

import {
  endAt,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  startAt,
  Timestamp,
  where,
  type FirestoreError,
  type QueryConstraint,
} from 'firebase/firestore';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AuditLog } from '@kindoo/shared';
import { db } from '../../../lib/firebase';
import { auditLogCol } from '../../../lib/docs';
import { useActiveStake } from '../../../lib/useActiveStake';
import { endOfDayInStakeTz, startOfDayInStakeTz } from '../../../lib/datetime';

export interface AuditLogFilters {
  action?: string | undefined;
  entity_type?: string | undefined;
  entity_id?: string | undefined;
  actor_canonical?: string | undefined;
  member_canonical?: string | undefined;
  date_from?: string | undefined; // YYYY-MM-DD
  date_to?: string | undefined; // YYYY-MM-DD
}

export const PAGE_SIZE = 50;

/** Build the constraints for a single page given a cursor (last
 *  page's tail timestamp, or null for the first page).
 *
 *  Date-range bounds are interpreted in the stake's IANA timezone:
 *  `date_from` resolves to start-of-day and `date_to` to end-of-day in
 *  `timezone`, so the inclusive range matches the stake-tz timestamp
 *  display (the query runs descending, so `date_to` is the `startAt`
 *  bound and `date_from` the `endAt` bound). */
export function buildConstraints(
  filters: AuditLogFilters,
  cursor: Timestamp | null,
  timezone: string | undefined,
): QueryConstraint[] {
  const constraints: QueryConstraint[] = [];

  // Equality filters layer first. At most one — composite indexes
  // grow combinatorially otherwise.
  if (filters.action) constraints.push(where('action', '==', filters.action));
  else if (filters.entity_type) constraints.push(where('entity_type', '==', filters.entity_type));
  else if (filters.entity_id) constraints.push(where('entity_id', '==', filters.entity_id));
  else if (filters.actor_canonical)
    constraints.push(where('actor_canonical', '==', filters.actor_canonical));
  else if (filters.member_canonical)
    constraints.push(where('member_canonical', '==', filters.member_canonical));

  constraints.push(orderBy('timestamp', 'desc'));

  if (filters.date_to) {
    const end = endOfDayInStakeTz(filters.date_to, timezone);
    constraints.push(startAt(Timestamp.fromDate(end)));
  }
  if (filters.date_from) {
    const start = startOfDayInStakeTz(filters.date_from, timezone);
    constraints.push(endAt(Timestamp.fromDate(start)));
  }
  if (cursor) constraints.push(startAfter(cursor));
  constraints.push(limit(PAGE_SIZE));

  return constraints;
}

interface AuditLogPage {
  rows: readonly AuditLog[];
  nextCursor: Timestamp | null;
}

/**
 * Infinite-scroll audit log query. Pages of `PAGE_SIZE` rows each;
 * `fetchNextPage()` advances when the user nears the bottom of the
 * list. Returns the standard `useInfiniteQuery` result; callers
 * concatenate `data.pages.flatMap(p => p.rows)` for the visible list.
 *
 * `timezone` is the stake's IANA zone; it scopes the date-range filter
 * bounds to stake-local day boundaries (matching the timestamp display)
 * and is part of the query key so a stake/tz change refetches.
 */
export function useAuditLogInfinite(filters: AuditLogFilters, timezone: string | undefined) {
  const activeStakeId = useActiveStake();
  return useInfiniteQuery<AuditLogPage, FirestoreError>({
    queryKey: [
      '__kindoo_firestore__',
      'audit-log-infinite',
      activeStakeId ?? '',
      filters.action ?? '',
      filters.entity_type ?? '',
      filters.entity_id ?? '',
      filters.actor_canonical ?? '',
      filters.member_canonical ?? '',
      filters.date_from ?? '',
      filters.date_to ?? '',
      timezone ?? '',
    ],
    initialPageParam: null as Timestamp | null,
    enabled: activeStakeId !== null,
    queryFn: async ({ pageParam }) => {
      if (!activeStakeId) return { rows: [], nextCursor: null };
      const cursor = pageParam as Timestamp | null;
      const q = query(
        auditLogCol(db, activeStakeId),
        ...buildConstraints(filters, cursor, timezone),
      );
      const snap = await getDocs(q);
      const rows = snap.docs.map((d) => d.data());
      const last = rows[rows.length - 1];
      const nextCursor =
        rows.length === PAGE_SIZE && last ? (last.timestamp as unknown as Timestamp) : null;
      return { rows, nextCursor };
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}
