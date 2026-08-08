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

import { deleteDoc, runTransaction, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { canonicalEmail, buildingSlug } from '@kindoo/shared';
import type { Building, CustomClaims, KindooManager, Stake, Ward } from '@kindoo/shared';
import { refreshIdToken } from '../auth/useTokenRefresh';
import { useFirestoreCollection, useFirestoreDoc } from '../../lib/data';
import { auth, db } from '../../lib/firebase';
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
  eq_president_app_access: boolean;
}

/**
 * Step 1 — write stake-level config fields. The stake doc is created
 * by the platform superadmin via `createStake` callable; the wizard
 * only updates it. Defaults for `timezone` / `notifications_enabled`
 * are seeded by `createStake` (or assumed already present); we only
 * touch what the wizard exposes.
 *
 * `eq_president_app_access` is the one config toggle the wizard does
 * expose, so a stake can opt in before its first Sync run. No backfill
 * dialog follows the write here (unlike the Configuration page's Config
 * tab) — a stake still in setup has no existing seats to reconcile.
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
        eq_president_app_access: input.eq_president_app_access,
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
  /**
   * Live buildings snapshot for the unique-display-name guard. Building
   * display names must be unique across the stake (the slug FK and every
   * grant-array display name key off them). The wizard's Step 2 already
   * subscribes to `buildings`; it passes the snapshot it just rendered
   * so the guard fires without an extra read. Defaults to `[]` so an
   * un-hydrated caller is treated as "no known buildings" (the create
   * transaction's existence pre-check is the backstop).
   */
  existingBuildings?: ReadonlyArray<Building>;
}

/**
 * Pure guard: returns a user-facing error message when another building
 * (a different `building_id`) already uses `name`, or `null` when the
 * name is free. Case-insensitive, trimmed. Mirrors the Configuration
 * page's `duplicateBuildingNameBlocker`; duplicated here rather than
 * imported to respect the feature boundary (bootstrap must not reach
 * into manager/configuration internals).
 */
export function duplicateBuildingNameBlocker(
  name: string,
  buildings: ReadonlyArray<Building>,
): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const clash = buildings.find((b) => b.building_name.trim().toLowerCase() === wanted);
  if (!clash) return null;
  return `Another building already uses the name "${clash.building_name}". Building names must be unique.`;
}

export function useAddBuildingMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BuildingInput) => {
      const sid = requireActiveStake(activeStakeId);
      const actor = actorOf(principal);
      const name = input.building_name.trim();
      // CREATE derives the immutable slug once from the name and pins it
      // as the doc id; it is never re-derived afterward (matches the
      // Configuration building mutation).
      const slug = buildingSlug(name);
      if (!slug) throw new Error('Building name is required.');
      // Unique display name — blocks two buildings sharing a name (the
      // legacy `building_name` FK + grant-array display names would
      // otherwise be ambiguous). Same guard the Configuration path runs.
      const dupBlocker = duplicateBuildingNameBlocker(name, input.existingBuildings ?? []);
      if (dupBlocker) throw new Error(dupBlocker);
      const ref = buildingRef(db, sid, slug);
      // Race-safe create: the existence pre-check + write run in one
      // transaction so a duplicate name that slugs to an EXISTING doc
      // can't silently overwrite it (the old `setDoc` without `merge`
      // clobbered the original — resetting `created_at` and wiping
      // fields). A slug collision now surfaces an explicit error.
      await runTransaction(db, async (tx) => {
        const existing = await tx.get(ref);
        if (existing.exists()) {
          throw new Error(`A building named "${input.building_name.trim()}" already exists.`);
        }
        tx.set(ref, {
          building_id: slug,
          building_name: name,
          address: input.address.trim(),
          created_at: serverTimestamp(),
          last_modified_at: serverTimestamp(),
          lastActor: actor,
        } as unknown as Building);
      });
    },
    onSuccess: () => {
      // Fire-and-forget; live hooks have a never-resolving queryFn so
      // awaiting invalidateQueries would hang the mutation.
      void qc.invalidateQueries();
    },
  });
}

// Block deletes when any ward references the building. Wards FK on the
// immutable `building_id` slug (preferred) plus the legacy
// `building_name`; the guard matches on EITHER during the transition.
// Orphaning a ward silently breaks its building lookup. Firestore
// Security Rules can't iterate a sibling collection so we cannot enforce
// this at the rules layer; this client guard is the only line of defense
// (documented in docs/firebase-migration.md as a known gap).
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
      const refs = input.wards.filter(
        (w) => w.building_id === input.buildingId || w.building_name === input.buildingName,
      );
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
  const labels = referencingWards.map((w) => w.ward_name);
  return `Cannot delete: referenced by ${labels.length} ward(s) — ${labels.join(', ')}`;
}

export interface WardInput {
  ward_name: string;
  /** Immutable slug FK to the selected building (preferred). */
  building_id: string;
  /** The selected building's current display name; written alongside
   *  `building_id` so stale browser bundles keep resolving. */
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
      const name = input.ward_name.trim();
      // Derive the immutable doc id from the name; the code is never a
      // user input and never re-derived afterward.
      const code = buildingSlug(name);
      if (!code) throw new Error('Ward name is required.');
      const ref = wardRef(db, sid, code);
      // Race-safe create: the ward name is the only visible identifier, so
      // a name that slugs to an EXISTING ward is rejected rather than
      // silently overwriting it. The existence read + write run in one
      // transaction so two concurrent adds can't both pass.
      await runTransaction(db, async (tx) => {
        const existing = await tx.get(ref);
        if (existing.exists()) {
          throw new Error(`A ward named "${name}" already exists.`);
        }
        tx.set(ref, {
          ward_code: code,
          ward_name: name,
          // Write BOTH: id-first FK + legacy name snapshot.
          building_id: input.building_id,
          building_name: input.building_name,
          seat_cap: input.seat_cap,
          created_at: serverTimestamp(),
          last_modified_at: serverTimestamp(),
          lastActor: actor,
        } as unknown as Ward);
      });
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
 * The `kindooManagers/{canonical}` upsert that gives `syncManagersClaims`
 * something to mint the bootstrap admin's `manager` claim from.
 * Idempotent via `merge: true` — safe to re-issue any number of times;
 * fields not listed here (there are none yet, but a future one) survive
 * a re-issue untouched, while every field listed here (including
 * `active: true`) is reasserted on every call. Shared by
 * `useEnsureBootstrapAdmin` (the wizard-mount auto-add) and
 * `useCompleteSetupMutation`'s fail-closed retry path below — both need
 * byte-identical write shape so re-issuing from either call site targets
 * the same doc the same way.
 */
async function writeBootstrapAdminManagerDoc(
  sid: string,
  bootstrapAdminEmail: string,
  principalEmail: string,
  actor: { email: string; canonical: string },
): Promise<void> {
  const canonical = canonicalEmail(bootstrapAdminEmail);
  await setDoc(
    kindooManagerRef(db, sid, canonical),
    {
      member_canonical: canonical,
      member_email: bootstrapAdminEmail,
      name: principalEmail ?? bootstrapAdminEmail,
      active: true,
      added_at: serverTimestamp(),
      added_by: actor,
      lastActor: actor,
    } as unknown as KindooManager,
    { merge: true },
  );
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
      await writeBootstrapAdminManagerDoc(sid, bootstrapAdminEmail, principal.email, actor);
    },
  });
}

// Same bound as `pollForCanonicalClaim` (`features/auth/signIn.ts`,
// added for B-4): 10 iterations at 500ms apart caps the wait at ~5s.
const CLAIM_POLL_ITERATIONS = 10;
const CLAIM_POLL_INTERVAL_MS = 500;

/**
 * Mirrors the `/stakes/{stakeId}` read predicate `firestore.rules`
 * actually enforces once `setup_complete` flips true. Pre-flip, the read
 * is additionally covered by `isBootstrapAdmin(stakeId)` and
 * `isSetupInProgressReadable(stakeId)` — but both of those are gated on
 * `setup_complete == false`, so the instant this mutation's `updateDoc`
 * lands they evaluate false forever. What survives is exactly:
 *
 *   isAnyMember(stakeId) || isPlatformSuperadmin()
 *
 * and `isAnyMember` is `isManager || isStakeMember ||
 * bishopricWardOf(stakeId).size() > 0` — i.e. `manager` claim OR `stake`
 * claim OR a non-empty `wards` list on this stake. Checking only
 * `manager` (as the previous fix did) is narrower than the rule: a
 * platform superadmin, or a principal who only holds a stake-level or
 * ward-level (bishopric) claim on this stake, would pass the rule but
 * get blocked by the gate. This checks the same four disjuncts the rule
 * does.
 */
function canReadStakeDocPostFlip(claims: CustomClaims | undefined, stakeId: string): boolean {
  if (!claims) return false;
  if (claims.isPlatformSuperadmin === true) return true;
  const stakeClaims = claims.stakes?.[stakeId];
  if (!stakeClaims) return false;
  return (
    stakeClaims.manager === true ||
    stakeClaims.stake === true ||
    (stakeClaims.wards?.length ?? 0) > 0
  );
}

/**
 * Bounded wait for the post-flip stake-doc read to become satisfiable on
 * the signed-in admin's cached ID token — see `canReadStakeDocPostFlip`
 * for exactly which claim shapes qualify. Same shape as
 * `pollForCanonicalClaim`: force-refresh, check the decoded claims, and
 * if nothing qualifying is there yet, sleep and refresh again — up to
 * `CLAIM_POLL_ITERATIONS` times.
 *
 * Diverges from `pollForCanonicalClaim` in outcome, not shape: that
 * helper always resolves — a downstream page handles a permanently
 * missing claim. This one backs a fail-closed gate ahead of an
 * irreversible write (see `useCompleteSetupMutation` below), so it
 * reports whether a qualifying claim actually landed rather than
 * silently carrying on either way.
 */
async function waitForPostFlipStakeAccess(stakeId: string): Promise<boolean> {
  await refreshIdToken();
  for (let i = 0; i < CLAIM_POLL_ITERATIONS; i++) {
    const result = await auth.currentUser?.getIdTokenResult();
    const claims = result?.claims as CustomClaims | undefined;
    if (canReadStakeDocPostFlip(claims, stakeId)) return true;
    await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_INTERVAL_MS));
    await refreshIdToken();
  }
  return false;
}

/**
 * Final step — flips `setup_complete=true`. The same updateDoc carries
 * the `lastActor` integrity field; this Firestore flip is the entire
 * Complete-Setup action (the routing gate redirects once it lands, and
 * the `auditTrigger` fans the audit row).
 *
 * Verifies a qualifying claim is actually ON THE TOKEN before issuing
 * the flip — not just that a refresh happened. The instant
 * `setup_complete` becomes `true`, `isSetupInProgressReadable` and
 * `isBootstrapAdmin` (firestore.rules) both stop applying — they're
 * gated on `setup_complete == false` — so the stake-doc read falls back
 * to plain `isAnyMember(stakeId) || isPlatformSuperadmin()` (see
 * `canReadStakeDocPostFlip`). The overwhelmingly common qualifier is the
 * `manager` claim `useEnsureBootstrapAdmin`'s auto-add minted earlier in
 * the wizard. A refresh alone doesn't guarantee that claim actually
 * arrived: the auto-add write is fire-and-forget from
 * `BootstrapWizardPage.tsx` (only retried when `managers.data` changes)
 * and `syncManagersClaims` can silently miss on a `uidForCanonical`
 * lookup. Flipping anyway on a non-qualifying token strands the admin
 * worse than before the flip — the wizard is unreachable once
 * `setup_complete=true`, the token was just refreshed so a reload
 * doesn't recover, and the auto-add effect can't re-mint the claim
 * because it early-returns once the manager doc exists.
 *
 * So `waitForPostFlipStakeAccess` is a gate, not a courtesy: if nothing
 * qualifying lands within its bound, `mutationFn` re-issues the auto-add
 * write (see below) and throws — the `updateDoc` never runs,
 * `setup_complete` stays `false`, and the wizard is exactly where it
 * was. Under no circumstances does a failed verification still issue
 * the flip.
 *
 * Re-issue-then-throw, not re-issue-then-repoll: on a claim miss this
 * mutation writes `kindooManagers/{canonical}` again (`merge: true`,
 * safe to repeat) so `syncManagersClaims` gets another chance, then
 * throws immediately rather than looping through a second
 * `CLAIM_POLL_ITERATIONS` wait in the same call. The retry-worthy case
 * this fixes — the earlier fix's known gap — is a dropped trigger or a
 * transient `uidForCanonical` miss, and `syncManagersClaims` reacting to
 * a Firestore write is typically a sub-second round trip; the admin's
 * own next "Complete Setup" click starts a fresh bounded poll with a
 * real chance of seeing it, at the same bounded ~5s worst case as any
 * other attempt. Re-polling inline after the re-issue would only save
 * that one click at the cost of doubling the worst-case wait on EVERY
 * miss (including ones the re-issue can't fix, e.g. `activeStakeId`
 * resolving to the wrong stake) — not a trade worth making for a flow
 * that runs once per stake, ever.
 *
 * This is deliberately NOT the pattern `architecture.md` D28(d)
 * reverted, even though both are a forced refresh next to `stakes`
 * writes — don't delete the refresh inside `waitForPostFlipStakeAccess`
 * on the assumption it repeats that mistake. D28(d)'s refresh ran right
 * after `createStake`, racing `syncBootstrapClaims` — an async Firestore
 * trigger on that very write — before it had run; it lost almost every
 * time and re-cached a claimless token for ~1h. Here the qualifying
 * claim was minted *minutes* earlier in the common case:
 * `useEnsureBootstrapAdmin` writes `kindooManagers/{canonical}` at
 * wizard mount, `syncManagersClaims` fires off that write, and the admin
 * then works through the rest of the wizard's steps before ever
 * reaching Complete Setup. By the time this mutation runs the claim
 * already exists server-side in the overwhelming common case — the
 * bounded wait (and the re-issue-on-miss below) are a backstop for the
 * rare cases where it doesn't, not the primary mechanism.
 */
export function useCompleteSetupMutation() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const sid = requireActiveStake(activeStakeId);
      const claimLanded = await waitForPostFlipStakeAccess(sid);
      if (!claimLanded) {
        // Make the retry story true: the doc `useEnsureBootstrapAdmin`
        // wrote at wizard mount may already exist (so its own
        // early-return-if-active guard means it will never fire again),
        // even though the claim it was supposed to mint never landed.
        // Re-issuing here — not repolling inline, see the doc comment
        // above — gives `syncManagersClaims` a fresh write to react to
        // before the admin's next Complete Setup click.
        const actor = actorOf(principal);
        await writeBootstrapAdminManagerDoc(sid, principal.email, principal.email, actor);
        throw new Error(
          'Setup access is still syncing — wait a moment and try Complete Setup again.',
        );
      }
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
