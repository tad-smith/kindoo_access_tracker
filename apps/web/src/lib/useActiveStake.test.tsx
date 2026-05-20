// Component tests for `useActiveStake`. Covers:
//   - URL-tier hit: persists to both storage tiers, strips ?stake=X
//     via history.replaceState, returns the resolved stake.
//   - Re-resolve on subsequent navigations (SW notificationclick
//     deep-link arriving mid-lifecycle).
//   - Toast on URL-tier invalidation (spec wording).
//   - Toast on storage-tier invalidation (spec wording).
//   - null for zero-role platform superadmin.

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

// Spy on the toast push.
const toastSpy = vi.fn();
vi.mock('./store/toast', () => ({
  toast: (msg: string, kind: string) => toastSpy(msg, kind),
}));

import {
  notifyActiveStakeUrlNavigated,
  useActiveStake,
} from './useActiveStake';
import { ACTIVE_STAKE_LOCAL_KEY, ACTIVE_STAKE_SESSION_KEY } from './activeStake';

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
  toastSpy.mockClear();
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

  it('fires a warn toast with the push-notification copy on an invalid URL stake', () => {
    setUrl('/manager/dashboard?stake=foreign');
    render(<Probe onResult={() => {}} />);
    expect(toastSpy).toHaveBeenCalledWith(
      'This notification was for a stake you no longer have access to.',
      'warn',
    );
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

  it('fires the last-active-stake toast on stale session, includes the new stake name', () => {
    window.sessionStorage.setItem(ACTIVE_STAKE_SESSION_KEY, 'foreign');
    render(<Probe onResult={() => {}} />);
    expect(toastSpy).toHaveBeenCalledWith(
      'Your last-active stake is no longer available; switched to csnorth.',
      'warn',
    );
  });

  it('fires the last-active-stake toast on stale local', () => {
    window.localStorage.setItem(ACTIVE_STAKE_LOCAL_KEY, 'foreign');
    render(<Probe onResult={() => {}} />);
    expect(toastSpy).toHaveBeenCalledWith(
      'Your last-active stake is no longer available; switched to csnorth.',
      'warn',
    );
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
});
