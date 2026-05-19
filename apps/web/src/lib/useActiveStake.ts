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
// their queries so TanStack Query stays disabled.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
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
 */
function invalidatePerStakeQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: [FIRESTORE_QUERY_KEY_PREFIX] }).catch(() => {});
}

/**
 * Surface the spec's toast for an invalidated tier (`spec.md` §2.1).
 * URL-tier invalidations show the push-notification copy; storage-tier
 * invalidations show the last-active-stake copy.
 */
function toastForInvalidatedTier(tier: 'url' | 'session' | 'local', newStakeId: string | null): void {
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
 *     caches.
 *   - On invalidated tier: shows a toast and overwrites the stale
 *     storage value with the resolved stake (or clears it when the
 *     resolved stake is null).
 */
export function useActiveStake(): string | null {
  const principal = usePrincipal();
  const queryClient = useQueryClient();

  // Track the URL `?stake=X` value through router navigations. The
  // hook re-runs the priority chain whenever this value or the
  // principal changes. We use `useRouterState` so service-worker-
  // driven router pushes (the notificationclick deep-link path)
  // trigger the re-resolve mid-lifecycle.
  const urlStakeParam = useRouterState({
    select: (s) => {
      const search = s.location.search as Record<string, unknown> | undefined;
      const raw = search?.[STAKE_PARAM];
      return typeof raw === 'string' && raw.length > 0 ? raw : null;
    },
  });

  const [resolved, setResolved] = useState<ResolveActiveStakeResult>(() => ({
    stakeId: null,
    source: 'none',
    invalidatedTier: null,
  }));

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
        invalidatePerStakeQueries(queryClient);
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
    // changes. The storage tiers are read fresh inside the effect; a
    // storage write from elsewhere (switcher) calls
    // `persistActiveStakeChoice` then triggers its own re-render path
    // via TanStack Query invalidation.
  }, [principal, urlStakeParam, queryClient]);

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
      invalidatePerStakeQueries(queryClient);
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
