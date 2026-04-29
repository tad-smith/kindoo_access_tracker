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

import {
  deleteDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
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
import { STAKE_ID } from '../../lib/constants';
import { usePrincipal } from '../../lib/principal';
import type { Principal } from '../../lib/principal';

// ---- Live reads -----------------------------------------------------

export function useStakeDoc() {
  const ref = useMemo(() => stakeRef(db, STAKE_ID), []);
  return useFirestoreDoc<Stake>(ref);
}

export function useBuildings() {
  const q = useMemo(() => buildingsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Building>(q);
}

export function useWards() {
  const q = useMemo(() => wardsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Ward>(q);
}

export function useManagers() {
  const q = useMemo(() => kindooManagersCol(db, STAKE_ID), []);
  return useFirestoreCollection<KindooManager>(q);
}

// ---- Actor helper ---------------------------------------------------

function actorOf(principal: Principal): { email: string; canonical: string } {
  return {
    email: principal.email ?? '',
    canonical: principal.canonical ?? canonicalEmail(principal.email ?? ''),
  };
}

// ---- Mutations ------------------------------------------------------

export interface Step1Input {
  stake_name: string;
  // Optional — operators may complete bootstrap without an LCR sheet
  // configured and fill it in later from Configuration.
  callings_sheet_id?: string | undefined;
  stake_seat_cap: number;
}

/**
 * Step 1 — write stake-level config fields. The stake doc is created
 * by the platform superadmin via `createStake` callable; the wizard
 * only updates it. Defaults for `expiry_hour` / `import_day` /
 * `import_hour` / `timezone` / `notifications_enabled` are seeded by
 * `createStake` (or assumed already present); we only touch what the
 * wizard exposes.
 */
export function useStep1Mutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Step1Input) => {
      const actor = actorOf(principal);
      await updateDoc(stakeRef(db, STAKE_ID), {
        stake_name: input.stake_name,
        callings_sheet_id: input.callings_sheet_id ?? '',
        stake_seat_cap: input.stake_seat_cap,
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });
}

export interface BuildingInput {
  building_name: string;
  address: string;
}

export function useAddBuildingMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BuildingInput) => {
      const actor = actorOf(principal);
      const slug = buildingSlug(input.building_name);
      if (!slug) throw new Error('Building name is required.');
      await setDoc(buildingRef(db, STAKE_ID, slug), {
        building_id: slug,
        building_name: input.building_name.trim(),
        address: input.address.trim(),
        created_at: serverTimestamp(),
        last_modified_at: serverTimestamp(),
        lastActor: actor,
      } as unknown as Building);
    },
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });
}

// Block deletes when any ward references the building by name. Wards
// FK on `building_name` (per firebase-schema.md §4) — orphaning a ward
// silently breaks its building lookup. Firestore Security Rules can't
// iterate a sibling collection so we cannot enforce this at the rules
// layer; this client guard is the only line of defense (documented in
// docs/firebase-migration.md as a known gap).
export interface DeleteBuildingInput {
  buildingId: string;
  buildingName: string;
}
export function useDeleteBuildingMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteBuildingInput) => {
      const snap = await getDocs(
        query(wardsCol(db, STAKE_ID), where('building_name', '==', input.buildingName)),
      );
      const refs = snap.docs.map((d) => d.data() as Ward);
      const blocker = buildingDeleteBlocker(refs);
      if (blocker) throw new Error(blocker);
      await deleteDoc(buildingRef(db, STAKE_ID, input.buildingId));
    },
    onSuccess: () => {
      qc.invalidateQueries();
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WardInput) => {
      const actor = actorOf(principal);
      const code = input.ward_code.trim().toUpperCase();
      if (!code) throw new Error('Ward code is required.');
      await setDoc(wardRef(db, STAKE_ID, code), {
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
      qc.invalidateQueries();
    },
  });
}

export function useDeleteWardMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (wardCode: string) => {
      await deleteDoc(wardRef(db, STAKE_ID, wardCode));
    },
    onSuccess: () => {
      qc.invalidateQueries();
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManagerInput) => {
      const actor = actorOf(principal);
      const canonical = canonicalEmail(input.member_email);
      await setDoc(kindooManagerRef(db, STAKE_ID, canonical), {
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
      qc.invalidateQueries();
    },
  });
}

export function useUpdateManagerActiveMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { canonical: string; active: boolean }) => {
      const actor = actorOf(principal);
      await updateDoc(kindooManagerRef(db, STAKE_ID, input.canonical), {
        active: input.active,
        lastActor: actor,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });
}

export function useDeleteManagerMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (canonical: string) => {
      await deleteDoc(kindooManagerRef(db, STAKE_ID, canonical));
    },
    onSuccess: () => {
      qc.invalidateQueries();
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
  return useMutation({
    mutationFn: async (bootstrapAdminEmail: string) => {
      const actor = actorOf(principal);
      const canonical = canonicalEmail(bootstrapAdminEmail);
      await setDoc(
        kindooManagerRef(db, STAKE_ID, canonical),
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
 * the `lastActor` integrity field. Phase 8's `installScheduledJobs`
 * callable will be invoked in addition by the page wrapper; this
 * mutation only owns the Firestore flip.
 */
export function useCompleteSetupMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const actor = actorOf(principal);
      await updateDoc(stakeRef(db, STAKE_ID), {
        setup_complete: true,
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });
}
