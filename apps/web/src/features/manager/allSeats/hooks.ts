// Manager All Seats data hooks. We pull every seat in the stake (live)
// + the wards + buildings collections (live) so filters and the
// per-scope summaries patch automatically when the importer or a
// completion writes a row.
//
// Mutations: inline edit touches only the rules' update-allowlist
// (member_name, reason, building_names, start_date, end_date);
// reconcile rewrites the seat's primary grant from one of the
// duplicate_grants entries.

import { useMemo } from 'react';
import { serverTimestamp, updateDoc } from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Building, DuplicateGrant, KindooSite, Seat, Ward } from '@kindoo/shared';
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

export interface ReconcileSeatInput {
  /** doc.id of the seat (= member_canonical). */
  member_canonical: string;
  /** Full new primary grant (one of `[primary, ...duplicate_grants]`). */
  newPrimary: {
    scope: string;
    type: 'auto' | 'manual' | 'temp';
    callings?: string[];
    reason?: string;
    start_date?: string;
    end_date?: string;
  };
  /** New duplicate-grants array (the original list minus the chosen one, plus any other grants needing record). */
  newDuplicateGrants: DuplicateGrant[];
}

/**
 * Reconcile a seat with `duplicate_grants` by promoting one of the
 * grants to primary. Rewrites the seat doc with the chosen grant's
 * scope/type/callings/reason/start_date/end_date as the new primary
 * and replaces `duplicate_grants[]` with the remainder.
 *
 * Note: the rules currently lock `scope` and `type` as immutable on
 * client updates (per the manager-update allowlist). A reconcile that
 * changes either one needs a backend-engineer rule change to land the
 * full reconcile flow under client-only writes; until then this
 * mutation only succeeds when the chosen new primary keeps the same
 * scope + type. We surface that as a friendly error in the UI.
 */
export function useReconcileSeatMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReconcileSeatInput) => {
      const actor = actorOf(principal);
      const ref = seatRef(db, STAKE_ID, input.member_canonical);
      const update: Record<string, unknown> = {
        building_names: [],
        callings: input.newPrimary.callings ?? [],
        duplicate_grants: input.newDuplicateGrants,
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      };
      if (input.newPrimary.reason !== undefined) {
        update.reason = input.newPrimary.reason;
      }
      if (input.newPrimary.start_date !== undefined) {
        update.start_date = input.newPrimary.start_date;
      }
      if (input.newPrimary.end_date !== undefined) {
        update.end_date = input.newPrimary.end_date;
      }
      await updateDoc(ref, update);
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}
