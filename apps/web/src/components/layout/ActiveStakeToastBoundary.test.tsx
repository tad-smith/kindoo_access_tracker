// Component tests for `<ActiveStakeToastBoundary>`. Covers:
//   - URL-tier invalidation: fires the fixed push-notification copy.
//   - Storage-tier invalidation with newStakeId === null: fires the
//     short-form last-active-stake copy.
//   - Storage-tier invalidation with newStakeId set: substitutes the
//     stake's DISPLAY NAME from the live doc (item 7 — not the slug).
//   - Same event is not toasted twice even on a re-mount.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import type { Stake } from '@kindoo/shared';
import {
  ActiveStakeToastBoundary,
  __resetActiveStakeToastBoundaryForTests,
} from './ActiveStakeToastBoundary';

const toastSpy = vi.fn();
vi.mock('../../lib/store/toast', () => ({
  toast: (msg: string, kind: string) => toastSpy(msg, kind),
}));

// Per-stake-id stake-doc fixture. Tests can mutate before render to
// control what `useFirestoreDoc` returns for the post-fall-through
// stake.
const stakeDocFixture: {
  byId: Map<string, Partial<Stake>>;
  status: 'pending' | 'success';
} = {
  byId: new Map(),
  status: 'success',
};

vi.mock('../../lib/data', () => ({
  useFirestoreDoc: (ref: { id?: string } | null) => {
    if (!ref) {
      return { data: undefined, status: 'success', isLoading: false };
    }
    return {
      data: stakeDocFixture.byId.get(ref.id ?? ''),
      status: stakeDocFixture.status,
      isLoading: stakeDocFixture.status === 'pending',
    };
  },
}));

vi.mock('../../lib/firebase', () => ({ db: {} }));
vi.mock('../../lib/docs', () => ({
  stakeRef: (_db: unknown, stakeId: string) => ({ id: stakeId }),
}));

// Events arrive via the same publisher the real `useActiveStake` uses.
// We drive them by mounting a Probe that runs the hook with controlled
// principal + storage state.
import { __resetActiveStakeModuleForTests, useActiveStake } from '../../lib/useActiveStake';

function ProbeRunningHook() {
  useActiveStake();
  return null;
}

function setUrl(pathWithQuery: string): void {
  window.history.replaceState({}, '', pathWithQuery);
}

const basePrincipal = {
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
};
const mockedPrincipal: { current: typeof basePrincipal } = { current: basePrincipal };
vi.mock('../../lib/principal', () => ({
  usePrincipal: () => mockedPrincipal.current,
}));

beforeEach(() => {
  toastSpy.mockClear();
  stakeDocFixture.byId = new Map();
  stakeDocFixture.status = 'success';
  mockedPrincipal.current = basePrincipal;
  if (typeof window !== 'undefined') {
    window.sessionStorage.clear();
    window.localStorage.clear();
    setUrl('/');
  }
  __resetActiveStakeToastBoundaryForTests();
  __resetActiveStakeModuleForTests();
});

describe('ActiveStakeToastBoundary', () => {
  it('fires the URL-tier toast when a url invalidation event publishes', () => {
    setUrl('/manager/dashboard?stake=foreign');
    render(
      <>
        <ProbeRunningHook />
        <ActiveStakeToastBoundary />
      </>,
    );
    expect(toastSpy).toHaveBeenCalledWith(
      'This notification was for a stake you no longer have access to.',
      'warn',
    );
  });

  it('substitutes the stake display name in the storage-tier toast (item 7)', () => {
    // `useActiveStake` resolves session: 'foreign' to fall through to
    // principal-derived 'csnorth'. The boundary reads the 'csnorth'
    // stake doc and substitutes the display name into the toast.
    window.sessionStorage.setItem('kindoo.activeStake', 'foreign');
    stakeDocFixture.byId.set('csnorth', {
      stake_id: 'csnorth',
      stake_name: 'CS North Stake',
    });
    render(
      <>
        <ProbeRunningHook />
        <ActiveStakeToastBoundary />
      </>,
    );
    expect(toastSpy).toHaveBeenCalledWith(
      'Your last-active stake is no longer available; switched to CS North Stake.',
      'warn',
    );
    // The slug should NOT be the user-visible substitution.
    const slugCalls = toastSpy.mock.calls.filter(([msg]) =>
      (msg as string).includes('switched to csnorth'),
    );
    expect(slugCalls).toHaveLength(0);
  });

  it('falls back to the slug if the stake doc has no stake_name field set', () => {
    // The doc exists but stake_name is absent — the boundary uses the
    // slug as the substitution.
    window.sessionStorage.setItem('kindoo.activeStake', 'foreign');
    stakeDocFixture.byId.set('csnorth', { stake_id: 'csnorth' });
    render(
      <>
        <ProbeRunningHook />
        <ActiveStakeToastBoundary />
      </>,
    );
    expect(toastSpy).toHaveBeenCalledWith(
      'Your last-active stake is no longer available; switched to csnorth.',
      'warn',
    );
  });

  it('fires the short-form copy when the resolver lands on null (zero-role superadmin)', () => {
    // Item 8: zero-role superadmin with stale storage from a prior
    // session must see the storage tier invalidated (NOT silently
    // resumed). The toast wording drops the "switched to <name>" tail
    // because there's no new stake to substitute — the resolver fell
    // through to `null` and the route gate sends the user to
    // `/superadmin/stakes`.
    mockedPrincipal.current = {
      ...basePrincipal,
      isPlatformSuperadmin: true,
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
    };
    window.sessionStorage.setItem('kindoo.activeStake', 'foreign');
    render(
      <>
        <ProbeRunningHook />
        <ActiveStakeToastBoundary />
      </>,
    );
    expect(toastSpy).toHaveBeenCalledWith('Your last-active stake is no longer available.', 'warn');
    // The "switched to" half must NOT appear — there is no new stake.
    const switchedToCalls = toastSpy.mock.calls.filter(([msg]) =>
      (msg as string).includes('switched to'),
    );
    expect(switchedToCalls).toHaveLength(0);
  });

  it('does not double-fire on a Shell remount of the same logical event', async () => {
    setUrl('/manager/dashboard?stake=foreign');
    const { unmount } = render(
      <>
        <ProbeRunningHook />
        <ActiveStakeToastBoundary />
      </>,
    );
    expect(toastSpy).toHaveBeenCalledTimes(1);

    // Simulate a Shell remount (e.g., navigation through an
    // unauth/sign-in flow that unmounts Shell, then back).
    unmount();
    await act(async () => {
      render(<ActiveStakeToastBoundary />);
    });
    // Still exactly one toast — module-scope dedupe held.
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });
});
