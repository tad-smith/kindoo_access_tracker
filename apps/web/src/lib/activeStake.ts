// Active-stake selector. Picks which stake's data the current tab is
// reading and writing against (`docs/spec.md` §2.1). The resolution
// chain runs on first render and on every router navigation that
// carries a new `?stake=X` param.
//
// Two layers:
//
//   - Pure resolution (`resolveActiveStake`, `accessibleStakes`,
//     `persistActiveStakeChoice`) — exported here so unit tests can
//     exercise them without React.
//   - `useActiveStake()` React hook — `lib/useActiveStake.ts`.
//
// Resolution priority, top wins:
//   1. URL `?stake=X` — only valid when X is in the principal's
//      accessible set. On hit, write to BOTH sessionStorage AND
//      localStorage (same symmetric write as the switcher click
//      handler) so subsequent reads see the deep-linked stake.
//   2. sessionStorage[SESSION_KEY] — per-tab.
//   3. localStorage[LOCAL_KEY]   — sticky default for fresh tabs.
//   4. Principal-derived first stake — alphabetical sort across the
//      union of managerStakes ∪ stakeMemberStakes ∪ Object.keys(
//      bishopricWards). Empty set → null. A zero-role platform
//      superadmin lands here with null.
//
// Tiers 1, 2, and 3 validate against the accessible set; an invalid
// value falls through to the next tier and the caller surfaces a
// toast (URL: "This notification was for a stake you no longer have
// access to."; storage: "Your last-active stake is no longer
// available; switched to <new stake>.").
//
// `principal.bootstrapStakes`: every not-yet-setup stake the signed-in
// user is the designated bootstrap admin of (per `StakeClaims.bootstrap`
// — a custom-claims marker, NOT a role; see `packages/shared`), whether
// or not they also hold claim-derived roles elsewhere. It arrives on the
// same principal/token read as every other claim — no separate discovery
// round-trip. It widens tiers 1-3's validation set (a stake reachable
// only via bootstrap-admin claim validates normally instead of
// invalidating-with-a-toast) and backstops tier 4: claim-derived stakes
// always win tier 4; `bootstrapStakes[0]` is the tier-4 fallback ONLY
// when the principal has zero claim-derived stakes AND is not a platform
// superadmin (a superadmin must keep landing on `/superadmin/stakes` via
// the `setupGate.ts` short-circuit, not get auto-switched into a wizard).
//
// A known `bootstrapStakes` answer must beat an UNVALIDATED stale
// storage value. The storage tiers' permissive carve-out (see
// `isPermissiveStorage` below) exists only to cover the window before
// any claims — including `bootstrapStakes` — have arrived. Once
// `bootstrapStakes` is populated, tier 4 has a validated target; a
// stale `localStorage`/`sessionStorage` entry naming an unrelated,
// now-inaccessible stake must fall through to it instead of winning
// tier 2/3 outright. (A zero-role principal who is now the bootstrap
// admin of stake B, but still carries `localStorage` from a prior
// session naming old stake A, must resolve to B — not permission-deny
// against A forever. See `docs/BUGS.md` B-19.) The URL tier is exempt
// from this narrowing; see the `isPermissiveUrl` comment below for why.

import type { Principal } from './principal-derive';

const SESSION_KEY = 'kindoo.activeStake';
const LOCAL_KEY = 'kindoo.activeStake';

export const ACTIVE_STAKE_SESSION_KEY = SESSION_KEY;
export const ACTIVE_STAKE_LOCAL_KEY = LOCAL_KEY;

/**
 * Which storage tier produced the active-stake value (or `none` when
 * the principal has no accessible stake at all).
 */
export type ActiveStakeSource = 'url' | 'session' | 'local' | 'principal' | 'none';

/**
 * Result of resolving the active stake. `invalidatedTier` is set when
 * the URL or a storage tier carried a value that the principal can't
 * actually access — callers surface the spec's toast and overwrite the
 * stale entry with `persistActiveStakeChoice`.
 */
export interface ResolveActiveStakeResult {
  stakeId: string | null;
  source: ActiveStakeSource;
  invalidatedTier: 'url' | 'session' | 'local' | null;
}

/**
 * The principal's accessible stake set: the union of
 * `managerStakes ∪ stakeMemberStakes ∪ Object.keys(bishopricWards)`.
 *
 * Platform superadmins are NOT given "any stake" access here — they can
 * read every stake's parent doc via the rules, but per-stake data is
 * still role-gated. A zero-role superadmin therefore returns `[]` and
 * `resolveActiveStake` returns `null` (spec §2.1).
 *
 * Returns a deduped, alphabetically-sorted array so callers can use it
 * directly as the menu source for the StakeSwitcher.
 */
export function accessibleStakes(principal: Principal): string[] {
  const set = new Set<string>();
  for (const s of principal.managerStakes) set.add(s);
  for (const s of principal.stakeMemberStakes) set.add(s);
  for (const sid of Object.keys(principal.bishopricWards)) {
    const wards = principal.bishopricWards[sid];
    if (Array.isArray(wards) && wards.length > 0) set.add(sid);
  }
  return [...set].sort();
}

/**
 * Pure resolution. Walks the priority chain and reports both the
 * resolved stake and which tier (if any) carried a stale value the
 * caller should overwrite + toast about.
 *
 * Does NOT touch storage on its own — the URL-tier symmetric write is
 * the caller's responsibility (the React hook handles it). This keeps
 * the function deterministic and testable.
 */
export function resolveActiveStake(
  principal: Principal,
  urlParam: string | null,
  sessionValue: string | null,
  localValue: string | null,
  /**
   * The stake this tab's own URL tier persisted to `sessionStorage`
   * during this page's lifetime, or `null`. Provenance, not a value —
   * `sessionValue` alone cannot say whether it is a deep link this tab
   * just consumed or residue from an earlier navigation.
   *
   * It exists for the one identity that has no tier 4 to fall back on:
   * a platform superadmin holding no role on any stake. The URL tier is
   * superadmin-permissive and persists what it resolves, but the
   * storage tiers deliberately are NOT (a stale stake must invalidate
   * rather than silently resume — see `isPermissiveStorage`). Those two
   * rules together meant the value was written into a slot this
   * identity could never read back: the deep link worked for whichever
   * hook instance consumed the URL and returned `null` for every one
   * after it. `usePrincipal` is per-instance state with its own async
   * claims read, so "an instance that mounts later" is the ordinary
   * case on a real page, not a race (T-91).
   *
   * Matching on the value keeps the protection intact: residue this tab
   * did not write still fails the check and still invalidates.
   */
  urlDerivedSessionStake: string | null = null,
): ResolveActiveStakeResult {
  const accessible = accessibleStakes(principal);
  const bootstrapStakeIds = principal.bootstrapStakes;
  // Effective validation set for tiers 1-3: claim-derived stakes plus
  // whatever bootstrap-admin claims this identity carries. See file
  // header.
  const accessSet = new Set<string>([...accessible, ...bootstrapStakeIds]);
  // Bootstrap-admin / pre-claim path: an AUTHENTICATED user with zero
  // accessible stakes who is NOT a platform superadmin is either
  // (a) the bootstrap admin for a stake whose `setup_complete` hasn't
  // flipped to true yet, or (b) a not-yet-claimed user landing
  // mid-import. The gate needs to READ a stake doc to decide what page
  // to render, but the principal carries no claims to derive the target
  // stake from. In that case, fall back to the hint from URL >
  // sessionStorage > localStorage without validating against the
  // (empty) access set. The downstream gate (`setupGate.ts`) refuses
  // to render an authed page unless the user actually has a role on
  // the stake, so this permissive resolution can't escalate access.
  //
  // Four conditions for the bootstrap carve-out (must ALL hold):
  //   - principal is signed in to Firebase Auth (authenticated; an
  //     unauth user landing on a `?stake=X` deep-link must NOT be
  //     treated as a bootstrap candidate),
  //   - accessible set is empty,
  //   - principal is NOT a platform superadmin (superadmins are
  //     handled separately — see below),
  //   - URL/storage value is a non-empty string (already enforced
  //     downstream by the `value.length > 0` checks; no further
  //     validation possible without a stake-read).
  //
  // The STORAGE tiers (2-3) add a fifth condition on top of
  // `isBootstrapCandidate`: `bootstrapStakeIds` must ALSO be empty. Once
  // `bootstrapStakes` is populated we have a validated tier-4 answer, so
  // an unvalidated stale storage value must not win outright — it needs
  // to invalidate and fall through to tier 4 like any other bad value.
  // Without this, a stale storage entry naming an old, now-inaccessible
  // stake shadows tier 4 forever (B-19's permanent-Not-Authorized shape:
  // the stale value resolves, the stake-doc read permission-denies, and
  // nothing ever re-evaluates because the storage-tier permissive
  // carve-out — and thus tier 4 — never runs). See the file header for
  // the URL tier's different treatment.
  //
  // Platform superadmins (the `isPlatformSuperadmin === true` flag) are
  // treated permissively at the URL TIER, and at the SESSION tier only
  // for the value that URL tier itself just persisted (see
  // `urlDerivedSessionStake` — without that, the deep link resolved for
  // one hook instance and `null` for every later one, T-91). Per spec §5.4 + F19 the
  // rules permit them to read every stake's parent doc, so a Stake-List
  // click landing on `/manager/dashboard?stake=X` is an explicit
  // deep-link the resolver honours. Storage tiers (session / local)
  // however carry stale values from prior sessions and are NOT a
  // superadmin-permissive surface: a zero-role superadmin whose
  // previous role on stake X has been rotated away must see the spec
  // §2.1 "no longer available" toast, fall through to `null`, and land
  // on `/superadmin/stakes` — not silently resume reads against a
  // stake they no longer have access to.
  const isBootstrapCandidate =
    principal.firebaseAuthSignedIn === true &&
    accessible.length === 0 &&
    !principal.isPlatformSuperadmin;
  const isPlatformSuperadmin = principal.isPlatformSuperadmin === true;
  // URL-tier permissive: superadmin OR bootstrap candidate. Deliberately
  // NOT narrowed by `bootstrapStakes` the way the storage tiers below
  // are. A `?stake=X` URL is explicit, present-tense intent for THIS
  // navigation — a fresh invite/notification link, a Stake-List click —
  // not stale residue from a prior session, so a populated
  // `bootstrapStakes` doesn't get to override it. It also can't become
  // a silent PERMANENT trap the way storage can: the resolver strips
  // the param from the URL after consuming it (`stripStakeParamFromUrl`
  // in `useActiveStake.ts`), so a bad value can't keep winning on every
  // subsequent load the way a stale storage entry would — and if the
  // URL-tier hit does get persisted into storage, that persisted value
  // is immediately subject to the (now-narrowed) storage-tier gate on
  // the very next resolve, so it self-corrects rather than compounding.
  const isPermissiveUrl = isBootstrapCandidate || isPlatformSuperadmin;
  // Storage-tier permissive: bootstrap candidate AND zero known
  // `bootstrapStakes`. See the file header + the comment above
  // `isBootstrapCandidate` for why this is narrower than the URL tier.
  const isPermissiveStorage = isBootstrapCandidate && bootstrapStakeIds.length === 0;
  // Session tier, superadmin only, and only for the exact value this
  // tab's URL tier persisted — see `urlDerivedSessionStake`. Scoped to
  // the SESSION tier because `localStorage` is the cross-session sticky
  // default, which is precisely the stale-residue case the storage
  // narrowing protects; it stays non-permissive.
  const isPermissiveSession =
    isPermissiveStorage ||
    (isPlatformSuperadmin &&
      urlDerivedSessionStake !== null &&
      sessionValue === urlDerivedSessionStake);

  // Tier 1: URL.
  if (urlParam !== null && urlParam.length > 0) {
    if (accessSet.has(urlParam)) {
      return { stakeId: urlParam, source: 'url', invalidatedTier: null };
    }
    if (isPermissiveUrl) {
      // Permissive paths (bootstrap-admin or platform superadmin). No
      // invalidation toast — neither identity has a fallback we'd be
      // demoting to.
      return { stakeId: urlParam, source: 'url', invalidatedTier: null };
    }
    // Invalid URL value — fall through, remember to toast. Storage
    // tier uses the storage-permissive flag (bootstrap candidate only).
    const fallback = resolveStorageTiers(
      accessSet,
      sessionValue,
      localValue,
      accessible,
      bootstrapStakeIds,
      isPlatformSuperadmin,
      isPermissiveStorage,
      isPermissiveSession,
    );
    return { ...fallback, invalidatedTier: 'url' };
  }

  // Tiers 2-4.
  return resolveStorageTiers(
    accessSet,
    sessionValue,
    localValue,
    accessible,
    bootstrapStakeIds,
    isPlatformSuperadmin,
    isPermissiveStorage,
    isPermissiveSession,
  );
}

function resolveStorageTiers(
  accessSet: Set<string>,
  sessionValue: string | null,
  localValue: string | null,
  accessible: string[],
  bootstrapStakeIds: string[],
  isPlatformSuperadmin: boolean,
  isPermissive: boolean = accessible.length === 0 && bootstrapStakeIds.length === 0,
  /** Session tier only — see `isPermissiveSession` in `resolveActiveStake`. */
  isPermissiveSession: boolean = isPermissive,
): ResolveActiveStakeResult {
  // Tier 2: sessionStorage.
  if (sessionValue !== null && sessionValue.length > 0) {
    if (accessSet.has(sessionValue)) {
      return { stakeId: sessionValue, source: 'session', invalidatedTier: null };
    }
    if (isPermissiveSession) {
      // Permissive paths (bootstrap-admin / superadmin) — see
      // `resolveActiveStake`.
      return { stakeId: sessionValue, source: 'session', invalidatedTier: null };
    }
    // Invalid — fall through to local + principal but flag.
    const next = resolveLocalThenPrincipal(
      accessSet,
      localValue,
      accessible,
      bootstrapStakeIds,
      isPlatformSuperadmin,
      isPermissive,
    );
    return { ...next, invalidatedTier: 'session' };
  }

  // Tier 3 + 4.
  return resolveLocalThenPrincipal(
    accessSet,
    localValue,
    accessible,
    bootstrapStakeIds,
    isPlatformSuperadmin,
    isPermissive,
  );
}

function resolveLocalThenPrincipal(
  accessSet: Set<string>,
  localValue: string | null,
  accessible: string[],
  bootstrapStakeIds: string[],
  isPlatformSuperadmin: boolean,
  isPermissive: boolean = accessible.length === 0 && bootstrapStakeIds.length === 0,
): ResolveActiveStakeResult {
  if (localValue !== null && localValue.length > 0) {
    if (accessSet.has(localValue)) {
      return { stakeId: localValue, source: 'local', invalidatedTier: null };
    }
    if (isPermissive) {
      // Permissive paths (bootstrap-admin / superadmin) — see
      // `resolveActiveStake`.
      return { stakeId: localValue, source: 'local', invalidatedTier: null };
    }
    // Invalid — fall through to principal but flag.
    const principalChoice = principalDerivedStake(
      accessible,
      bootstrapStakeIds,
      isPlatformSuperadmin,
    );
    return {
      stakeId: principalChoice,
      source: principalChoice === null ? 'none' : 'principal',
      invalidatedTier: 'local',
    };
  }
  // Tier 4: principal-derived. No invalidation (priority-4 is valid by
  // construction).
  const principalChoice = principalDerivedStake(
    accessible,
    bootstrapStakeIds,
    isPlatformSuperadmin,
  );
  return {
    stakeId: principalChoice,
    source: principalChoice === null ? 'none' : 'principal',
    invalidatedTier: null,
  };
}

/**
 * Tier-4 fallback. Claim-derived stakes always win — a manager of A who
 * is ALSO the bootstrap admin of not-yet-setup stake B must keep
 * landing on A, not get auto-switched into B's wizard on every login.
 * The alphabetically-first entry of `bootstrapStakeIds` (insertion order
 * off the claims object isn't guaranteed sorted; we sort here for a
 * deterministic pick) is consulted ONLY when the principal has zero
 * claim-derived stakes AND is not a platform superadmin — a zero-claim
 * superadmin must keep landing on `/superadmin/stakes` via the
 * `setupGate.ts` short-circuit rather than being auto-routed into a
 * wizard for a stake they merely happen to be the named bootstrap admin
 * of.
 */
function principalDerivedStake(
  accessibleSorted: string[],
  bootstrapStakeIds: string[],
  isPlatformSuperadmin: boolean,
): string | null {
  if (accessibleSorted.length > 0) return accessibleSorted[0] ?? null;
  if (isPlatformSuperadmin) return null;
  return [...bootstrapStakeIds].sort()[0] ?? null;
}

/**
 * Switcher click handler. Writes the chosen stake to BOTH
 * sessionStorage and localStorage so subsequent reads in this tab and
 * fresh tabs see the choice as sticky. Does NOT touch the URL.
 *
 * Caller is responsible for invalidating TanStack Query's per-stake
 * caches; the React hook (`useActiveStake`) wraps that.
 */
export function persistActiveStakeChoice(stakeId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SESSION_KEY, stakeId);
  } catch {
    // Storage write may fail in private-browsing modes; the URL tier
    // and the principal fallback still work.
  }
  try {
    window.localStorage.setItem(LOCAL_KEY, stakeId);
  } catch {
    // Same.
  }
}

/**
 * Read the sessionStorage tier. Returns `null` when the value is
 * absent or storage is unavailable.
 */
export function readSessionStake(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

/**
 * Read the localStorage tier. Returns `null` when the value is absent
 * or storage is unavailable.
 */
export function readLocalStake(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LOCAL_KEY);
  } catch {
    return null;
  }
}
