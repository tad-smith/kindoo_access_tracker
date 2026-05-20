// Bishopric data hooks. Live subscriptions to the seats + requests
// collections, scoped per spec.md §5.1 to the principal's own ward.
//
// `useBishopricRoster(wardCode)` — every seat where ANY grant
// (primary OR a `duplicate_grants[]` entry) matches the ward (spec
// §15 Phase B). Implementation per KS-10 Option (b): two
// `useFirestoreCollection` subscriptions — `where('scope', '==', X)`
// + `where('duplicate_scopes', 'array-contains', X)` — merged client-
// side by `member_canonical`. The `duplicate_scopes` field is the
// denormalised primitive-array mirror written by every seat writer
// (T-42 Phase A).
//
// `useBishopricMyRequests(canonical)` — every request the signed-in
// bishopric submitted (across types and scopes).
//
// Per architecture D11 (DIY hooks): we wrap the SDK
// `useFirestoreCollection` from `lib/data/` rather than calling
// `getDocs`/`onSnapshot` directly.

import { query, where, orderBy } from 'firebase/firestore';
import { useMemo } from 'react';
import type { AccessRequest, KindooSite, Seat, Ward } from '@kindoo/shared';
import { useFirestoreCollection } from '../../lib/data';
import { db } from '../../lib/firebase';
import { kindooSitesCol, requestsCol, seatsCol, wardsCol } from '../../lib/docs';
import { useActiveStake } from '../../lib/useActiveStake';
import { mergeSeatsByCanonical, type RosterResult } from '../../lib/rosters';

/**
 * Live seats list for one ward — broadened to include any seat
 * whose primary scope OR any duplicate scope matches the ward
 * (Phase B). Two-query union (KS-10 Option b); the merge is keyed by
 * `member_canonical` so a seat that lands in both subscriptions (e.g.
 * primary matches AND a same-scope duplicate exists) renders once.
 *
 * Pass `null` to disable both subscriptions.
 */
export function useBishopricRoster(wardCode: string | null): RosterResult {
  const activeStakeId = useActiveStake();
  const primaryQuery = useMemo(() => {
    if (!wardCode || !activeStakeId) return null;
    return query(seatsCol(db, activeStakeId), where('scope', '==', wardCode));
  }, [wardCode, activeStakeId]);
  const duplicateQuery = useMemo(() => {
    if (!wardCode || !activeStakeId) return null;
    return query(
      seatsCol(db, activeStakeId),
      where('duplicate_scopes', 'array-contains', wardCode),
    );
  }, [wardCode, activeStakeId]);
  const primary = useFirestoreCollection<Seat>(primaryQuery);
  const dupe = useFirestoreCollection<Seat>(duplicateQuery);
  return useMemo(() => mergeSeatsByCanonical(primary, dupe), [primary, dupe]);
}

/**
 * Live wards catalogue — feeds the Kindoo-site label on ward seats
 * (spec §15). One subscription regardless of how many wards the
 * bishopric holds; the page filters client-side.
 */
export function useStakeWards() {
  const activeStakeId = useActiveStake();
  const q = useMemo(() => (activeStakeId ? wardsCol(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreCollection<Ward>(q);
}

/**
 * Live Kindoo Sites catalogue — feeds the foreign-site label on ward
 * seats (spec §15). Empty when the stake only operates its home site.
 */
export function useKindooSites() {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () => (activeStakeId ? kindooSitesCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<KindooSite>(q);
}

/**
 * Live MyRequests list for the signed-in user. Returns every request
 * keyed to `requester_canonical`, newest-first via `requested_at DESC`.
 *
 * Pass `null` for the canonical when the principal hasn't loaded yet so
 * the hook stays disabled.
 */
export function useMyRequests(canonical: string | null) {
  const activeStakeId = useActiveStake();
  const requestsQuery = useMemo(() => {
    if (!canonical || !activeStakeId) return null;
    return query(
      requestsCol(db, activeStakeId),
      where('requester_canonical', '==', canonical),
      orderBy('requested_at', 'desc'),
    );
  }, [canonical, activeStakeId]);
  return useFirestoreCollection<AccessRequest>(requestsQuery);
}
