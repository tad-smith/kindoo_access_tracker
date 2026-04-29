// Manager Audit Log data hooks. Cursor-paginated via useFirestoreOnce
// (the migration plan: pagination doesn't compose with onSnapshot, so
// the audit log alone uses request-response semantics).
//
// Filters compose as AND on top of an `orderBy('timestamp', 'desc')`
// base query so the default view is newest-first. Only one filter at a
// time can use a range bound (Firestore restriction), so the date
// range goes through the base orderBy and the equality filters layer
// on top. This matches the index set declared in
// `firestore.indexes.json`.

import {
  endAt,
  limit,
  orderBy,
  query,
  startAfter,
  startAt,
  Timestamp,
  where,
  type Query,
  type QueryConstraint,
} from 'firebase/firestore';
import { useMemo } from 'react';
import type { AuditLog } from '@kindoo/shared';
import { useFirestoreOnce } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import { auditLogCol } from '../../../lib/docs';
import { STAKE_ID } from '../../../lib/constants';

export interface AuditLogFilters {
  action?: string | undefined;
  entity_type?: string | undefined;
  entity_id?: string | undefined;
  actor_canonical?: string | undefined;
  member_canonical?: string | undefined;
  date_from?: string | undefined; // YYYY-MM-DD
  date_to?: string | undefined; // YYYY-MM-DD
}

export const PAGE_SIZE = 25;

/**
 * Build the constraints array for a given filter set + cursor. Order
 * matters: any equality `where()` first, then `orderBy('timestamp',
 * 'desc')`, then the optional date-range bounds, then the cursor.
 *
 * Firestore requires the orderBy field to be the same field used for
 * the cursor (`startAfter(doc)` reads its position from the orderBy
 * field). We use `startAfter(timestamp)` over `startAfter(docSnap)` so
 * paginating doesn't require keeping a snapshot reference around —
 * just the last row's timestamp.
 */
function buildConstraints(filters: AuditLogFilters, cursor: Timestamp | null): QueryConstraint[] {
  const constraints: QueryConstraint[] = [];

  // Equality filters layer first. Pick at most one — Firestore allows
  // multiple equality where()s on the same query, but composite indexes
  // grow combinatorially. The migration plan opts for one equality at a
  // time; the UI defaults to whichever filter is actively populated.
  if (filters.action) constraints.push(where('action', '==', filters.action));
  else if (filters.entity_type) constraints.push(where('entity_type', '==', filters.entity_type));
  else if (filters.entity_id) constraints.push(where('entity_id', '==', filters.entity_id));
  else if (filters.actor_canonical)
    constraints.push(where('actor_canonical', '==', filters.actor_canonical));
  else if (filters.member_canonical)
    constraints.push(where('member_canonical', '==', filters.member_canonical));

  constraints.push(orderBy('timestamp', 'desc'));

  if (filters.date_to) {
    // Inclusive end-of-day bound — interpret the picker date as
    // "end of that day in UTC" since the audit timestamp is stored in
    // UTC by the Cloud Function trigger.
    const end = new Date(`${filters.date_to}T23:59:59.999Z`);
    constraints.push(startAt(Timestamp.fromDate(end)));
  }
  if (filters.date_from) {
    const start = new Date(`${filters.date_from}T00:00:00Z`);
    constraints.push(endAt(Timestamp.fromDate(start)));
  }
  if (cursor) constraints.push(startAfter(cursor));
  constraints.push(limit(PAGE_SIZE));

  return constraints;
}

export function useAuditLogPage(filters: AuditLogFilters, cursor: Timestamp | null) {
  const q = useMemo<Query<AuditLog>>(
    () => query(auditLogCol(db, STAKE_ID), ...buildConstraints(filters, cursor)),
    [
      filters.action,
      filters.entity_type,
      filters.entity_id,
      filters.actor_canonical,
      filters.member_canonical,
      filters.date_from,
      filters.date_to,
      cursor,
    ],
  );
  return useFirestoreOnce<AuditLog>(q);
}
