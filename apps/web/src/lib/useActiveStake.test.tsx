// Component tests for `useActiveStake`. Covers:
//   - URL-tier hit: persists to both storage tiers, strips ?stake=X
//     via history.replaceState, returns the resolved stake.
//   - Re-resolve on subsequent navigations (SW notificationclick
//     deep-link arriving mid-lifecycle).
//   - Invalidation event published on URL-tier invalidation.
//   - Invalidation event published on storage-tier invalidation.
//   - null for zero-role platform superadmin.
//
// Toast TEXT is owned by `<ActiveStakeToastBoundary>` (per item 7) so
// the storage-tier wording substitutes the display name. Those test
// cases live alongside the boundary in `ActiveStakeToastBoundary.test.tsx`.
// Here we assert that the hook publishes the right invalidation event
// (tier + new stake id) and that the dedupe holds across siblings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import type { Principal } from './principal';

// Bootstrap-discovery callable mock. `useActiveStakeInternal` reaches
// this via a dynamic `import('./resolveBootstrapStake')`; vitest's
// `vi.mock` intercepts dynamic imports the same as static ones.
const resolveBootstrapStakeMock = vi.fn<() => Promise<{ stakeIds: string[] }>>();
vi.mock('./resolveBootstrapStake', () => ({
  resolveBootstrapStake: () => resolveBootstrapStakeMock(),
}));

const mockedPrincipal: { current: Principal } = {
  current: {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'a@b.c',
    canonical: 'a@b.c',
    isPlatformSuperadmin: false,
    managerStakes: ['csnorth', 'ridgeline'],
    stakeMemberStakes: [],
    bishopricWards: {},
    limitedStakes: [],
    hasAnyRole: () => true,
    wardsInStake: () => [],
  },
};
vi.mock('./principal', () => ({
  usePrincipal: () => mockedPrincipal.current,
}));

// Spy on the invalidation publisher. We use `useActiveStakeInvalidation`
// (the public subscriber hook) inside a tiny Probe to capture events.
const invalidationEvents: Array<{
  tier: 'url' | 'session' | 'local';
  newStakeId: string | null;
  eventId: number;
}> = [];

import {
  __resetActiveStakeModuleForTests,
  notifyActiveStakeUrlNavigated,
  registerActiveStakeQueryClient,
  useAccessibleStakesWithBootstrap,
  useActiveStake,
  useActiveStakeInvalidation,
  useBootstrapStakeDiscoveryPending,
  type AccessibleStakeEntry,
} from './useActiveStake';
import { ACTIVE_STAKE_LOCAL_KEY, ACTIVE_STAKE_SESSION_KEY } from './activeStake';
import { useEffect } from 'react';

function InvalidationProbe() {
  const event = useActiveStakeInvalidation();
  useEffect(() => {
    if (event === null) return;
    invalidationEvents.push({ ...event });
  }, [event]);
  return null;
}

function Probe({ onResult }: { onResult: (v: string | null) => void }) {
  const id = useActiveStake();
  onResult(id);
  return null;
}

function DiscoveryPendingProbe({ onResult }: { onResult: (v: boolean) => void }) {
  const pending = useBootstrapStakeDiscoveryPending();
  onResult(pending);
  return null;
}

function AccessibleWithBootstrapProbe({
  onResult,
}: {
  onResult: (v: AccessibleStakeEntry[]) => void;
}) {
  const entries = useAccessibleStakesWithBootstrap();
  onResult(entries);
  return null;
}

function setPrincipal(overrides: Partial<Principal>) {
  mockedPrincipal.current = { ...mockedPrincipal.current, ...overrides };
}

function setUrl(pathWithQuery: string): void {
  window.history.replaceState({}, '', pathWithQuery);
}

beforeEach(() => {
  invalidationEvents.length = 0;
  if (typeof window !== 'undefined') {
    window.sessionStorage.clear();
    window.localStorage.clear();
    setUrl('/');
  }
  setPrincipal({
    managerStakes: ['csnorth', 'ridgeline'],
    stakeMemberStakes: [],
    bishopricWards: {},
    isPlatformSuperadmin: false,
  });
  // Reset the hook's module-scoped URL + invalidation state so each
  // test starts from the URL set above, not the one that lingered.
  __resetActiveStakeModuleForTests();
});

describe('useActiveStake — URL-tier handling', () => {
  it('reads a valid ?stake=X, persists to both storage tiers, returns the stake', () => {
    setUrl('/manager/dashboard?stake=ridgeline');
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    expect(result).toBe('ridgeline');
    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('ridgeline');
    expect(window.localStorage.getItem(ACTIVE_STAKE_LOCAL_KEY)).toBe('ridgeline');
  });

  it('strips ?stake=X from the URL via history.replaceState after resolving', () => {
    setUrl('/manager/dashboard?stake=ridgeline');
    render(<Probe onResult={() => {}} />);
    expect(window.location.search).not.toContain('stake=');
  });

  it('publishes a url-tier invalidation event on an invalid URL stake', () => {
    setUrl('/manager/dashboard?stake=foreign');
    render(
      <>
        <Probe onResult={() => {}} />
        <InvalidationProbe />
      </>,
    );
    const urlEvents = invalidationEvents.filter((e) => e.tier === 'url');
    expect(urlEvents).toHaveLength(1);
  });
});

describe('useActiveStake — storage-tier handling', () => {
  it('returns the sessionStorage value when no URL stake is present', () => {
    window.sessionStorage.setItem(ACTIVE_STAKE_SESSION_KEY, 'ridgeline');
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    expect(result).toBe('ridgeline');
  });

  it('returns the localStorage value when neither URL nor session is present', () => {
    window.localStorage.setItem(ACTIVE_STAKE_LOCAL_KEY, 'csnorth');
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    expect(result).toBe('csnorth');
  });

  it('publishes a session-tier invalidation event carrying the new stake id on stale session', () => {
    window.sessionStorage.setItem(ACTIVE_STAKE_SESSION_KEY, 'foreign');
    render(
      <>
        <Probe onResult={() => {}} />
        <InvalidationProbe />
      </>,
    );
    const sessionEvents = invalidationEvents.filter((e) => e.tier === 'session');
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]?.newStakeId).toBe('csnorth');
  });

  it('publishes a local-tier invalidation event on stale local', () => {
    window.localStorage.setItem(ACTIVE_STAKE_LOCAL_KEY, 'foreign');
    render(
      <>
        <Probe onResult={() => {}} />
        <InvalidationProbe />
      </>,
    );
    const localEvents = invalidationEvents.filter((e) => e.tier === 'local');
    expect(localEvents).toHaveLength(1);
    expect(localEvents[0]?.newStakeId).toBe('csnorth');
  });
});

describe('useActiveStake — principal-derived fallback', () => {
  it('returns the alphabetically-first accessible stake when no URL/session/local is set', () => {
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    // ['csnorth', 'ridgeline'] → 'csnorth' is alphabetically first.
    expect(result).toBe('csnorth');
  });

  it('returns null for a zero-role platform superadmin', () => {
    setPrincipal({
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
      isPlatformSuperadmin: true,
    });
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    expect(result).toBeNull();
  });
});

describe('useActiveStake — re-resolve on URL navigation', () => {
  it('re-runs the resolve step when notifyActiveStakeUrlNavigated() fires after a router push', async () => {
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    expect(result).toBe('csnorth'); // principal-derived first stake

    // Simulate a SW notificationclick → router.history.push that
    // landed a new URL with ?stake=ridgeline. main.tsx's router
    // subscriber would fire `notifyActiveStakeUrlNavigated()` next.
    await act(async () => {
      window.history.replaceState({}, '', '/manager/dashboard?stake=ridgeline');
      notifyActiveStakeUrlNavigated();
    });
    expect(result).toBe('ridgeline');
    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('ridgeline');
  });

  it('strips ?stake=X from the URL on a same-value re-arrival (item 4)', async () => {
    // First arrival: ?stake=csnorth lands, hook strips it.
    setUrl('/manager/dashboard?stake=csnorth');
    render(<Probe onResult={() => {}} />);
    expect(window.location.search).not.toContain('stake=');

    // Same stake re-arrives in the URL (e.g., a Stake List click on
    // the currently-active stake fires another router push). The
    // module's same-value early-return must NOT suppress the URL
    // strip — `?stake=csnorth` would otherwise linger in the address
    // bar.
    await act(async () => {
      window.history.replaceState({}, '', '/manager/dashboard?stake=csnorth');
      notifyActiveStakeUrlNavigated();
    });
    expect(window.location.search).not.toContain('stake=');
  });
});

describe('useActiveStake — invalidation event dedupe across hook instances (item 1)', () => {
  it('publishes exactly one URL-tier invalidation event even when multiple hook instances are mounted', () => {
    // Reproduce the Shell + AuthedLayout + useRequireRole + per-
    // feature-data-hook tree by mounting three concurrent consumers.
    // The module-scoped dedupe ensures only the first instance fires.
    setUrl('/manager/dashboard?stake=foreign');
    render(
      <>
        <Probe onResult={() => {}} />
        <Probe onResult={() => {}} />
        <Probe onResult={() => {}} />
        <InvalidationProbe />
      </>,
    );
    const urlEvents = invalidationEvents.filter((e) => e.tier === 'url');
    expect(urlEvents).toHaveLength(1);
  });

  it('publishes exactly one storage-tier invalidation event even when multiple hook instances are mounted', () => {
    window.sessionStorage.setItem(ACTIVE_STAKE_SESSION_KEY, 'foreign');
    render(
      <>
        <Probe onResult={() => {}} />
        <Probe onResult={() => {}} />
        <Probe onResult={() => {}} />
        <InvalidationProbe />
      </>,
    );
    const storageEvents = invalidationEvents.filter(
      (e) => e.tier === 'session' || e.tier === 'local',
    );
    expect(storageEvents).toHaveLength(1);
  });
});

describe('useActiveStake — bootstrap-stake discovery', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    registerActiveStakeQueryClient(queryClient);
    resolveBootstrapStakeMock.mockReset();
    resolveBootstrapStakeMock.mockResolvedValue({ stakeIds: [] });
  });

  afterEach(() => {
    registerActiveStakeQueryClient(null);
    queryClient.clear();
  });

  it('fires resolveBootstrapStake for a zero-claim, non-superadmin principal and auto-selects the discovered stake', async () => {
    // The original bug fix: a fresh bootstrap admin (zero role claims)
    // auto-selects the stake `resolveBootstrapStake` found for them.
    resolveBootstrapStakeMock.mockResolvedValue({ stakeIds: ['ridgeline'] });
    setPrincipal({ managerStakes: [], stakeMemberStakes: [], bishopricWards: {} });
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    await waitFor(() => expect(resolveBootstrapStakeMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result).toBe('ridgeline'));
  });

  it('fires resolveBootstrapStake even for a principal who already has claims elsewhere', async () => {
    // Per the revised design there is no client-side signal for "is
    // this user a bootstrap admin somewhere," so discovery runs for
    // EVERY signed-in identity, not just zero-claims ones.
    setPrincipal({ managerStakes: ['csnorth'], stakeMemberStakes: [], bishopricWards: {} });
    render(<Probe onResult={() => {}} />);
    await waitFor(() => expect(resolveBootstrapStakeMock).toHaveBeenCalledTimes(1));
  });

  it('does not fire when no QueryClient is registered (discovery-incapable environment)', async () => {
    registerActiveStakeQueryClient(null);
    setPrincipal({ managerStakes: [], stakeMemberStakes: [], bishopricWards: {} });
    render(<Probe onResult={() => {}} />);
    // Flush microtasks; nothing should have fired.
    await act(async () => {});
    expect(resolveBootstrapStakeMock).not.toHaveBeenCalled();
  });

  it('fires the callable only once even when multiple hook instances mount', async () => {
    setPrincipal({ managerStakes: [], stakeMemberStakes: [], bishopricWards: {} });
    render(
      <>
        <Probe onResult={() => {}} />
        <Probe onResult={() => {}} />
        <Probe onResult={() => {}} />
      </>,
    );
    await waitFor(() => expect(resolveBootstrapStakeMock).toHaveBeenCalledTimes(1));
  });

  it('manager of A who is also the bootstrap admin of not-yet-setup B: active stake stays A, B appears in the switcher source flagged needsSetup', async () => {
    resolveBootstrapStakeMock.mockResolvedValue({ stakeIds: ['ridgeline'] });
    setPrincipal({ managerStakes: ['csnorth'], stakeMemberStakes: [], bishopricWards: {} });
    let stakeId: string | null = null;
    let entries: AccessibleStakeEntry[] = [];
    render(
      <>
        <Probe
          onResult={(v) => {
            stakeId = v;
          }}
        />
        <AccessibleWithBootstrapProbe
          onResult={(v) => {
            entries = v;
          }}
        />
      </>,
    );
    await waitFor(() => expect(resolveBootstrapStakeMock).toHaveBeenCalledTimes(1));
    // Claim-derived stake wins tier 4 — never auto-switched into B.
    expect(stakeId).toBe('csnorth');
    await waitFor(() =>
      expect(entries).toEqual([
        { stakeId: 'csnorth', needsSetup: false },
        { stakeId: 'ridgeline', needsSetup: true },
      ]),
    );
  });

  it('zero-claims platform superadmin who is also the bootstrap admin of B is not auto-switched into B', async () => {
    resolveBootstrapStakeMock.mockResolvedValue({ stakeIds: ['ridgeline'] });
    setPrincipal({
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
      isPlatformSuperadmin: true,
    });
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    await waitFor(() => expect(resolveBootstrapStakeMock).toHaveBeenCalledTimes(1));
    // Give the resolved memo a chance to recompute post-discovery.
    await act(async () => {});
    expect(result).toBeNull();
  });

  it('discoveryPending is true then false for a zero-claims, non-superadmin principal as the callable resolves', async () => {
    const resolveCallable: { current: ((value: { stakeIds: string[] }) => void) | null } = {
      current: null,
    };
    resolveBootstrapStakeMock.mockReturnValue(
      new Promise<{ stakeIds: string[] }>((resolve) => {
        resolveCallable.current = resolve;
      }),
    );
    setPrincipal({ managerStakes: [], stakeMemberStakes: [], bishopricWards: {} });
    let pending: boolean | null = null;
    render(
      <DiscoveryPendingProbe
        onResult={(v) => {
          pending = v;
        }}
      />,
    );
    await waitFor(() => expect(pending).toBe(true));
    await act(async () => {
      resolveCallable.current?.({ stakeIds: [] });
    });
    await waitFor(() => expect(pending).toBe(false));
  });

  it('a claim-bearing principal does not block on discoveryPending', async () => {
    const resolveCallable: { current: ((value: { stakeIds: string[] }) => void) | null } = {
      current: null,
    };
    resolveBootstrapStakeMock.mockReturnValue(
      new Promise<{ stakeIds: string[] }>((resolve) => {
        resolveCallable.current = resolve;
      }),
    );
    setPrincipal({ managerStakes: ['csnorth'], stakeMemberStakes: [], bishopricWards: {} });
    let pending: boolean | null = null;
    render(
      <DiscoveryPendingProbe
        onResult={(v) => {
          pending = v;
        }}
      />,
    );
    await waitFor(() => expect(resolveBootstrapStakeMock).toHaveBeenCalledTimes(1));
    // Discovery is in flight (never resolved), yet a claims-bearing
    // principal must never report pending — they render their normal
    // landing page immediately.
    expect(pending).toBe(false);
    resolveCallable.current?.({ stakeIds: [] });
  });

  it('a bootstrap-only stake already persisted to sessionStorage resolves once discovery confirms it', async () => {
    // Simulates "selecting B persists and resolves to B on the next
    // render": a prior switcher click wrote 'ridgeline' to
    // sessionStorage; once discovery confirms this identity is B's
    // bootstrap admin, the session-tier value validates normally.
    resolveBootstrapStakeMock.mockResolvedValue({ stakeIds: ['ridgeline'] });
    setPrincipal({ managerStakes: ['csnorth'], stakeMemberStakes: [], bishopricWards: {} });
    window.sessionStorage.setItem(ACTIVE_STAKE_SESSION_KEY, 'ridgeline');
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    await waitFor(() => expect(resolveBootstrapStakeMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result).toBe('ridgeline'));
    // Regression guard: the pre-discovery "invalid" pass must NEVER
    // have overwritten sessionStorage with the tier-4 fallback
    // ('csnorth') — that would permanently lose the bootstrap-stake
    // choice before discovery got a chance to confirm it.
    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('ridgeline');
  });

  it('a URL-tier hit that is ALREADY valid via claims persists and strips immediately, without waiting on discovery', async () => {
    // Narrow-fix regression guard: only the toast/overwrite-stale-
    // storage block defers on `discoverySettling`. A `?stake=X` link
    // for a stake the principal already has a CLAIM-derived role on is
    // valid the instant it's read — it must not wait on an unrelated
    // bootstrap-discovery round-trip to strip the URL / persist to
    // storage.
    resolveBootstrapStakeMock.mockReturnValue(new Promise<{ stakeIds: string[] }>(() => {})); // never resolves
    setPrincipal({ managerStakes: ['csnorth'], stakeMemberStakes: [], bishopricWards: {} });
    setUrl('/manager/dashboard?stake=csnorth');
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    await waitFor(() => expect(resolveBootstrapStakeMock).toHaveBeenCalledTimes(1));
    // Discovery never resolves in this test, yet the already-valid URL
    // hit must persist + strip on its own.
    await waitFor(() => expect(window.location.search).not.toContain('stake='));
    expect(result).toBe('csnorth');
    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('csnorth');
  });
});
