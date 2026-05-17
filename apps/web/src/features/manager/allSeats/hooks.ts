// Manager All Seats data hooks. We pull every seat in the stake (live)
// + the wards + buildings collections (live) so filters and the
// per-scope summaries patch automatically when the importer or a
// completion writes a row.
//
// Mutations: inline edit touches only the rules' update-allowlist
// (member_name, reason, building_names, start_date, end_date).
// Reconcile was removed in Phase B (T-43) — multi-row rendering
// surfaces every grant visually, so picking one to promote is no
// longer needed.

import { useMemo } from 'react';
import { serverTimestamp, updateDoc } from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Building, KindooSite, Seat, Ward } from '@kindoo/shared';
import { canonicalEmail } from '@kindoo/shared';
import { useFirestoreCollection } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import { buildingsCol, kindooSitesCol, seatRef, seatsCol, wardsCol } from '../../../lib/docs';
import { STAKE_ID } from '../../../lib/constants';
import { usePrincipal } from '../../../lib/principal';

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

/**
 * Live Kindoo Sites catalogue — feeds the foreign-site label on ward
 * seats (spec §15). Empty when the stake only operates its home site.
 */
export function useKindooSites() {
  const q = useMemo(() => kindooSitesCol(db, STAKE_ID), []);
  return useFirestoreCollection<KindooSite>(q);
}

function actorOf(principal: ReturnType<typeof usePrincipal>) {
  return {
    email: principal.email ?? '',
    canonical: principal.canonical ?? canonicalEmail(principal.email ?? ''),
  };
}

export interface InlineSeatEditInput {
  member_canonical: string;
  member_name: string;
  reason?: string;
  building_names: string[];
  start_date?: string;
  end_date?: string;
}

/**
 * Inline edit a manual/temp seat — manager-only, touches only the
 * rules-allowlisted fields (`member_name`, `reason`, `building_names`,
 * `start_date`, `end_date`). The rule blocks edits on auto seats; we
 * also gate the affordance in the UI.
 */
export function useInlineSeatEditMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: InlineSeatEditInput) => {
      const actor = actorOf(principal);
      const ref = seatRef(db, STAKE_ID, input.member_canonical);
      // Build the update map field-by-field so the rule's
      // `affectedKeys().hasOnly(...)` predicate sees only the allowed
      // keys. Empty/undefined fields fall through unchanged.
      const update: Record<string, unknown> = {
        member_name: input.member_name.trim(),
        building_names: input.building_names,
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      };
      if (input.reason !== undefined) update.reason = input.reason.trim();
      if (input.start_date !== undefined) update.start_date = input.start_date;
      if (input.end_date !== undefined) update.end_date = input.end_date;
      await updateDoc(ref, update);
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}
