// Manager Configuration data hooks. Each tab subscribes live to its
// underlying collection and exposes a CRUD mutation for the writes
// allowed by the rules at this layer (manager-only, integrity-checked).
//
// The shape mirrors `features/bootstrap/hooks.ts` but expects the user
// to already hold the manager claim (so reads + writes pass without the
// "bootstrap admin" escape hatch). Schema field defaults that the
// bootstrap wizard fills in but Configuration also exposes are wired
// here too — e.g., expiry_hour / import_day / import_hour / timezone.

import {
  deleteDoc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
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
// existing `active=false` set by a prior deactivate. Activate/
// deactivate is a separate Configuration-level mutation.
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
  auto_kindoo_access: boolean;
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
          auto_kindoo_access: input.auto_kindoo_access,
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
          auto_kindoo_access: input.auto_kindoo_access,
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

// ---- Calling-template reorder + add-at-end + delete-resequence ------
//
// The Auto Callings tabs render a sortable table: lower `sheet_order`
// renders higher. Three additional mutations shape the field:
//
// - `useReorder*Mutation` — write a new contiguous ordering across N
//   rows. Atomic via Firestore `writeBatch`. Caller passes the
//   already-reordered list of `calling_name` values; the mutation
//   assigns 1..N. Optimistic update + rollback live on the caller via
//   the standard TanStack `onMutate`/`onError` pattern.
// - `useAdd*CallingTemplateMutation` — append a new row at
//   `sheet_order = max(existing)+1`. Caller does not pass
//   `sheet_order`; the hook reads the live cache through the passed
//   `existing` array. Edits use the existing upsert mutation.
// - `useDelete*WithResequenceMutation` — delete the row, then rewrite
//   the remaining rows to 1..N-1 contiguous. One batch.
//
// Reorders touch only changed rows when possible; the helper
// `assignSheetOrders` returns the {ref, sheet_order} writes that
// actually differ from the current list.

export interface ReorderInput {
  /**
   * The full ordered list of calling_names AFTER the reorder. Index 0
   * gets sheet_order 1, index 1 gets 2, etc.
   */
  orderedCallingNames: string[];
  /**
   * The current list AS THE OPERATOR SAW IT — used to skip writes for
   * rows whose position didn't change.
   */
  current: ReadonlyArray<{ calling_name: string; sheet_order: number }>;
}

function buildReorderBatch(
  refForName: (name: string) => ReturnType<typeof wardCallingTemplateRef>,
  input: ReorderInput,
  actor: { email: string; canonical: string },
) {
  const writes = planReorderWrites(input.orderedCallingNames, input.current);
  const batch = writeBatch(db);
  for (const w of writes) {
    batch.set(
      refForName(w.calling_name),
      { sheet_order: w.sheet_order, lastActor: actor },
      { merge: true },
    );
  }
  return { batch, writes: writes.length };
}

export function useReorderWardCallingTemplatesMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReorderInput) => {
      const actor = actorOf(principal);
      const { batch, writes } = buildReorderBatch(
        (name) => wardCallingTemplateRef(db, STAKE_ID, name),
        input,
        actor,
      );
      if (writes === 0) return;
      await batch.commit();
    },
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

export function useReorderStakeCallingTemplatesMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReorderInput) => {
      const actor = actorOf(principal);
      const { batch, writes } = buildReorderBatch(
        (name) => stakeCallingTemplateRef(db, STAKE_ID, name),
        input,
        actor,
      );
      if (writes === 0) return;
      await batch.commit();
    },
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

export interface AddCallingTemplateInput {
  calling_name: string;
  give_app_access: boolean;
  auto_kindoo_access: boolean;
  /**
   * The current list — the new row gets `max(existing.sheet_order) + 1`.
   * Pass the caller's already-subscribed live snapshot so the mutation
   * doesn't issue an extra read.
   */
  existing: ReadonlyArray<{ sheet_order: number }>;
}

export function nextSheetOrder(existing: ReadonlyArray<{ sheet_order: number }>): number {
  let max = 0;
  for (const e of existing) if (e.sheet_order > max) max = e.sheet_order;
  return max + 1;
}

/**
 * Pure planner: given a current ordered list and a desired ordered list
 * of names, return the {calling_name, sheet_order} pairs that need to
 * be written to make the desired order contiguous 1..N. Skips rows
 * whose new order matches the current order.
 *
 * Exposed for testing; the reorder mutations build the same thing
 * internally and feed a Firestore writeBatch.
 */
export function planReorderWrites(
  orderedCallingNames: ReadonlyArray<string>,
  current: ReadonlyArray<{ calling_name: string; sheet_order: number }>,
): Array<{ calling_name: string; sheet_order: number }> {
  const currentByName = new Map(current.map((c) => [c.calling_name, c.sheet_order]));
  const writes: Array<{ calling_name: string; sheet_order: number }> = [];
  for (let i = 0; i < orderedCallingNames.length; i++) {
    const name = orderedCallingNames[i]!;
    const newOrder = i + 1;
    if (currentByName.get(name) === newOrder) continue;
    writes.push({ calling_name: name, sheet_order: newOrder });
  }
  return writes;
}

/**
 * Pure planner: given a current list and a name to delete, return the
 * {calling_name, sheet_order} writes that renumber the survivors to
 * 1..N-1 contiguous. Excludes the deleted row from the writes list
 * (caller emits a separate delete for that doc).
 */
export function planDeleteResequenceWrites(
  callingName: string,
  current: ReadonlyArray<{ calling_name: string; sheet_order: number }>,
): Array<{ calling_name: string; sheet_order: number }> {
  const remaining = [...current]
    .filter((c) => c.calling_name !== callingName)
    .sort((a, b) => a.sheet_order - b.sheet_order);
  const writes: Array<{ calling_name: string; sheet_order: number }> = [];
  for (let i = 0; i < remaining.length; i++) {
    const expected = i + 1;
    const row = remaining[i]!;
    if (row.sheet_order === expected) continue;
    writes.push({ calling_name: row.calling_name, sheet_order: expected });
  }
  return writes;
}

export function useAddWardCallingTemplateMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddCallingTemplateInput) => {
      const actor = actorOf(principal);
      const name = input.calling_name.trim();
      if (!name) throw new Error('Calling name is required.');
      const ref = wardCallingTemplateRef(db, STAKE_ID, name);
      const existing = await getDoc(ref);
      if (existing.exists()) throw new Error('A calling with that name already exists.');
      await setDoc(
        ref,
        {
          calling_name: name,
          give_app_access: input.give_app_access,
          auto_kindoo_access: input.auto_kindoo_access,
          sheet_order: nextSheetOrder(input.existing),
          created_at: serverTimestamp(),
          lastActor: actor,
        } as unknown as WardCallingTemplate,
        { merge: true },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

export function useAddStakeCallingTemplateMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddCallingTemplateInput) => {
      const actor = actorOf(principal);
      const name = input.calling_name.trim();
      if (!name) throw new Error('Calling name is required.');
      const ref = stakeCallingTemplateRef(db, STAKE_ID, name);
      const existing = await getDoc(ref);
      if (existing.exists()) throw new Error('A calling with that name already exists.');
      await setDoc(
        ref,
        {
          calling_name: name,
          give_app_access: input.give_app_access,
          auto_kindoo_access: input.auto_kindoo_access,
          sheet_order: nextSheetOrder(input.existing),
          created_at: serverTimestamp(),
          lastActor: actor,
        } as unknown as StakeCallingTemplate,
        { merge: true },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

export interface DeleteWithResequenceInput {
  callingName: string;
  /** Current ordered list (any order). The remaining rows are renumbered 1..N-1. */
  current: ReadonlyArray<{ calling_name: string; sheet_order: number }>;
}

function buildDeleteWithResequenceBatch(
  refForName: (name: string) => ReturnType<typeof wardCallingTemplateRef>,
  input: DeleteWithResequenceInput,
  actor: { email: string; canonical: string },
) {
  const batch = writeBatch(db);
  batch.delete(refForName(input.callingName));
  const writes = planDeleteResequenceWrites(input.callingName, input.current);
  for (const w of writes) {
    batch.set(
      refForName(w.calling_name),
      { sheet_order: w.sheet_order, lastActor: actor },
      { merge: true },
    );
  }
  return batch;
}

export function useDeleteWardCallingTemplateWithResequenceMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteWithResequenceInput) => {
      const actor = actorOf(principal);
      const batch = buildDeleteWithResequenceBatch(
        (name) => wardCallingTemplateRef(db, STAKE_ID, name),
        input,
        actor,
      );
      await batch.commit();
    },
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

export function useDeleteStakeCallingTemplateWithResequenceMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteWithResequenceInput) => {
      const actor = actorOf(principal);
      const batch = buildDeleteWithResequenceBatch(
        (name) => stakeCallingTemplateRef(db, STAKE_ID, name),
        input,
        actor,
      );
      await batch.commit();
    },
    onSuccess: () => {
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
