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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  ACTIVE_STAKE_LOCAL_KEY,
  ACTIVE_STAKE_SESSION_KEY,
  accessibleStakes,
  persistActiveStakeChoice as persistChoiceCore,
  readLocalStake,
  readSessionStake,
  resolveActiveStake,
  type ResolveActiveStakeResult,
} from './activeStake';
import { FIRESTORE_QUERY_KEY_PREFIX } from './data/queryKeys';
import { usePrincipal } from './principal';
import { toast } from './store/toast';

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
 * Surface the spec's toast for an invalidated tier (`spec.md` §2.1).
 * URL-tier invalidations show the push-notification copy; storage-tier
 * invalidations show the last-active-stake copy.
 */
function toastForInvalidatedTier(
  tier: 'url' | 'session' | 'local',
  newStakeId: string | null,
): void {
  if (tier === 'url') {
    toast('This notification was for a stake you no longer have access to.', 'warn');
    return;
  }
  // session / local — last-active-stake case.
  if (newStakeId !== null) {
    toast(`Your last-active stake is no longer available; switched to ${newStakeId}.`, 'warn');
  } else {
    toast('Your last-active stake is no longer available.', 'warn');
  }
}

/**
 * The active-stake hook. Returns the current stake ID (or `null` for a
 * zero-role platform superadmin). Re-renders on:
 *
 *   - principal changes (claim rotation)
 *   - router navigation that adds a new `?stake=X` param (push deep
 *     links arriving on an already-open tab)
 *
 * Side effects:
 *
 *   - On URL-tier hit: persists value to both storage tiers, strips
 *     `?stake=X` from the URL, invalidates per-stake TanStack Query
 *     caches via the registered QueryClient.
 *   - On invalidated tier: shows a toast and overwrites the stale
 *     storage value with the resolved stake (or clears it when the
 *     resolved stake is null).
 */
export function useActiveStake(): string | null {
  const principal = usePrincipal();

  // Track the URL `?stake=X` value through navigations. We read it
  // directly off `window.location.search` (no router context required
  // — keeps route-gate unit tests free of TanStack-Router wrapping)
  // and re-read on:
  //   - `popstate` (browser back/forward + history.replaceState),
  //   - the module-scope `urlNavSubscribers` ping that `main.tsx`
  //     fires after the SW notificationclick bridge pushes a new URL.
  const [urlStakeParam, setUrlStakeParam] = useState<string | null>(() => readStakeParamFromUrl());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const recheck = () => {
      const next = readStakeParamFromUrl();
      setUrlStakeParam((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('popstate', recheck);
    urlNavSubscribers.add(recheck);
    return () => {
      window.removeEventListener('popstate', recheck);
      urlNavSubscribers.delete(recheck);
    };
  }, []);

  // Resolve synchronously on first render so consumers (`useRequireRole`,
  // etc.) see the right stake on mount. The effect below re-runs on
  // changes to keep `resolved` aligned with subsequent principal /
  // URL-param updates.
  const [resolved, setResolved] = useState<ResolveActiveStakeResult>(() =>
    resolveActiveStake(principal, readStakeParamFromUrl(), readSessionStake(), readLocalStake()),
  );

  // Track whether we've already issued the URL-tier persist + strip for
  // a given urlStakeParam value so a re-render doesn't repeat the work.
  // Using a ref + the param itself as the dedupe key (the SW can fire
  // the same target twice; we only strip once per URL arrival).
  const lastHandledUrlParamRef = useRef<string | null>(null);

  useEffect(() => {
    // Read storage tiers fresh on every resolve — they can change out
    // from under us (the switcher writes on click; the URL tier writes
    // here below).
    const sessionValue = readSessionStake();
    const localValue = readLocalStake();

    const result = resolveActiveStake(principal, urlStakeParam, sessionValue, localValue);
    setResolved(result);

    // URL-tier handling. The validate-then-strip step runs every time
    // a `?stake=X` is present in the URL, whether or not it was valid.
    if (urlStakeParam !== null && lastHandledUrlParamRef.current !== urlStakeParam) {
      lastHandledUrlParamRef.current = urlStakeParam;
      // Persist on a valid URL hit; strip the URL either way so a bad
      // param doesn't survive in the bar.
      if (result.source === 'url' && result.stakeId !== null) {
        persistChoiceCore(result.stakeId);
        invalidatePerStakeQueries();
      }
      stripStakeParamFromUrl();
    }

    // Toast + overwrite-stale-storage handling.
    if (result.invalidatedTier !== null) {
      toastForInvalidatedTier(result.invalidatedTier, result.stakeId);
      // Overwrite the stale storage entries with the resolved stake so
      // the next read doesn't re-trigger the toast. When `stakeId` is
      // null (zero-role superadmin with stale storage) clear both
      // tiers.
      try {
        if (result.stakeId === null) {
          if (typeof window !== 'undefined') {
            try {
              window.sessionStorage.removeItem(ACTIVE_STAKE_SESSION_KEY);
              window.localStorage.removeItem(ACTIVE_STAKE_LOCAL_KEY);
            } catch {
              // ignore
            }
          }
        } else {
          persistChoiceCore(result.stakeId);
        }
      } catch {
        // ignore
      }
    }
    // Re-resolve when the principal claim set or the URL stake param
    // changes. The storage tiers are read fresh inside the effect.
  }, [principal, urlStakeParam]);

  return resolved.stakeId;
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
