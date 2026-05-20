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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import type { Principal } from './principal';

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
  useActiveStake,
  useActiveStakeInvalidation,
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
