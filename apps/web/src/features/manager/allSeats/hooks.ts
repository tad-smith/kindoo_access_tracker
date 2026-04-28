// Manager All Seats data hooks. We pull every seat in the stake (live)
// + the wards + buildings collections (live) so filters and the
// per-scope summaries patch automatically when the importer or a
// completion writes a row.

import { useMemo } from 'react';
import type { Building, Seat, Ward } from '@kindoo/shared';
import { useFirestoreCollection } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import { buildingsCol, seatsCol, wardsCol } from '../../../lib/docs';
import { STAKE_ID } from '../../../lib/constants';

export function useAllSeats() {
  const q = useMemo(() => seatsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Seat>(q);
}

export function useWards() {
  const q = useMemo(() => wardsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Ward>(q);
}

export function useBuildings() {
  const q = useMemo(() => buildingsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Building>(q);
}
