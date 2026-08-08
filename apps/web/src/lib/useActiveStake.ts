// `useActiveStake()` — the runtime side of the active-stake selector
// (spec §2.1). Reads `usePrincipal()`, walks the priority chain, strips
// `?stake=X` from the URL when it was the source, surfaces a one-time
// toast on invalidated tiers, and returns the resolved stake (or `null`
// for the zero-role platform superadmin).
//
// Subscribes to router-state changes (`useRouterState`) so subsequent
// `?stake=X` arrivals — from the service-worker `notificationclick`
// handler reusing an existing window — also re-run the validate-then-
// strip step. The `?stake=X` value lands in the URL search, gets read,
// gets persisted to both storage tiers, and gets stripped via
// `history.replaceState`.
//
// Components that need the active stake call this hook and treat
// `null` as "no per-stake reads to issue" (the empty-set superadmin
// state). The StakeSwitcher hides itself for principals with < 2
// accessible stakes; per-stake-aware hooks pass `null` through to
// their queries so the DIY data hooks stay disabled.
//
// Also owns bootstrap-stake discovery: fires the `resolveBootstrapStake`
// callable once per signed-in identity so a fresh bootstrap admin (zero
// role claims) — and an EXISTING manager who is separately named
// bootstrap admin of an unrelated, not-yet-setup stake — both resolve
// to (or at least can switch into) the stake they're meant to set up.
// See `activeStake.ts`'s header for how the result threads into
// resolution, and `useActiveStake`/`useBootstrapStakeDiscoveryPending`/
// `useAccessibleStakesWithBootstrap` below for the three public facets.
//
// Implementation note on context-free reads. `useActiveStake` is
// consumed by `useRequireRole`, which fires at the top of every route
// gate — including in route-gate unit tests that don't wrap a
// `QueryClientProvider` or a TanStack Router. We therefore do NOT
// read those contexts from inside the hook. Instead:
//   - URL `?stake=X` is read directly off `window.location.search`.
//   - The hook subscribes to a module-scoped event emitter that the
//     SW-notificationclick bridge in `main.tsx` pings on push-deep-link
//     navigations; `useEffect` re-resolves on each ping.
//   - The QueryClient used for URL-tier cache invalidation comes from
//     a module-scoped registry that `main.tsx` populates on app boot
//     (`registerActiveStakeQueryClient`). Route-gate unit tests don't
//     register one and the invalidate becomes a no-op.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { canonicalEmail } from '@kindoo/shared';
import {
  ACTIVE_STAKE_LOCAL_KEY,
  ACTIVE_STAKE_SESSION_KEY,
  accessibleStakes,
  persistActiveStakeChoice as persistChoiceCore,
  readLocalStake,
  readSessionStake,
  resolveActiveStake,
} from './activeStake';
import { FIRESTORE_QUERY_KEY_PREFIX } from './data/queryKeys';
import { usePrincipal } from './principal';
import type { Principal } from './principal';

const STAKE_PARAM = 'stake';

// Module-scoped QueryClient registry. `main.tsx` populates this on app
// boot; the hook reads it when it needs to invalidate per-stake caches.
// `null` is the sentinel for "not yet registered" (route-gate unit
// tests that don't bring their own QueryClient).
let activeStakeQueryClient: QueryClient | null = null;

/**
 * Register the app's QueryClient with the active-stake module. Called
 * once from `main.tsx` after `createQueryClient`; tests that exercise
 * the URL-tier invalidate path register a test client via the same
 * door.
 */
export function registerActiveStakeQueryClient(qc: QueryClient | null): void {
  activeStakeQueryClient = qc;
}

// Module-scoped subscriber set. `notifyActiveStakeUrlNavigated()` fires
// each registered callback; the hook subscribes to receive pushes from
// SW-notificationclick → router-history navigations (`main.tsx` wires
// the SW bridge to call `notifyActiveStakeUrlNavigated()` after the
// router push lands).
const urlNavSubscribers = new Set<() => void>();

/** Fired by `main.tsx` after a SW-driven router navigation lands. */
export function notifyActiveStakeUrlNavigated(): void {
  for (const fn of urlNavSubscribers) {
    try {
      fn();
    } catch {
      // ignore individual subscriber errors
    }
  }
}

// Module-scoped subscriber set for storage-tier changes (the switcher
// click handler is the only writer in normal flow; the URL-tier
// invalidation overwrite also touches storage and pings here). Same-tab
// writes don't fire the `storage` window event — that fires for OTHER
// tabs only — so we route in-tab notifications through this bus.
const storageChangeSubscribers = new Set<() => void>();

/** Fired by the switcher hook after a storage-tier write lands. */
function notifyActiveStakeStorageChanged(): void {
  for (const fn of storageChangeSubscribers) {
    try {
      fn();
    } catch {
      // ignore individual subscriber errors
    }
  }
}

// Module-scoped storage for the most-recent observed `?stake=X` URL
// param. Shared across every consumer of `useActiveStake` because
// multiple components mount the hook (Shell + AuthedLayout +
// `useRequireRole` in each role-gated route) and the URL gets stripped
// once after the first resolve. Without sharing, late-mounting
// instances would see `?stake=X` already stripped and resolve to the
// alphabetically-first accessible stake instead of the deep-linked
// one. The module-scoped value lives until the first successful
// principal-validated persist into storage, at which point the URL
// tier is considered "consumed" and the hook falls through to storage
// on subsequent reads.
let moduleUrlStakeParam: string | null = null;
let moduleUrlStakeParamConsumed = false;
const urlStakeParamSubscribers = new Set<() => void>();

// Module-scoped invalidated-tier dedupe. The hook is mounted by every
// route gate (Shell, AuthedLayout, useRequireRole) AND by every
// per-feature data hook that reads the active stake, so a single
// invalidated tier would otherwise fire N toasts on the same page.
// Track the most recently fired (invalidatedTier, stakeId) key here so
// the FIRST instance to fire records the key and every sibling sees
// the key as already-fired. Reset on:
//   - URL stake-param change (a new invalidated arrival is a new event),
//   - principal signature change (claims rotation invalidates the prior
//     decision — a previously-stale storage value may have become
//     valid, or vice versa).
let lastInvalidationKey: string | null = null;
// Signature carried alongside the key so we can detect "context changed
// → reset the dedupe" without needing per-hook-instance refs.
let lastInvalidationContext: string | null = null;

function readModuleUrlStakeParam(): string | null {
  return moduleUrlStakeParam;
}

function notifyUrlStakeParamSubscribers(): void {
  for (const fn of urlStakeParamSubscribers) {
    try {
      fn();
    } catch {
      // ignore individual subscriber errors
    }
  }
}

/**
 * Seed the module-scoped URL stake param from the current URL. Called
 * lazily on first hook mount and refreshed on every router-history
 * navigation (via the `urlNavSubscribers` bus that `main.tsx` pings).
 * Only PROMOTES the state — null reads (URL was stripped or never had
 * the param) leave the prior value in place if we haven't yet finished
 * consuming it. Once consumed (the principal-validated persist landed),
 * subsequent null reads DO clear the state so a later real URL arrival
 * isn't shadowed.
 */
function refreshModuleUrlStakeParamFromUrl(): void {
  const next = readStakeParamFromUrl();
  if (next === null) {
    // No URL value to read. If we've already consumed the prior value,
    // leave the slot empty so a later real arrival can land. If we
    // haven't yet consumed, RETAIN the prior value — the strip was
    // ours and we're still waiting on principal claims to validate.
    if (moduleUrlStakeParamConsumed && moduleUrlStakeParam !== null) {
      moduleUrlStakeParam = null;
      notifyUrlStakeParamSubscribers();
    }
    return;
  }
  // Same-value early-return only guards against rebroadcasting
  // subscribers and resetting the consumed flag. The URL strip still
  // needs to run — a fresh `?stake=X` arrival on a tab already settled
  // on X (e.g., a re-navigation from the Stake List to the current
  // stake) would otherwise leave `?stake=X` lingering in the URL bar.
  if (next === moduleUrlStakeParam) {
    stripStakeParamFromUrl();
    return;
  }
  moduleUrlStakeParam = next;
  moduleUrlStakeParamConsumed = false;
  notifyUrlStakeParamSubscribers();
}

/**
 * Mark the current URL-tier value as consumed. Called once the
 * resolver lands on a principal-validated URL-tier hit and persists
 * to storage — from then on, storage is the source of truth and we
 * can let `refreshModuleUrlStakeParamFromUrl` clear the slot.
 */
function markUrlStakeParamConsumed(): void {
  moduleUrlStakeParamConsumed = true;
}

/** `useSyncExternalStore` subscribe contract for the URL stake param. */
function subscribeToUrlStakeParam(callback: () => void): () => void {
  urlStakeParamSubscribers.add(callback);
  return () => {
    urlStakeParamSubscribers.delete(callback);
  };
}

// Synchronously seed the module value at import time so the very first
// hook render — which happens before any effect can fire — already
// sees the URL value. Tests + SSR-safe environments may not have a
// `window`; the guard inside `readStakeParamFromUrl` handles that.
moduleUrlStakeParam = readStakeParamFromUrl();

/**
 * Test-only reset. Clears the module-scoped URL-tier state so each
 * test starts from a clean slate. Calls to this from non-test code
 * are safe but pointless — the module owns the state and the only
 * legitimate "reset" is between Vitest test cases. The hook re-seeds
 * on its next mount + URL read.
 */
export function __resetActiveStakeModuleForTests(): void {
  moduleUrlStakeParam = readStakeParamFromUrl();
  moduleUrlStakeParamConsumed = false;
  lastInvalidationKey = null;
  lastInvalidationContext = null;
  activeStakeInvalidation = null;
  activeStakeInvalidationEventId = 0;
  bootstrapDiscoveryState = null;
  notifyUrlStakeParamSubscribers();
  for (const fn of activeStakeInvalidationSubscribers) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
  notifyBootstrapDiscoverySubscribers();
}

/**
 * Read `?stake=X` directly off the current URL. No router context
 * needed (context-free; safe to call from route-gate unit tests that
 * don't mount a router).
 */
function readStakeParamFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get(STAKE_PARAM);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Strip `?stake=X` from the current URL via `history.replaceState`.
 * No-op outside the browser environment.
 */
function stripStakeParamFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(STAKE_PARAM)) return;
    url.searchParams.delete(STAKE_PARAM);
    const next = `${url.pathname}${url.search ? url.search : ''}${url.hash ?? ''}`;
    window.history.replaceState(window.history.state, '', next);
  } catch {
    // history.replaceState rejects on some sandboxed contexts; the
    // active-stake value is already persisted, just leave the URL
    // alone.
  }
}

/**
 * Invalidate every DIY-Firestore-hook cache entry so all per-stake
 * reads re-issue against the newly-resolved stake. Cheap at our
 * scale (~250 seats) and avoids per-collection invalidation lists.
 * No-op when no QueryClient is registered (tests without a provider).
 */
function invalidatePerStakeQueries(): void {
  if (!activeStakeQueryClient) return;
  activeStakeQueryClient
    .invalidateQueries({ queryKey: [FIRESTORE_QUERY_KEY_PREFIX] })
    .catch(() => {});
}

/**
 * An invalidated-tier event surfaced to the `<ActiveStakeToastBoundary>`
 * component for display-name-aware toast rendering. The hook publishes
 * via `setActiveStakeInvalidation()`; the boundary subscribes via
 * {@link useActiveStakeInvalidation}.
 *
 * Why this is split out of the hook: storage-tier invalidations need to
 * say "switched to <stake_name>" (display name), but `useActiveStake`
 * is consumed by route-gate code-paths that don't have a stake-doc
 * subscription — they only know slugs. The boundary mounts inside the
 * Shell where the stake doc IS subscribed via `useFirestoreDoc`, so it
 * can substitute the display name before firing the toast.
 */
export interface ActiveStakeInvalidationEvent {
  /** Which tier was stale. */
  tier: 'url' | 'session' | 'local';
  /**
   * The stake the resolver fell through to after the stale tier was
   * discarded. `null` when nothing further was available (e.g., a
   * zero-role superadmin with stale storage).
   */
  newStakeId: string | null;
  /**
   * Monotonic event id — bumps on every published event so React's
   * `useEffect` dep array can recognise a re-fire (same `tier`/`newStakeId`
   * pair on a different context).
   */
  eventId: number;
}

let activeStakeInvalidation: ActiveStakeInvalidationEvent | null = null;
let activeStakeInvalidationEventId = 0;
const activeStakeInvalidationSubscribers = new Set<() => void>();

function publishActiveStakeInvalidation(
  tier: 'url' | 'session' | 'local',
  newStakeId: string | null,
): void {
  activeStakeInvalidationEventId += 1;
  activeStakeInvalidation = {
    tier,
    newStakeId,
    eventId: activeStakeInvalidationEventId,
  };
  for (const fn of activeStakeInvalidationSubscribers) {
    try {
      fn();
    } catch {
      // ignore individual subscriber errors
    }
  }
}

function subscribeToActiveStakeInvalidation(callback: () => void): () => void {
  activeStakeInvalidationSubscribers.add(callback);
  return () => {
    activeStakeInvalidationSubscribers.delete(callback);
  };
}

function readActiveStakeInvalidation(): ActiveStakeInvalidationEvent | null {
  return activeStakeInvalidation;
}

/**
 * Subscribe to invalidated-tier events. Returns the most recent event
 * (or `null` if no event has fired yet). Re-renders on every new
 * publish.
 *
 * Consumed by `<ActiveStakeToastBoundary>`; surfaced for tests that
 * want to exercise the publisher contract without rendering the
 * boundary.
 */
export function useActiveStakeInvalidation(): ActiveStakeInvalidationEvent | null {
  return useSyncExternalStore(
    subscribeToActiveStakeInvalidation,
    readActiveStakeInvalidation,
    readActiveStakeInvalidation,
  );
}

// Bootstrap-stake discovery. `resolveBootstrapStake` (the callable) has
// no client-side signal for "is this user a bootstrap admin somewhere"
// — the only way to find out is to ask the server. We ask once per
// signed-in identity, for EVERY signed-in user (not just zero-claims
// ones): an existing manager can also be the newly-named bootstrap
// admin of an unrelated stake, and that stake needs to surface in their
// StakeSwitcher. See `activeStake.ts`'s file header for how the result
// (`bootstrapStakeIds`) feeds into resolution.
const EMPTY_STAKE_IDS: string[] = [];
const BOOTSTRAP_DISCOVERY_QUERY_KEY_PREFIX = '__kindoo_bootstrap_discovery__';

interface BootstrapDiscoveryState {
  /** The identity (`canonical || canonicalEmail(email)`) this result is for. */
  identityKey: string;
  status: 'pending' | 'done';
  /** Ascending-sorted; empty once `status: 'done'` finds nothing. */
  stakeIds: string[];
}

// Module-scoped (not per-hook-instance) so the Shell + AuthedLayout +
// useRequireRole + every feature data hook that mounts `useActiveStake`
// share ONE in-flight callable instead of firing one each.
let bootstrapDiscoveryState: BootstrapDiscoveryState | null = null;
const bootstrapDiscoverySubscribers = new Set<() => void>();

function notifyBootstrapDiscoverySubscribers(): void {
  for (const fn of bootstrapDiscoverySubscribers) {
    try {
      fn();
    } catch {
      // ignore individual subscriber errors
    }
  }
}

function subscribeToBootstrapDiscovery(callback: () => void): () => void {
  bootstrapDiscoverySubscribers.add(callback);
  return () => {
    bootstrapDiscoverySubscribers.delete(callback);
  };
}

function readBootstrapDiscoveryState(): BootstrapDiscoveryState | null {
  return bootstrapDiscoveryState;
}

/**
 * Kick off (or no-op into) the bootstrap-discovery callable for
 * `identityKey`. Idempotent: a call for an identity that's already
 * pending or done is a no-op, so multiple mounted `useActiveStake`
 * instances calling this on the same render tick issue exactly one
 * network request. No-ops entirely when no QueryClient is registered
 * (route-gate unit tests that don't bring their own — see
 * `registerActiveStakeQueryClient`), matching this file's existing
 * "no QueryClient → the feature degrades to a no-op" contract.
 */
function ensureBootstrapDiscoveryStarted(identityKey: string): void {
  const queryClient = activeStakeQueryClient;
  if (queryClient === null) return;
  if (bootstrapDiscoveryState !== null && bootstrapDiscoveryState.identityKey === identityKey) {
    return;
  }
  bootstrapDiscoveryState = { identityKey, status: 'pending', stakeIds: EMPTY_STAKE_IDS };
  notifyBootstrapDiscoverySubscribers();

  queryClient
    .fetchQuery({
      queryKey: [BOOTSTRAP_DISCOVERY_QUERY_KEY_PREFIX, identityKey],
      // Dynamic import: see `resolveBootstrapStake.ts` header for why
      // the Firebase Functions SDK singleton is loaded lazily here
      // rather than via a static top-of-file import.
      queryFn: async () => {
        const { resolveBootstrapStake } = await import('./resolveBootstrapStake');
        return resolveBootstrapStake();
      },
      staleTime: Infinity,
      gcTime: Infinity,
    })
    .then((result) => {
      // A reset (tests) or a newer identity superseded this call while
      // it was in flight — drop the stale result.
      if (bootstrapDiscoveryState?.identityKey !== identityKey) return;
      bootstrapDiscoveryState = { identityKey, status: 'done', stakeIds: result.stakeIds };
      notifyBootstrapDiscoverySubscribers();
    })
    .catch(() => {
      if (bootstrapDiscoveryState?.identityKey !== identityKey) return;
      // Fail closed: treat a network/callable error as "found nothing"
      // rather than leaving the gate on `pending` forever.
      bootstrapDiscoveryState = { identityKey, status: 'done', stakeIds: EMPTY_STAKE_IDS };
      notifyBootstrapDiscoverySubscribers();
    });
}

/**
 * The signed-in user's stable identity key for discovery purposes.
 * `principal.canonical` is the empty string during the first-sign-in
 * window before `onAuthUserCreate` mints claims (see B-2 in
 * `docs/BUGS.md`), so fall back to canonicalising the typed email —
 * available synchronously off the Firebase Auth user object, no claims
 * needed. Empty string means "no identity to key on yet" (e.g. a
 * Firebase Auth user record with no email).
 */
function discoveryIdentityKeyFor(principal: Principal): string {
  return principal.canonical || canonicalEmail(principal.email);
}

/**
 * Internal engine behind `useActiveStake`, `useBootstrapStakeDiscoveryPending`,
 * and `useAccessibleStakesWithBootstrap`. Returns the current stake ID
 * (or `null` for a zero-role platform superadmin), whether bootstrap
 * discovery is still in flight in a way that matters to the caller, and
 * the raw discovered stake-id list (for the StakeSwitcher's menu
 * source). Re-renders on:
 *
 *   - principal changes (claim rotation)
 *   - router navigation that adds a new `?stake=X` param (push deep
 *     links arriving on an already-open tab)
 *   - the bootstrap-discovery callable resolving
 *
 * Side effects:
 *
 *   - On URL-tier hit: persists value to both storage tiers, strips
 *     `?stake=X` from the URL, invalidates per-stake TanStack Query
 *     caches via the registered QueryClient.
 *   - On invalidated tier: shows a toast and overwrites the stale
 *     storage value with the resolved stake (or clears it when the
 *     resolved stake is null).
 *   - Fires the `resolveBootstrapStake` callable at most once per
 *     signed-in identity (see `ensureBootstrapDiscoveryStarted`).
 *
 * Split into three thin public wrappers (rather than changing
 * `useActiveStake`'s return shape) so its many existing call sites keep
 * receiving exactly `string | null` — see module header + the callers
 * that need the discovery flag or the raw list opt in explicitly.
 */
function useActiveStakeInternal(): {
  stakeId: string | null;
  discoveryPending: boolean;
  bootstrapStakeIds: string[];
} {
  const principal = usePrincipal();

  // Stable signature of the principal fields the resolver actually
  // reads. `usePrincipal()` returns a fresh `Principal` object on every
  // render (the decorator allocates new closures), so depending on the
  // raw object would re-fire effects every render — and any effect that
  // calls `setState` with a fresh object would loop indefinitely.
  // Signature on every field the resolver branches on:
  //   - `firebaseAuthSignedIn` — gates the bootstrap-admin carve-out
  //     (per item 5; flipping false→true after sign-in must
  //     re-invalidate the memo even though the accessible-stake set is
  //     unchanged).
  //   - `isPlatformSuperadmin` — gates the superadmin permissive
  //     resolution (per item 3).
  //   - `accessibleStakes(...)` — the set the resolver validates URL /
  //     storage values against.
  const principalSignature = useMemo(() => {
    const accessible = accessibleStakes(principal).join(',');
    return `${principal.firebaseAuthSignedIn ? '1' : '0'}|${principal.isPlatformSuperadmin ? '1' : '0'}|${accessible}`;
  }, [principal]);

  // Track the URL `?stake=X` value through navigations. The value is
  // MODULE-SCOPED (shared across every mounted `useActiveStake`)
  // because multiple components in the tree call this hook (Shell +
  // AuthedLayout + `useRequireRole` per role-gated route), and the
  // URL gets stripped once after the first resolver pass. Without
  // sharing, late-mounting instances would see the URL already
  // stripped and resolve to the alphabetically-first accessible stake
  // instead of the deep-linked one. `useSyncExternalStore` subscribes
  // every instance to the same module value.
  //
  // Refresh sources for the module value:
  //   - `popstate` (browser back/forward navigations),
  //   - the module-scope `urlNavSubscribers` ping that `main.tsx`
  //     fires on every router-history change (covers both SW
  //     notificationclick deep links AND in-app navigations).
  //
  // `refreshModuleUrlStakeParamFromUrl` only PROMOTES from null → a
  // real value (or replaces one real value with another) until the
  // resolver marks the value as "consumed" via
  // `markUrlStakeParamConsumed()`. This guards against our own URL
  // strip clearing the state before the principal claims have loaded
  // and validated the URL value.
  const urlStakeParam = useSyncExternalStore(
    subscribeToUrlStakeParam,
    readModuleUrlStakeParam,
    readModuleUrlStakeParam,
  );

  // On first mount, seed the module value from the current URL if it
  // hasn't been seeded already. Subsequent navigations refresh it via
  // the popstate/urlNavSubscribers handlers below.
  useEffect(() => {
    refreshModuleUrlStakeParamFromUrl();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const recheck = () => {
      refreshModuleUrlStakeParamFromUrl();
    };
    window.addEventListener('popstate', recheck);
    urlNavSubscribers.add(recheck);
    return () => {
      window.removeEventListener('popstate', recheck);
      urlNavSubscribers.delete(recheck);
    };
  }, []);

  // Tick that bumps when storage-tier writes land (the switcher click
  // handler is the primary trigger). Storage isn't a React signal — the
  // synchronous `setItem` doesn't notify other listeners — so we route
  // in-tab changes through the module-scoped subscriber bus and use the
  // tick to force a re-render of every active consumer. The `resolved`
  // memo includes this tick in its dep list so it recomputes when the
  // switcher writes.
  const [storageTick, setStorageTick] = useState(0);
  useEffect(() => {
    const bump = () => setStorageTick((n) => n + 1);
    storageChangeSubscribers.add(bump);
    return () => {
      storageChangeSubscribers.delete(bump);
    };
  }, []);

  // Bootstrap-discovery wiring. Fires the `resolveBootstrapStake`
  // callable for EVERY signed-in identity with a resolvable email —
  // there's no client-side signal for "is this user a bootstrap admin
  // somewhere," so we always ask, once, and let the resolver above
  // decide what (if anything) to do with the answer. `discoveryCapable`
  // degrades this to a no-op when no QueryClient is registered (see
  // `ensureBootstrapDiscoveryStarted`).
  const discoveryIdentityKey = discoveryIdentityKeyFor(principal);
  const discoveryCapable = activeStakeQueryClient !== null;
  const shouldFireDiscovery =
    discoveryCapable && principal.firebaseAuthSignedIn === true && discoveryIdentityKey !== '';

  const discoveryState = useSyncExternalStore(
    subscribeToBootstrapDiscovery,
    readBootstrapDiscoveryState,
    readBootstrapDiscoveryState,
  );

  useEffect(() => {
    if (!shouldFireDiscovery) return;
    ensureBootstrapDiscoveryStarted(discoveryIdentityKey);
  }, [shouldFireDiscovery, discoveryIdentityKey]);

  const discoveryResultForIdentity =
    discoveryState !== null && discoveryState.identityKey === discoveryIdentityKey
      ? discoveryState
      : null;
  const bootstrapStakeIds = discoveryResultForIdentity?.stakeIds ?? EMPTY_STAKE_IDS;

  // True while discovery might still change which stakes are valid for
  // this identity — we've asked (or are about to) but don't have a
  // settled answer yet. The persist/strip/invalidate-toast effect below
  // MUST defer while this holds: a bootstrap-only stake sitting in
  // storage from an earlier switcher click is genuinely invalid against
  // `bootstrapStakeIds: []` (discovery hasn't confirmed it yet), and
  // running the "overwrite the stale entry" side effect on that
  // FALSE-NEGATIVE invalidation would permanently clobber the correct
  // value with the tier-4 fallback before discovery ever gets to
  // validate it.
  const discoverySettling = shouldFireDiscovery && discoveryResultForIdentity?.status !== 'done';

  // Resolve every render so consumers (`useRequireRole`, etc.) see the
  // right stake on the SAME render that the principal claims load.
  // Storing the resolution in `useState` and updating it from an effect
  // creates a one-frame lag: when claims load, `principalSignature`
  // updates and the render returns the STALE resolved value (still
  // `null` from the empty-principal first render); the effect then
  // bumps state and a second render lands with the correct value.
  // That intermediate frame is enough for `useRequireRole` to read
  // `activeStakeId === null`, decide the user lacks the role, and fire
  // `navigate({ to: '/' })` before our effect can correct it.
  //
  // `resolveActiveStake` is pure and cheap (set ops on ~12 strings), so
  // computing it per render is fine. Storage tiers are read fresh each
  // render — they can change out from under us (the switcher writes on
  // click; the URL tier writes via the effect below).
  const resolved = useMemo(
    () =>
      resolveActiveStake(
        principal,
        urlStakeParam,
        readSessionStake(),
        readLocalStake(),
        bootstrapStakeIds,
      ),
    // `principalSignature` carries the accessible-stake fingerprint;
    // `urlStakeParam` is state; `storageTick` bumps on switcher click.
    // Storage reads happen inside; not in the dep list because they're
    // snapshots, not signals — the tick is the change feed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [principalSignature, urlStakeParam, storageTick, bootstrapStakeIds],
  );

  // Track whether we've already STRIPPED the URL for a given
  // `urlStakeParam` value so re-renders don't trigger redundant
  // `history.replaceState` calls. The strip should run once per URL
  // arrival; the persist can run multiple times (it's idempotent), and
  // we want it to fire on the "claims-loaded after empty-principal
  // first-pass" transition where the URL value was already stripped
  // but the resolver couldn't validate it on the first render.
  const lastStrippedUrlParamRef = useRef<string | null>(null);
  // Track the last storage value we wrote for a given URL-tier hit so a
  // re-render doesn't re-persist + re-invalidate every frame.
  const lastPersistedUrlStakeIdRef = useRef<string | null>(null);

  // True for two cases that both warrant deferring the side effects:
  //   (a) the transient claims-loading window — `onAuthStateChanged`
  //       has fired but `getIdTokenResult` hasn't returned yet; and
  //   (b) the permanent no-roles signed-in state (typo'd email, revoked
  //       access). The predicate stays true forever in (b), which is
  //       intentional: the user is parked on NotAuthorized, and firing
  //       the URL-strip / storage-persist / toast effects would be a
  //       false signal that the deep-link landed somewhere usable.
  // Running side effects on a half-loaded principal in (a) would also
  // fire false-positive "this stake is no longer available" toasts on
  // the deep-link path.
  const principalSettling = principal.firebaseAuthSignedIn && !principal.isAuthenticated;

  useEffect(() => {
    if (principalSettling) return;

    // URL-tier persist. Fires the first time a `urlStakeParam` resolves
    // as a valid URL-tier hit (resolved.source === 'url'). Re-runs the
    // persist if the resolved stakeId changes (e.g., principal claims
    // arrived AFTER the initial empty-principal first render that
    // stripped the URL but couldn't validate it). Marks the
    // module-scoped URL value as consumed so subsequent null reads
    // from the URL (post-strip) can clear it.
    if (
      urlStakeParam !== null &&
      resolved.source === 'url' &&
      resolved.stakeId !== null &&
      lastPersistedUrlStakeIdRef.current !== resolved.stakeId
    ) {
      lastPersistedUrlStakeIdRef.current = resolved.stakeId;
      persistChoiceCore(resolved.stakeId);
      invalidatePerStakeQueries();
      markUrlStakeParamConsumed();
    }

    // URL-tier strip. Runs once per `urlStakeParam` arrival, regardless
    // of whether the param was valid (a bad param still shouldn't
    // survive in the URL bar). Deduped on `urlStakeParam` itself so the
    // post-strip router-history subscriber callback doesn't re-fire it.
    if (urlStakeParam !== null && lastStrippedUrlParamRef.current !== urlStakeParam) {
      lastStrippedUrlParamRef.current = urlStakeParam;
      stripStakeParamFromUrl();
    }

    // Toast + overwrite-stale-storage handling. Dedupe on a
    // MODULE-SCOPED key so a single invalidated tier fires exactly one
    // toast across the whole React tree — not once per mounted hook
    // instance (Shell + AuthedLayout + useRequireRole + every
    // feature data hook all mount this hook). The dedupe key is
    // (invalidatedTier:stakeId); the context that gates "this is a
    // NEW invalidation event" is (principalSignature|urlStakeParam) —
    // when either changes, the prior decision is stale and a new toast
    // for the same key is legitimate.
    //
    // Deferred while `discoverySettling`: a stale-looking tier value
    // may be genuinely valid once bootstrap discovery answers — e.g. a
    // session-tier value from an earlier switcher click on a bootstrap-
    // only stake looks invalid against `bootstrapStakeIds: []` before
    // discovery has loaded. Firing this block on that FALSE-NEGATIVE
    // would overwrite the correct value with the tier-4 fallback before
    // discovery ever gets to validate it (the URL-tier persist/strip
    // above stay ungated — they only act on an ALREADY-valid `'url'`
    // source, never on a not-yet-confirmed one).
    if (!discoverySettling) {
      const invalidationContext = `${principalSignature}|${urlStakeParam ?? ''}`;
      if (resolved.invalidatedTier !== null) {
        const invalidationKey = `${resolved.invalidatedTier}:${resolved.stakeId ?? ''}`;
        const contextChanged = lastInvalidationContext !== invalidationContext;
        if (contextChanged) {
          // New context (URL or claims changed) — reset the dedupe so a
          // legitimate repeat-invalidation can fire its toast again.
          lastInvalidationKey = null;
          lastInvalidationContext = invalidationContext;
        }
        if (lastInvalidationKey !== invalidationKey) {
          lastInvalidationKey = invalidationKey;
          // Publish the event to the boundary component for display-name
          // aware toast rendering. The boundary mounts once in Shell, so
          // module-scope dedupe above is belt-and-braces — even if the
          // dedupe slipped, the subscriber bus delivers one event per
          // publish and the boundary renders exactly one toast per event.
          publishActiveStakeInvalidation(resolved.invalidatedTier, resolved.stakeId);
          // Overwrite the stale storage entries with the resolved stake
          // so the next read doesn't re-trigger the toast. When
          // `stakeId` is null (zero-role superadmin with stale storage)
          // clear both tiers.
          try {
            if (resolved.stakeId === null) {
              if (typeof window !== 'undefined') {
                try {
                  window.sessionStorage.removeItem(ACTIVE_STAKE_SESSION_KEY);
                  window.localStorage.removeItem(ACTIVE_STAKE_LOCAL_KEY);
                } catch {
                  // ignore
                }
              }
            } else {
              persistChoiceCore(resolved.stakeId);
            }
          } catch {
            // ignore
          }
        }
      } else {
        // Clear the invalidation dedupe key when the resolution is
        // clean so a later stale tier can re-fire the toast. Track the
        // last-seen context so a return-to-clean state doesn't itself
        // count as a "context change" that re-fires the toast on the
        // next invalidation.
        lastInvalidationKey = null;
        lastInvalidationContext = invalidationContext;
      }
    }
    // Re-run side effects when the resolution changes or the principal
    // settles. `resolved` is memoized on `principalSignature` +
    // `urlStakeParam`; `principalSettling` is the gate that defers side
    // effects until the principal's claims have actually loaded;
    // `discoverySettling` defers the toast/overwrite block specifically
    // (see its own comment above) until bootstrap discovery has a
    // settled answer for this identity.
  }, [resolved, urlStakeParam, principalSettling, discoverySettling, principalSignature]);

  // Gate the route gates' render on discovery ONLY when it would
  // actually change the outcome: the principal has zero claim-derived
  // stakes (a claims-bearing user renders their normal landing page
  // immediately — a manager of A must not block on a callable whose
  // answer, at best, adds an unrelated stake B to their switcher), is
  // not a platform superadmin (they already short-circuit at
  // `setupGate.ts:111-113` regardless of discovery), and resolution
  // hasn't already landed on a stake via a URL/session/local hint
  // (including the superadmin URL-tier deep-link carve-out) — those
  // don't need to wait on an answer they won't use.
  const hasClaimStakes = accessibleStakes(principal).length > 0;
  const discoveryPending =
    shouldFireDiscovery &&
    principal.isPlatformSuperadmin !== true &&
    !hasClaimStakes &&
    resolved.stakeId === null &&
    discoveryResultForIdentity?.status !== 'done';

  return { stakeId: resolved.stakeId, discoveryPending, bootstrapStakeIds };
}

/**
 * The active-stake hook. Returns the current stake ID, or `null` for a
 * zero-role platform superadmin. See `useActiveStakeInternal` for the
 * full resolution + side-effect contract; this wrapper preserves the
 * pre-discovery `string | null` return shape so its many existing call
 * sites are unaffected.
 */
export function useActiveStake(): string | null {
  return useActiveStakeInternal().stakeId;
}

/**
 * True while the bootstrap-discovery callable is in flight AND its
 * answer would change where the route gates send the user (see
 * `useActiveStakeInternal`'s `discoveryPending` computation). The two
 * gates (`routes/_authed.tsx`, `routes/index.tsx`) pass this straight
 * into `gateDecision`'s 4th param so a fresh bootstrap admin renders
 * `null` (pending) instead of flashing NotAuthorized while their stake
 * is still being looked up.
 */
export function useBootstrapStakeDiscoveryPending(): boolean {
  return useActiveStakeInternal().discoveryPending;
}

/** A stake in the StakeSwitcher's menu source. */
export interface AccessibleStakeEntry {
  stakeId: string;
  /**
   * True when this stake is reachable ONLY via bootstrap-admin
   * discovery — the principal holds no claim-derived role on it (yet).
   * The switcher badges these so a manager of A who's also the named
   * bootstrap admin of not-yet-setup stake B can see B and switch into
   * its wizard without waiting for a role to be granted first.
   */
  needsSetup: boolean;
}

/**
 * The StakeSwitcher's menu source: claim-derived accessible stakes
 * (`useAccessibleStakes`, listed first, in their existing alphabetical
 * order) plus any bootstrap-only stakes discovery has found for this
 * identity (appended, `needsSetup: true`, deduped against the
 * claim-derived set).
 */
export function useAccessibleStakesWithBootstrap(): AccessibleStakeEntry[] {
  const principal = usePrincipal();
  const { bootstrapStakeIds } = useActiveStakeInternal();
  return useMemo(() => {
    const claimAccessible = accessibleStakes(principal);
    const claimSet = new Set(claimAccessible);
    const entries: AccessibleStakeEntry[] = claimAccessible.map((stakeId) => ({
      stakeId,
      needsSetup: false,
    }));
    for (const stakeId of bootstrapStakeIds) {
      if (!claimSet.has(stakeId)) {
        entries.push({ stakeId, needsSetup: true });
      }
    }
    return entries;
  }, [principal, bootstrapStakeIds]);
}

/**
 * Switcher-click side effect. Persists the chosen stake to both
 * storage tiers and invalidates per-stake TanStack Query caches so
 * downstream subscriptions refetch against the new stake.
 *
 * Returns a function bound to the current QueryClient — call it from
 * inside a React handler so the invalidation routes through the same
 * QueryClient instance the rest of the SPA reads from.
 */
export function useActiveStakeSwitcher(): (stakeId: string) => void {
  const queryClient = useQueryClient();
  return useMemo(() => {
    return (stakeId: string) => {
      persistChoiceCore(stakeId);
      // Notify every mounted `useActiveStake()` consumer so they re-
      // resolve against the new storage value. Same-tab writes don't
      // emit a `storage` event; this bus is how in-tab switches reach
      // the React tree.
      notifyActiveStakeStorageChanged();
      queryClient.invalidateQueries({ queryKey: [FIRESTORE_QUERY_KEY_PREFIX] }).catch(() => {});
    };
  }, [queryClient]);
}

/**
 * Read the principal's accessible stakes — convenience re-export so
 * call sites don't have to bridge two modules. Returns the
 * alphabetically-sorted, deduped array suitable for menu rendering.
 */
export function useAccessibleStakes(): string[] {
  const principal = usePrincipal();
  return useMemo(() => accessibleStakes(principal), [principal]);
}
