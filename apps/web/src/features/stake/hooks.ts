// Stake-presidency data hooks.
//
// `useStakeRoster()` — every seat with `scope == 'stake'` (the stake-
// scope pool the presidency owns).
// `useWardSeats(wardCode)` — every seat in one ward (Ward Rosters
// browse view; reuses bishopric's filter shape).
// `useStakeWards()` — the stake's full ward list (for the Ward Rosters
// dropdown). Live so newly-added wards show up without a reload.

import { query, where } from 'firebase/firestore';
import { useMemo } from 'react';
import type { Seat, Ward } from '@kindoo/shared';
import { useFirestoreCollection } from '../../lib/data';
import { db } from '../../lib/firebase';
import { seatsCol, wardsCol } from '../../lib/docs';
import { STAKE_ID } from '../../lib/constants';

export function useStakeRoster() {
  const stakeQuery = useMemo(
    () => query(seatsCol(db, STAKE_ID), where('scope', '==', 'stake')),
    [],
  );
  return useFirestoreCollection<Seat>(stakeQuery);
}

export function useWardSeats(wardCode: string | null) {
  const wardQuery = useMemo(() => {
    if (!wardCode) return null;
    return query(seatsCol(db, STAKE_ID), where('scope', '==', wardCode));
  }, [wardCode]);
  return useFirestoreCollection<Seat>(wardQuery);
}

export function useStakeWards() {
  const wardsQuery = useMemo(() => wardsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Ward>(wardsQuery);
}
