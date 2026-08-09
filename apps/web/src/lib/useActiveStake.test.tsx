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
//   - For a settling (bootstrap-only) principal: the URL bar is
//     stripped immediately, but the module-scoped URL-tier value keeps
//     shadowing the `bootstrapStakes` answer absent a real router
//     navigation — a known bound, not a regression under test.
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
  // PR #258 reviewer finding, corrected: the original regression test
  // here manufactured the condition it claimed to test by calling
  // `notifyActiveStakeUrlNavigated()` directly. In the real flow that
  // function only fires from `main.tsx`'s `router.history.subscribe`
  // — a REAL router navigation. `stripStakeParamFromUrl()` uses
  // `history.replaceState` directly, which does not go through the
  // router's history instance and so does not fire that subscription.
  // A bootstrap-only principal parked on the wizard never navigates,
  // so the module-scoped URL slot is never re-read and a stale
  // `?stake=A` keeps shadowing tier 4's `bootstrapStakes` answer for
  // the rest of the tab's life. See the "Residual bound" comment above
  // `urlConsumeAllowedWhileSettling` in `useActiveStake.ts`.

  it('strips a stale ?stake=A from the URL bar immediately for a settling bootstrap-only principal', () => {
    setPrincipal({
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
      isAuthenticated: false,
      bootstrapStakes: ['ridgeline'],
    });
    setUrl('/manager/dashboard?stake=foreign');
    render(<Probe onResult={() => {}} />);
    // The strip itself doesn't need a router navigation (it's a plain
    // `history.replaceState` call) — a reload after this point would
    // not re-read 'foreign' off the URL bar, even though (see next
    // test) the in-memory answer still does.
    expect(window.location.search).not.toContain('stake=');
  });

  it('a stale ?stake=A keeps shadowing the bootstrapStakes answer absent a real router navigation', () => {
    setPrincipal({
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
      isAuthenticated: false,
      bootstrapStakes: ['ridgeline'],
    });
    setUrl('/manager/dashboard?stake=foreign');
    let result: string | null = null;
    const { rerender } = render(
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

    // No `popstate` and no `notifyActiveStakeUrlNavigated()` fire here
    // — this IS the parked-on-wizard case, not a stand-in for one.
    // Force a re-render the way any unrelated state change elsewhere
    // in the tree would; the module-scoped slot has no channel to
    // re-read the (already-stripped) URL without a navigation event,
    // so it keeps answering 'foreign' instead of falling through to
    // 'ridgeline'.
    rerender(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    expect(result).toBe('foreign');
  });

  it('a router navigation clears the stale slot and falls through to bootstrapStakes', async () => {
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
    expect(result).toBe('foreign');

    // `notifyActiveStakeUrlNavigated()` here stands in for a REAL
    // router navigation firing `main.tsx`'s `router.history.subscribe`
    // — NOT the parked-principal case above, where no navigation ever
    // happens. Only a real navigation (or `popstate`) re-runs
    // `refreshModuleUrlStakeParamFromUrl()` and clears the slot.
    await act(async () => {
      notifyActiveStakeUrlNavigated();
    });
    expect(result).toBe('ridgeline');
  });

  it('a legitimate invite deep-link for a bootstrap-only principal resolves to that stake on first render, no navigation required', () => {
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

// T-91. A platform superadmin holding no role on any stake is the one
// identity with NO tier-4 fallback: `accessibleStakes()` is empty, so
// the URL tier is its only route to an active stake. Every ordering
// hazard the other tiers paper over is load-bearing for it.
describe('useActiveStake — zero-role platform superadmin (T-91)', () => {
  function asZeroRoleSuperadmin() {
    setPrincipal({
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
      bootstrapStakes: [],
      isPlatformSuperadmin: true,
      isAuthenticated: true,
      firebaseAuthSignedIn: true,
    });
  }

  it('resolves ?stake=X and persists it', () => {
    asZeroRoleSuperadmin();
    setUrl('/manager/configuration?stake=highplains&tab=kindoo-sites');
    let result: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          result = v;
        }}
      />,
    );
    expect(result).toBe('highplains');
    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('highplains');
  });

  it('an instance mounted after the URL tier resolved still sees the stake', () => {
    // The real page mounts this hook many times (Shell, the route gate,
    // every per-stake data hook) and `usePrincipal` is PER-INSTANCE
    // state with its own async claims read — so instances settle at
    // different moments. An instance arriving after the first one
    // consumed the URL value has only storage to read, and the memo
    // that reads storage is keyed on `storageTick`, which nothing bumps
    // when the URL tier persists.
    asZeroRoleSuperadmin();
    setUrl('/manager/configuration?stake=highplains&tab=kindoo-sites');

    let first: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          first = v;
        }}
      />,
    );
    expect(first).toBe('highplains');

    // Second consumer mounts afterwards — URL already stripped+consumed.
    let second: string | null = null;
    render(
      <Probe
        onResult={(v) => {
          second = v;
        }}
      />,
    );
    expect(second).toBe('highplains');
  });

  it('keeps the stake across a re-render once the URL value is gone', () => {
    asZeroRoleSuperadmin();
    setUrl('/manager/configuration?stake=highplains');
    let latest: string | null = null;
    const { rerender } = render(
      <Probe
        onResult={(v) => {
          latest = v;
        }}
      />,
    );
    expect(latest).toBe('highplains');
    rerender(
      <Probe
        onResult={(v) => {
          latest = v;
        }}
      />,
    );
    expect(latest).toBe('highplains');
  });
});
