// Manager All Seats data hooks. We pull every seat in the stake (live)
// + the wards + buildings collections (live) so filters and the
// per-scope summaries patch automatically when the importer or a
// completion writes a row.
//
// All Seats is read-only: it has no edit mutation. Editing a seat flows
// through the request flow (EditSeatDialog on the roster pages), which
// creates an audited edit request — no edit dialog writes SBA directly.
// Removing a seat also goes through a request (the shared
// <RemovalAffordance>). Reconcile was removed in Phase B (T-43) —
// multi-row rendering surfaces every grant visually, so picking one to
// promote is no longer needed.

import { useMemo } from 'react';
import type { Building, KindooSite, Seat, Ward } from '@kindoo/shared';
import { useFirestoreCollection } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import { buildingsCol, kindooSitesCol, seatsCol, wardsCol } from '../../../lib/docs';
import { useActiveStake } from '../../../lib/useActiveStake';

export function useAllSeats() {
  const activeStakeId = useActiveStake();
  const q = useMemo(() => (activeStakeId ? seatsCol(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreCollection<Seat>(q);
}

export function useWards() {
  const activeStakeId = useActiveStake();
  const q = useMemo(() => (activeStakeId ? wardsCol(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreCollection<Ward>(q);
}

export function useBuildings() {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () => (activeStakeId ? buildingsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<Building>(q);
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
