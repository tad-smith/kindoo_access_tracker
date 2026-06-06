// Stake-presidency data hooks.
//
// `useStakeRoster()` — every seat where the primary scope is `'stake'`
// OR any duplicate scope is `'stake'` (Phase B broadened inclusion).
// Two-query union per KS-10 Option (b); see `mergeSeatsByCanonical`.
// `useWardSeats(wardCode)` — same shape, keyed on a ward (Ward
// Rosters browse view).
// `useStakeWards()` — the stake's full ward list (for the Ward Rosters
// dropdown). Live so newly-added wards show up without a reload.

import { query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { canonicalEmail } from '@kindoo/shared';
import type { Building, KindooSite, Seat, Ward } from '@kindoo/shared';
import { useFirestoreCollection } from '../../lib/data';
import { db } from '../../lib/firebase';
import { buildingsCol, kindooSitesCol, seatRef, seatsCol, wardsCol } from '../../lib/docs';
import { useActiveStake } from '../../lib/useActiveStake';
import { usePrincipal, type Principal } from '../../lib/principal';
import { toast } from '../../lib/store/toast';
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
 * Live buildings catalogue — a ward's Kindoo site is derived from its
 * building, so the roster's foreign-site label needs this alongside
 * the wards list.
 */
export function useStakeBuildings() {
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

// ---- Inline org-edit mutation ---------------------------------------

function actorOf(principal: Principal): { email: string; canonical: string } {
  return {
    email: principal.email ?? '',
    canonical: principal.canonical ?? canonicalEmail(principal.email ?? ''),
  };
}

export interface SetSeatOrganizationInput {
  /** Canonical email = seat doc id of the member whose primary stake grant is being re-orged. */
  memberCanonical: string;
  /** Org slug id, or `null` for "No Organization". */
  organizationId: string | null;
}

/**
 * Inline "set this stake-roster member's organization" mutation. Writes
 * EXACTLY the four keys the Firestore rule's `hasOnly` allowlist permits
 * (`organization_id`, `last_modified_at`, `last_modified_by`,
 * `lastActor`) so the direct-write path passes integrity + scope checks.
 *
 * Targets the seat's PRIMARY stake grant (`scope === 'stake'`); the
 * caller gates the editable affordance so a duplicate stake grant
 * (set via the request form) never reaches this mutation.
 */
export function useSetSeatOrganization() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ memberCanonical, organizationId }: SetSeatOrganizationInput) => {
      if (!activeStakeId) {
        throw new Error('No active stake. Cannot set organization.');
      }
      const actor = actorOf(principal);
      await updateDoc(seatRef(db, activeStakeId, memberCanonical), {
        organization_id: organizationId,
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      });
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn, so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
    onError: () => {
      toast('Could not update the organization. Please try again.', 'error');
    },
  });
}
