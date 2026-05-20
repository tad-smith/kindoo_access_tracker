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
): ResolveActiveStakeResult {
  const accessible = accessibleStakes(principal);
  const accessSet = new Set(accessible);
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
  // Platform superadmins (the `isPlatformSuperadmin === true` flag) are
  // treated permissively at the URL TIER ONLY. Per spec §5.4 + F19 the
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
  // URL-tier permissive: superadmin OR bootstrap candidate.
  const isPermissiveUrl = isBootstrapCandidate || isPlatformSuperadmin;
  // Storage-tier permissive: bootstrap candidate ONLY. Superadmins
  // intentionally fall through to invalidation here.
  const isPermissiveStorage = isBootstrapCandidate;

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
      isPermissiveStorage,
    );
    return { ...fallback, invalidatedTier: 'url' };
  }

  // Tiers 2-4.
  return resolveStorageTiers(accessSet, sessionValue, localValue, accessible, isPermissiveStorage);
}

function resolveStorageTiers(
  accessSet: Set<string>,
  sessionValue: string | null,
  localValue: string | null,
  accessible: string[],
  isPermissive: boolean = accessible.length === 0,
): ResolveActiveStakeResult {
  // Tier 2: sessionStorage.
  if (sessionValue !== null && sessionValue.length > 0) {
    if (accessSet.has(sessionValue)) {
      return { stakeId: sessionValue, source: 'session', invalidatedTier: null };
    }
    if (isPermissive) {
      // Permissive paths (bootstrap-admin / superadmin) — see
      // `resolveActiveStake`.
      return { stakeId: sessionValue, source: 'session', invalidatedTier: null };
    }
    // Invalid — fall through to local + principal but flag.
    const next = resolveLocalThenPrincipal(accessSet, localValue, accessible, isPermissive);
    return { ...next, invalidatedTier: 'session' };
  }

  // Tier 3 + 4.
  return resolveLocalThenPrincipal(accessSet, localValue, accessible, isPermissive);
}

function resolveLocalThenPrincipal(
  accessSet: Set<string>,
  localValue: string | null,
  accessible: string[],
  isPermissive: boolean = accessible.length === 0,
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
    const principalChoice = principalDerivedStake(accessible);
    return {
      stakeId: principalChoice,
      source: principalChoice === null ? 'none' : 'principal',
      invalidatedTier: 'local',
    };
  }
  // Tier 4: principal-derived. No invalidation (priority-4 is valid by
  // construction).
  const principalChoice = principalDerivedStake(accessible);
  return {
    stakeId: principalChoice,
    source: principalChoice === null ? 'none' : 'principal',
    invalidatedTier: null,
  };
}

function principalDerivedStake(accessibleSorted: string[]): string | null {
  return accessibleSorted[0] ?? null;
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
