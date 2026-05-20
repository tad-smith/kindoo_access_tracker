// Stake-presidency data hooks.
//
// `useStakeRoster()` — every seat where the primary scope is `'stake'`
// OR any duplicate scope is `'stake'` (Phase B broadened inclusion).
// Two-query union per KS-10 Option (b); see `mergeSeatsByCanonical`.
// `useWardSeats(wardCode)` — same shape, keyed on a ward (Ward
// Rosters browse view).
// `useStakeWards()` — the stake's full ward list (for the Ward Rosters
// dropdown). Live so newly-added wards show up without a reload.

import { query, where } from 'firebase/firestore';
import { useMemo } from 'react';
import type { KindooSite, Seat, Ward } from '@kindoo/shared';
import { useFirestoreCollection } from '../../lib/data';
import { db } from '../../lib/firebase';
import { kindooSitesCol, seatsCol, wardsCol } from '../../lib/docs';
import { useActiveStake } from '../../lib/useActiveStake';
import { mergeSeatsByCanonical, type RosterResult } from '../../lib/rosters';

export function useStakeRoster(): RosterResult {
  const activeStakeId = useActiveStake();
  const primaryQuery = useMemo(
    () =>
      activeStakeId ? query(seatsCol(db, activeStakeId), where('scope', '==', 'stake')) : null,
    [activeStakeId],
  );
  const duplicateQuery = useMemo(
    () =>
      activeStakeId
        ? query(seatsCol(db, activeStakeId), where('duplicate_scopes', 'array-contains', 'stake'))
        : null,
    [activeStakeId],
  );
  const primary = useFirestoreCollection<Seat>(primaryQuery);
  const dupe = useFirestoreCollection<Seat>(duplicateQuery);
  return useMemo(() => mergeSeatsByCanonical(primary, dupe), [primary, dupe]);
}

export function useWardSeats(wardCode: string | null): RosterResult {
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

export function useStakeWards() {
  const activeStakeId = useActiveStake();
  const wardsQuery = useMemo(
    () => (activeStakeId ? wardsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<Ward>(wardsQuery);
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
