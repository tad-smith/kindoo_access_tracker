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
import { STAKE_ID } from '../../lib/constants';
import { mergeSeatsByCanonical, type RosterResult } from '../bishopric/hooks';

export function useStakeRoster(): RosterResult {
  const primaryQuery = useMemo(
    () => query(seatsCol(db, STAKE_ID), where('scope', '==', 'stake')),
    [],
  );
  const duplicateQuery = useMemo(
    () => query(seatsCol(db, STAKE_ID), where('duplicate_scopes', 'array-contains', 'stake')),
    [],
  );
  const primary = useFirestoreCollection<Seat>(primaryQuery);
  const dupe = useFirestoreCollection<Seat>(duplicateQuery);
  return useMemo(() => mergeSeatsByCanonical(primary, dupe), [primary, dupe]);
}

export function useWardSeats(wardCode: string | null): RosterResult {
  const primaryQuery = useMemo(() => {
    if (!wardCode) return null;
    return query(seatsCol(db, STAKE_ID), where('scope', '==', wardCode));
  }, [wardCode]);
  const duplicateQuery = useMemo(() => {
    if (!wardCode) return null;
    return query(seatsCol(db, STAKE_ID), where('duplicate_scopes', 'array-contains', wardCode));
  }, [wardCode]);
  const primary = useFirestoreCollection<Seat>(primaryQuery);
  const dupe = useFirestoreCollection<Seat>(duplicateQuery);
  return useMemo(() => mergeSeatsByCanonical(primary, dupe), [primary, dupe]);
}

export function useStakeWards() {
  const wardsQuery = useMemo(() => wardsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Ward>(wardsQuery);
}

/**
 * Live Kindoo Sites catalogue — feeds the foreign-site label on ward
 * seats (spec §15). Empty when the stake only operates its home site.
 */
export function useKindooSites() {
  const q = useMemo(() => kindooSitesCol(db, STAKE_ID), []);
  return useFirestoreCollection<KindooSite>(q);
}
