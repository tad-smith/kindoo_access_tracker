// Bootstrap wizard data hooks. Each step reads the relevant
// collection/doc live and exposes a mutation that writes one row at a
// time (no client-side pending queue — Firestore writes are cheap and
// instant, and rule-level checks on `setup_complete=false` make the
// "one-shot wizard" guarantee a server-side property rather than a
// client-side discipline).
//
// All writes carry `lastActor: { email, canonical }` and the bookkeeping
// timestamps the rules' integrity check requires. The wizard runs as
// the bootstrap admin — they're auto-added to `kindooManagers` on first
// load via `ensureBootstrapAdmin`, which gives the
// `syncManagersClaims` trigger something to mint a manager claim from.

import { deleteDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { canonicalEmail, buildingSlug } from '@kindoo/shared';
import type { Building, KindooManager, Stake, Ward } from '@kindoo/shared';
import { useFirestoreCollection, useFirestoreDoc } from '../../lib/data';
import { db } from '../../lib/firebase';
import {
  buildingRef,
  buildingsCol,
  kindooManagerRef,
  kindooManagersCol,
  stakeRef,
  wardRef,
  wardsCol,
} from '../../lib/docs';
import { useActiveStake } from '../../lib/useActiveStake';
import { usePrincipal } from '../../lib/principal';
import type { Principal } from '../../lib/principal';

// ---- Live reads -----------------------------------------------------

export function useStakeDoc() {
  const activeStakeId = useActiveStake();
  const ref = useMemo(() => (activeStakeId ? stakeRef(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreDoc<Stake>(ref);
}

export function useBuildings() {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () => (activeStakeId ? buildingsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<Building>(q);
}

export function useWards() {
  const activeStakeId = useActiveStake();
  const q = useMemo(() => (activeStakeId ? wardsCol(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreCollection<Ward>(q);
}

export function useManagers() {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () => (activeStakeId ? kindooManagersCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<KindooManager>(q);
}

// ---- Actor helper ---------------------------------------------------

function actorOf(principal: Principal): { email: string; canonical: string } {
  return {
    email: principal.email ?? '',
    canonical: principal.canonical ?? canonicalEmail(principal.email ?? ''),
  };
}

function requireActiveStake(activeStakeId: string | null): string {
  if (!activeStakeId) {
    throw new Error('No active stake. Cannot write per-stake data.');
  }
  return activeStakeId;
}

// ---- Mutations ------------------------------------------------------

export interface Step1Input {
  stake_name: string;
  stake_seat_cap: number;
}

/**
 * Step 1 — write stake-level config fields. The stake doc is created
 * by the platform superadmin via `createStake` callable; the wizard
 * only updates it. Defaults for `expiry_hour` / `timezone` /
 * `notifications_enabled` are seeded by `createStake` (or assumed
 * already present); we only touch what the wizard exposes.
 */
export function useStep1Mutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Step1Input) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      await updateDoc(stakeRef(db, sid), {
        stake_name: input.stake_name,
        stake_seat_cap: input.stake_seat_cap,
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      });
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

export interface BuildingInput {
  building_name: string;
  address: string;
}

export function useAddBuildingMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BuildingInput) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      const slug = buildingSlug(input.building_name);
      if (!slug) throw new Error('Building name is required.');
      await setDoc(buildingRef(db, sid, slug), {
        building_id: slug,
        building_name: input.building_name.trim(),
        address: input.address.trim(),
        created_at: serverTimestamp(),
        last_modified_at: serverTimestamp(),
        lastActor: actor,
      } as unknown as Building);
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

// Block deletes when any ward references the building by name. Wards
// FK on `building_name` (per firebase-schema.md §4) — orphaning a ward
// silently breaks its building lookup. Firestore Security Rules can't
// iterate a sibling collection so we cannot enforce this at the rules
// layer; this client guard is the only line of defense (documented in
// docs/firebase-migration.md as a known gap).
//
// The caller passes the live wards list (already subscribed via
// useWards) so we don't need an extra getDocs round-trip; the ref-guard
// is computed against the same snapshot the user just saw.
export interface DeleteBuildingInput {
  buildingId: string;
  buildingName: string;
  wards: ReadonlyArray<Ward>;
}
export function useDeleteBuildingMutation() {
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteBuildingInput) => {
      const sid = requireActiveStake(activeStakeId);
      const refs = input.wards.filter((w) => w.building_name === input.buildingName);
      const blocker = buildingDeleteBlocker(refs);
      if (blocker) throw new Error(blocker);
      await deleteDoc(buildingRef(db, sid, input.buildingId));
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

/**
 * Pure helper: returns a user-facing error message when at least one
 * ward references the building, or `null` when delete is safe. Pulled
 * out so unit tests can exercise the guard without standing up a
 * Firestore emulator.
 */
export function buildingDeleteBlocker(referencingWards: ReadonlyArray<Ward>): string | null {
  if (referencingWards.length === 0) return null;
  const labels = referencingWards.map((w) => `${w.ward_name} (${w.ward_code})`);
  return `Cannot delete: referenced by ${labels.length} ward(s) — ${labels.join(', ')}`;
}

export interface WardInput {
  ward_code: string;
  ward_name: string;
  building_name: string;
  seat_cap: number;
}

export function useAddWardMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WardInput) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      const code = input.ward_code.trim().toUpperCase();
      if (!code) throw new Error('Ward code is required.');
      await setDoc(wardRef(db, sid, code), {
        ward_code: code,
        ward_name: input.ward_name.trim(),
        building_name: input.building_name,
        seat_cap: input.seat_cap,
        created_at: serverTimestamp(),
        last_modified_at: serverTimestamp(),
        lastActor: actor,
      } as unknown as Ward);
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

export function useDeleteWardMutation() {
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (wardCode: string) => {
      const sid = requireActiveStake(activeStakeId);
      await deleteDoc(wardRef(db, sid, wardCode));
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

export interface ManagerInput {
  member_email: string;
  name: string;
}

// New managers default to `active: true`. The deactivate flow happens
// post-create via `useUpdateManagerActiveMutation` (Configuration page +
// wizard Step 4 toggle).
export function useAddManagerMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManagerInput) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      const canonical = canonicalEmail(input.member_email);
      await setDoc(kindooManagerRef(db, sid, canonical), {
        member_canonical: canonical,
        member_email: input.member_email.trim(),
        name: input.name.trim(),
        active: true,
        added_at: serverTimestamp(),
        added_by: actor,
        lastActor: actor,
      } as unknown as KindooManager);
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

export function useUpdateManagerActiveMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { canonical: string; active: boolean }) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      await updateDoc(kindooManagerRef(db, sid, input.canonical), {
        active: input.active,
        lastActor: actor,
      });
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

export function useDeleteManagerMutation() {
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (canonical: string) => {
      const sid = requireActiveStake(activeStakeId);
      await deleteDoc(kindooManagerRef(db, sid, canonical));
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

/**
 * Auto-add the bootstrap admin to `kindooManagers` on first wizard
 * load. Idempotent: if the doc already exists with `active=true` we
 * leave it alone (avoids fighting the user if they reopened the wizard
 * mid-setup). The seed sets `active=true` so the
 * `syncManagersClaims` trigger mints the manager claim that lets later
 * wizard steps satisfy the manager rule predicates.
 */
export function useEnsureBootstrapAdmin() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  return useMutation({
    mutationFn: async (bootstrapAdminEmail: string) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      const canonical = canonicalEmail(bootstrapAdminEmail);
      await setDoc(
        kindooManagerRef(db, sid, canonical),
        {
          member_canonical: canonical,
          member_email: bootstrapAdminEmail,
          name: principal.email ?? bootstrapAdminEmail,
          active: true,
          added_at: serverTimestamp(),
          added_by: actor,
          lastActor: actor,
        } as unknown as KindooManager,
        { merge: true },
      );
    },
  });
}

/**
 * Final step — flips `setup_complete=true`. The same updateDoc carries
 * the `lastActor` integrity field. The page wrapper additionally
 * invokes the `installScheduledJobs` callable; this mutation only
 * owns the Firestore flip.
 */
export function useCompleteSetupMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      await updateDoc(stakeRef(db, sid), {
        setup_complete: true,
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      });
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}
