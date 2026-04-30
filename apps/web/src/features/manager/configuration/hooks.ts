// Manager Configuration data hooks. Each tab subscribes live to its
// underlying collection and exposes a CRUD mutation for the writes
// allowed by the rules at this layer (manager-only, integrity-checked).
//
// The shape mirrors `features/bootstrap/hooks.ts` but expects the user
// to already hold the manager claim (so reads + writes pass without the
// "bootstrap admin" escape hatch). Schema field defaults that the
// bootstrap wizard fills in but Configuration also exposes are wired
// here too — e.g., expiry_hour / import_day / import_hour / timezone.

import { deleteDoc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { canonicalEmail, buildingSlug } from '@kindoo/shared';
import type {
  Building,
  ImportDay,
  KindooManager,
  Stake,
  Ward,
  WardCallingTemplate,
  StakeCallingTemplate,
} from '@kindoo/shared';
import { useFirestoreCollection, useFirestoreDoc } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import {
  buildingRef,
  buildingsCol,
  kindooManagerRef,
  kindooManagersCol,
  stakeCallingTemplateRef,
  stakeCallingTemplatesCol,
  stakeRef,
  wardCallingTemplateRef,
  wardCallingTemplatesCol,
  wardRef,
  wardsCol,
} from '../../../lib/docs';
import { STAKE_ID } from '../../../lib/constants';
import { usePrincipal } from '../../../lib/principal';
import type { Principal } from '../../../lib/principal';

// ---- Live reads -----------------------------------------------------

export function useStakeDoc() {
  const ref = useMemo(() => stakeRef(db, STAKE_ID), []);
  return useFirestoreDoc<Stake>(ref);
}

export function useWards() {
  const q = useMemo(() => wardsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Ward>(q);
}

export function useBuildings() {
  const q = useMemo(() => buildingsCol(db, STAKE_ID), []);
  return useFirestoreCollection<Building>(q);
}

export function useManagers() {
  const q = useMemo(() => kindooManagersCol(db, STAKE_ID), []);
  return useFirestoreCollection<KindooManager>(q);
}

export function useWardCallingTemplates() {
  const q = useMemo(() => wardCallingTemplatesCol(db, STAKE_ID), []);
  return useFirestoreCollection<WardCallingTemplate>(q);
}

export function useStakeCallingTemplates() {
  const q = useMemo(() => stakeCallingTemplatesCol(db, STAKE_ID), []);
  return useFirestoreCollection<StakeCallingTemplate>(q);
}

// ---- Helper ---------------------------------------------------------

function actorOf(principal: Principal): { email: string; canonical: string } {
  return {
    email: principal.email ?? '',
    canonical: principal.canonical ?? canonicalEmail(principal.email ?? ''),
  };
}

// ---- Wards mutations ------------------------------------------------

export interface WardInput {
  ward_code: string;
  ward_name: string;
  building_name: string;
  seat_cap: number;
}

export function useUpsertWardMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WardInput) => {
      const actor = actorOf(principal);
      const code = input.ward_code.trim().toUpperCase();
      if (!code) throw new Error('Ward code is required.');
      await setDoc(
        wardRef(db, STAKE_ID, code),
        {
          ward_code: code,
          ward_name: input.ward_name.trim(),
          building_name: input.building_name,
          seat_cap: input.seat_cap,
          created_at: serverTimestamp(),
          last_modified_at: serverTimestamp(),
          lastActor: actor,
        } as unknown as Ward,
        { merge: true },
      );
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
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
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

// ---- Buildings mutations --------------------------------------------

export interface BuildingInput {
  building_name: string;
  address: string;
}

export function useUpsertBuildingMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BuildingInput) => {
      const actor = actorOf(principal);
      const slug = buildingSlug(input.building_name);
      if (!slug) throw new Error('Building name is required.');
      await setDoc(
        buildingRef(db, STAKE_ID, slug),
        {
          building_id: slug,
          building_name: input.building_name.trim(),
          address: input.address.trim(),
          created_at: serverTimestamp(),
          last_modified_at: serverTimestamp(),
          lastActor: actor,
        } as unknown as Building,
        { merge: true },
      );
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

// Block deletes when any ward references the building by name. Wards
// FK on `building_name` (per firebase-schema.md §4) — orphaning a ward
// silently breaks its building lookup. Firestore Security Rules can't
// iterate a sibling collection, so this guard is client-side only
// (documented gap in docs/firebase-migration.md).
//
// Caller passes the wards snapshot (already subscribed via useWards) so
// the guard fires against the exact list the user just saw — no extra
// Firestore read.
export interface DeleteBuildingInput {
  buildingId: string;
  buildingName: string;
  wards: ReadonlyArray<Ward>;
}
export function useDeleteBuildingMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteBuildingInput) => {
      const refs = input.wards.filter((w) => w.building_name === input.buildingName);
      const blocker = buildingDeleteBlocker(refs);
      if (blocker) throw new Error(blocker);
      await deleteDoc(buildingRef(db, STAKE_ID, input.buildingId));
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

/** Pure guard helper — see bootstrap/hooks.ts for rationale. */
export function buildingDeleteBlocker(referencingWards: ReadonlyArray<Ward>): string | null {
  if (referencingWards.length === 0) return null;
  const labels = referencingWards.map((w) => `${w.ward_name} (${w.ward_code})`);
  return `Cannot delete: referenced by ${labels.length} ward(s) — ${labels.join(', ')}`;
}

// ---- Managers mutations ---------------------------------------------

export interface ManagerInput {
  member_email: string;
  name: string;
}

// New managers default to active. The merge: true preserves any
// existing `active=false` set by a prior deactivate. Activate/deactivate
// is a separate Configuration-level mutation (Phase 8 candidate).
//
// Pre-check: refuse the add when a doc with the same canonical email
// already exists. The doc-id keyed by canonical guarantees Firestore-
// layer dedup (a re-add merges into the same doc), but the user-facing
// UX is friendlier when the form yields an explicit "Already a
// manager." error than a silent merge that looks like a no-op.
export function useUpsertManagerMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManagerInput) => {
      const actor = actorOf(principal);
      const can = canonicalEmail(input.member_email);
      const ref = kindooManagerRef(db, STAKE_ID, can);
      const existing = await getDoc(ref);
      if (existing.exists()) {
        throw new Error('Already a manager.');
      }
      await setDoc(
        ref,
        {
          member_canonical: can,
          member_email: input.member_email.trim(),
          name: input.name.trim(),
          active: true,
          added_at: serverTimestamp(),
          added_by: actor,
          lastActor: actor,
        } as unknown as KindooManager,
        { merge: true },
      );
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
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
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

// ---- Calling-template mutations -------------------------------------

export interface CallingTemplateInput {
  calling_name: string;
  give_app_access: boolean;
  sheet_order: number;
}

export function useUpsertWardCallingTemplateMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CallingTemplateInput) => {
      const actor = actorOf(principal);
      const name = input.calling_name.trim();
      if (!name) throw new Error('Calling name is required.');
      await setDoc(
        wardCallingTemplateRef(db, STAKE_ID, name),
        {
          calling_name: name,
          give_app_access: input.give_app_access,
          sheet_order: input.sheet_order,
          created_at: serverTimestamp(),
          lastActor: actor,
        } as unknown as WardCallingTemplate,
        { merge: true },
      );
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

export function useDeleteWardCallingTemplateMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (callingName: string) => {
      await deleteDoc(wardCallingTemplateRef(db, STAKE_ID, callingName));
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

export function useUpsertStakeCallingTemplateMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CallingTemplateInput) => {
      const actor = actorOf(principal);
      const name = input.calling_name.trim();
      if (!name) throw new Error('Calling name is required.');
      await setDoc(
        stakeCallingTemplateRef(db, STAKE_ID, name),
        {
          calling_name: name,
          give_app_access: input.give_app_access,
          sheet_order: input.sheet_order,
          created_at: serverTimestamp(),
          lastActor: actor,
        } as unknown as StakeCallingTemplate,
        { merge: true },
      );
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

export function useDeleteStakeCallingTemplateMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (callingName: string) => {
      await deleteDoc(stakeCallingTemplateRef(db, STAKE_ID, callingName));
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

// ---- Stake-doc / Config-keys mutation -------------------------------

export interface ConfigInput {
  stake_name: string;
  callings_sheet_id?: string | undefined;
  stake_seat_cap: number;
  expiry_hour: number;
  import_day: ImportDay;
  import_hour: number;
  timezone: string;
  notifications_enabled: boolean;
}

export function useUpdateStakeConfigMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfigInput) => {
      const actor = actorOf(principal);
      await updateDoc(stakeRef(db, STAKE_ID), {
        stake_name: input.stake_name,
        callings_sheet_id: input.callings_sheet_id ?? '',
        stake_seat_cap: input.stake_seat_cap,
        expiry_hour: input.expiry_hour,
        import_day: input.import_day,
        import_hour: input.import_hour,
        timezone: input.timezone,
        notifications_enabled: input.notifications_enabled,
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      });
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}
