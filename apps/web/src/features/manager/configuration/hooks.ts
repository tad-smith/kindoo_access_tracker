// Manager Configuration data hooks. Each tab subscribes live to its
// underlying collection and exposes a CRUD mutation for the writes
// allowed by the rules at this layer (manager-only, integrity-checked).
//
// The shape mirrors `features/bootstrap/hooks.ts` but expects the user
// to already hold the manager claim (so reads + writes pass without the
// "bootstrap admin" escape hatch). Schema field defaults that the
// bootstrap wizard fills in but Configuration also exposes are wired
// here too — e.g., expiry_hour / timezone.

import {
  deleteDoc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { canonicalEmail, buildingSlug } from '@kindoo/shared';
import type { Building, KindooManager, KindooSite, Stake, Ward } from '@kindoo/shared';
import { useFirestoreCollection, useFirestoreDoc } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import {
  buildingRef,
  buildingsCol,
  kindooManagerRef,
  kindooManagersCol,
  kindooSiteRef,
  kindooSitesCol,
  stakeRef,
  wardRef,
  wardsCol,
} from '../../../lib/docs';
import { useActiveStake } from '../../../lib/useActiveStake';
import { usePrincipal } from '../../../lib/principal';
import type { Principal } from '../../../lib/principal';

// ---- Live reads -----------------------------------------------------

export function useStakeDoc() {
  const activeStakeId = useActiveStake();
  const ref = useMemo(() => (activeStakeId ? stakeRef(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreDoc<Stake>(ref);
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

export function useManagers() {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () => (activeStakeId ? kindooManagersCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<KindooManager>(q);
}

export function useKindooSites() {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () => (activeStakeId ? kindooSitesCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<KindooSite>(q);
}

// ---- Helper ---------------------------------------------------------

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

// ---- Wards mutations ------------------------------------------------

export interface WardInput {
  ward_code: string;
  ward_name: string;
  building_name: string;
  seat_cap: number;
}

export function useUpsertWardMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WardInput) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      const code = input.ward_code.trim().toUpperCase();
      if (!code) throw new Error('Ward code is required.');
      const ref = wardRef(db, sid, code);
      // Stamp `created_at` only on the create path. `merge: true` would
      // otherwise re-stamp it on every edit, silently losing the
      // original creation timestamp. `runTransaction` makes the
      // existence read + write atomic, so the create/edit branch
      // decision can't race itself within this transaction.
      await runTransaction(db, async (tx) => {
        const existing = await tx.get(ref);
        const editBody = {
          ward_code: code,
          ward_name: input.ward_name.trim(),
          building_name: input.building_name,
          seat_cap: input.seat_cap,
          last_modified_at: serverTimestamp(),
          lastActor: actor,
        };
        if (existing.exists()) {
          tx.set(ref, editBody as unknown as Ward, { merge: true });
        } else {
          tx.set(
            ref,
            {
              ...editBody,
              created_at: serverTimestamp(),
            } as unknown as Ward,
            { merge: true },
          );
        }
      });
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn,
      // so awaiting invalidateQueries would hang the mutation.
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
  /**
   * Kindoo Sites — `null` (or absent) means the home site; a string
   * value points at a doc id under `stakes/{stakeId}/kindooSites/`.
   * Always pass an explicit value (including `null`) so that toggling
   * a building back to home overwrites a prior foreign-site assignment.
   */
  kindoo_site_id?: string | null;
}

export function useUpsertBuildingMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BuildingInput) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      const slug = buildingSlug(input.building_name);
      if (!slug) throw new Error('Building name is required.');
      const ref = buildingRef(db, sid, slug);
      // Stamp `created_at` only on the create path. `merge: true` would
      // otherwise re-stamp it on every edit, silently losing the
      // original creation timestamp. `runTransaction` makes the
      // existence read + write atomic, so the create/edit branch
      // decision can't race itself within this transaction.
      await runTransaction(db, async (tx) => {
        const existing = await tx.get(ref);
        const editBody = {
          building_id: slug,
          building_name: input.building_name.trim(),
          address: input.address.trim(),
          kindoo_site_id: input.kindoo_site_id ?? null,
          last_modified_at: serverTimestamp(),
          lastActor: actor,
        };
        if (existing.exists()) {
          tx.set(ref, editBody as unknown as Building, { merge: true });
        } else {
          tx.set(
            ref,
            {
              ...editBody,
              created_at: serverTimestamp(),
            } as unknown as Building,
            { merge: true },
          );
        }
      });
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
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManagerInput) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      const can = canonicalEmail(input.member_email);
      const ref = kindooManagerRef(db, sid, can);
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
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (canonical: string) => {
      const sid = requireActiveStake(activeStakeId);
      await deleteDoc(kindooManagerRef(db, sid, canonical));
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
  stake_seat_cap: number;
  expiry_hour: number;
  timezone: string;
  notifications_enabled: boolean;
}

export function useUpdateStakeConfigMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfigInput) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      await updateDoc(stakeRef(db, sid), {
        stake_name: input.stake_name,
        stake_seat_cap: input.stake_seat_cap,
        expiry_hour: input.expiry_hour,
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

// ---- Kindoo Sites mutations -----------------------------------------
//
// Foreign Kindoo sites this stake's managers write to. Add / edit / delete.
// The home site is implicit on the parent stake doc — no `KindooSite` doc
// represents it; the UI surfaces "Home" as the default dropdown option.
//
// Slug strategy: derive from `display_name` via `buildingSlug()` at
// create time and pin the slug for the doc's life. Editing the
// display_name does NOT re-slug — keeping the doc id stable preserves
// the foreign-key string stored on wards / buildings. Rejects empty
// slugs (sanitised display_name with no usable characters).

// `kindoo_eid` is intentionally NOT a manager-supplied field — the
// extension discovers it from `localStorage.state.sites.ids[0]` on a
// session logged into the site and writes it on first use (Phase 3).
// The merge-write below leaves any existing `kindoo_eid` untouched.
export interface KindooSiteInput {
  display_name: string;
  kindoo_expected_site_name: string;
}

export function useUpsertKindooSiteMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: KindooSiteInput & { id?: string }) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      const displayName = input.display_name.trim();
      const expectedSiteName = input.kindoo_expected_site_name.trim();
      const slug = input.id ?? buildingSlug(displayName);
      if (!slug) throw new Error('Display name is required.');
      const ref = kindooSiteRef(db, sid, slug);
      // `created_at` is stamped only on the create path. `merge: true`
      // would otherwise re-stamp it on every edit, silently losing the
      // original creation timestamp.
      const editBody = {
        id: slug,
        display_name: displayName,
        kindoo_expected_site_name: expectedSiteName,
        last_modified_at: serverTimestamp(),
        lastActor: actor,
      };
      // Both branches wrap the read + write in one transaction.
      // Create path: pre-check guards against two concurrent creates
      // with the same slug both passing and clobbering. Edit path:
      // pre-check guards against `merge: true` resurrecting a doc
      // another tab just deleted (which would re-stamp `created_at`
      // and `lastActor` on a tombstoned site).
      if (input.id) {
        await runTransaction(db, async (tx) => {
          const existing = await tx.get(ref);
          if (!existing.exists()) {
            throw new Error('Kindoo site no longer exists.');
          }
          tx.set(ref, editBody as unknown as KindooSite, { merge: true });
        });
      } else {
        await runTransaction(db, async (tx) => {
          const existing = await tx.get(ref);
          if (existing.exists()) {
            throw new Error('A Kindoo site with that display name already exists.');
          }
          tx.set(
            ref,
            {
              ...editBody,
              created_at: serverTimestamp(),
            } as unknown as KindooSite,
            { merge: true },
          );
        });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

// Block deletes when any building still references this site. Only
// buildings carry `kindoo_site_id`; a ward's site is derived from its
// building, so the building guard transitively covers wards. Orphaning
// a building silently severs the foreign-key string without a server-
// rules check (rules don't iterate sibling collections; field-level FK
// is the UI's concern per firebase-schema.md §4.11). Caller passes the
// live buildings snapshot so the guard fires against the exact rows the
// operator just saw — no extra Firestore read.
export interface DeleteKindooSiteInput {
  kindooSiteId: string;
  buildings: ReadonlyArray<Building>;
}
export function useDeleteKindooSiteMutation() {
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteKindooSiteInput) => {
      const sid = requireActiveStake(activeStakeId);
      const buildingRefs = input.buildings.filter((b) => b.kindoo_site_id === input.kindooSiteId);
      const blocker = kindooSiteDeleteBlocker(input.kindooSiteId, buildingRefs);
      if (blocker) throw new Error(blocker);
      await deleteDoc(kindooSiteRef(db, sid, input.kindooSiteId));
    },
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

/**
 * Pure guard helper — symmetric with `buildingDeleteBlocker`. Returns
 * null when no building still points at the site; otherwise a
 * human-readable message listing the blocking buildings.
 */
export function kindooSiteDeleteBlocker(
  kindooSiteId: string,
  referencingBuildings: ReadonlyArray<Building>,
): string | null {
  if (referencingBuildings.length === 0) return null;
  const labels = referencingBuildings.map((b) => b.building_name);
  return (
    `Cannot delete Kindoo site "${kindooSiteId}". The following buildings still reference ` +
    `this site: ${labels.join(', ')} Unassign these buildings from this site before deleting.`
  );
}
