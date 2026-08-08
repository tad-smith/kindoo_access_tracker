// Component tests for `useActiveStake`. Covers:
//   - URL-tier hit: persists to both storage tiers, strips ?stake=X
//     via history.replaceState, returns the resolved stake.
//   - Re-resolve on subsequent navigations (SW notificationclick
//     deep-link arriving mid-lifecycle).
//   - Invalidation event published on URL-tier invalidation.
//   - Invalidation event published on storage-tier invalidation.
//   - null for zero-role platform superadmin.
//   - `principal.bootstrapStakes` widening tiers 1-4 and feeding the
//     StakeSwitcher's menu source (`useAccessibleStakesWithBootstrap`).
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
    limitedStakes: [],
    bootstrapStakes: [],
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
  useAccessibleStakesWithBootstrap,
  useActiveStake,
  useActiveStakeInvalidation,
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
    bootstrapStakes: [],
    // Explicit (not just relying on the module-level initial value) so
    // a test that flips this to `false` (a settling/bootstrap-only
    // principal) can't leak it into the next test.
    isAuthenticated: true,
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

describe('useActiveStake — principal.bootstrapStakes (claims-derived, synchronous)', () => {
  it('a fresh bootstrap admin (zero role claims) auto-selects the stake named in bootstrapStakes', () => {
    // The original bug fix, now driven synchronously off the token:
    // no callable, no discovery round-trip — the claim is already on
    // the principal by the time this hook first renders.
    setPrincipal({
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
      bootstrapStakes: ['ridgeline'],
    });
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

  it('manager of A who is also the bootstrap admin of not-yet-setup B: active stake stays A, B appears in the switcher source flagged needsSetup', () => {
    setPrincipal({
      managerStakes: ['csnorth'],
      stakeMemberStakes: [],
      bishopricWards: {},
      bootstrapStakes: ['ridgeline'],
    });
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
    // Claim-derived stake wins tier 4 — never auto-switched into B.
    expect(stakeId).toBe('csnorth');
    expect(entries).toEqual([
      { stakeId: 'csnorth', needsSetup: false },
      { stakeId: 'ridgeline', needsSetup: true },
    ]);
  });

  it('zero-claims platform superadmin who is also the bootstrap admin of B is not auto-switched into B', () => {
    setPrincipal({
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
      isPlatformSuperadmin: true,
      bootstrapStakes: ['ridgeline'],
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

  it('regression: a bootstrap-only stake already persisted to sessionStorage is never clobbered by the tier-4 fallback', () => {
    // The hazard the old async-discovery code guarded against with a
    // `discoverySettling` defer: a stale-looking storage value that's
    // actually valid must not get overwritten before the data that
    // would validate it is available. Now that bootstrapStakes rides
    // the same synchronous token read as every other claim, there is
    // no window where the resolver sees a principal with the OLD
    // (narrower) bootstrap set while storage already holds the NEW
    // stake — the principal used to resolve and the principal used to
    // validate are the same object on the same render. Pin the
    // no-clobber behavior directly.
    setPrincipal({
      managerStakes: ['csnorth'],
      stakeMemberStakes: [],
      bishopricWards: {},
      bootstrapStakes: ['ridgeline'],
    });
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
    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('ridgeline');
  });

  it('a URL-tier hit for a claim-derived stake persists and strips immediately regardless of bootstrapStakes', () => {
    setPrincipal({
      managerStakes: ['csnorth'],
      stakeMemberStakes: [],
      bishopricWards: {},
      bootstrapStakes: [],
    });
    setUrl('/manager/dashboard?stake=csnorth');
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    expect(window.location.search).not.toContain('stake=');
    expect(result).toBe('csnorth');
    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('csnorth');
  });
});

describe('useActiveStake — URL-tier consume for a settling (bootstrap-only) principal', () => {
  // PR #258 reviewer finding: D29(b) argues a URL value can't compound
  // into a permanent trap because it's consumed exactly once. That
  // precondition didn't hold for a zero-role, bootstrap-only principal
  // — `isAuthenticated` deliberately never flips true for `bootstrap`,
  // so a consume gated on `!principalSettling` alone never ran, and a
  // stale/invalid `?stake=X` shadowed the `bootstrapStakes` answer for
  // the tab's lifetime.

  it('a stale ?stake=A does not permanently shadow the bootstrapStakes answer for a zero-role bootstrap-only principal', async () => {
    setPrincipal({
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
      isAuthenticated: false,
      bootstrapStakes: ['ridgeline'],
    });
    setUrl('/manager/dashboard?stake=foreign');
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    // First pass: the URL is explicit, present-tense intent, so it
    // wins even though 'foreign' isn't in this principal's accessible
    // or bootstrap set (`isPermissiveUrl` in activeStake.ts).
    expect(result).toBe('foreign');

    // Simulate the next resolve — a subsequent router-history
    // navigation re-checking the URL, the same trigger `main.tsx` uses
    // for SW-notificationclick deep links. The URL was already
    // stripped; the consumed value must not keep resurrecting
    // 'foreign' from module state — it must fall through to tier 4's
    // bootstrapStakes answer instead. Without the fix this stays
    // 'foreign' forever.
    await act(async () => {
      notifyActiveStakeUrlNavigated();
    });
    expect(result).toBe('ridgeline');
  });

  it('a legitimate invite deep-link for a bootstrap-only principal still resolves to that stake on first navigation', () => {
    setPrincipal({
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
      isAuthenticated: false,
      bootstrapStakes: ['ridgeline'],
    });
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
  });

  it('existing URL-tier behaviour for a claim-bearing (non-settling) principal is unchanged', () => {
    setPrincipal({
      managerStakes: ['csnorth', 'ridgeline'],
      stakeMemberStakes: [],
      bishopricWards: {},
      bootstrapStakes: [],
      isAuthenticated: true,
    });
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
    expect(window.location.search).not.toContain('stake=');
    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('ridgeline');
    expect(window.localStorage.getItem(ACTIVE_STAKE_LOCAL_KEY)).toBe('ridgeline');
  });
});
