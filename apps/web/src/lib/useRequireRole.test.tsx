// Unit tests for `useRequireRole`. Three states under test:
//   - loading       → no redirect, ready=false, allowed=false
//   - allowed       → no redirect, ready=true,  allowed=true
//   - not-allowed   → redirect fired, ready=true, allowed=false
//
// Plus the `holdsAnyRole` predicate, exercised directly so the per-
// route gate tests can lean on it indirectly through the hook.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Principal } from './principal';

const mockedPrincipal: { current: Principal } = {
  current: {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'a@x.com',
    canonical: 'a@x.com',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => false,
    wardsInStake: () => [],
  },
};

vi.mock('./principal', () => ({
  usePrincipal: () => mockedPrincipal.current,
}));

const navigateMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import { holdsAnyRole, useRequireRole, type RequiredRole } from './useRequireRole';
import { STAKE_ID } from './constants';

function setPrincipal(overrides: Partial<Principal>) {
  mockedPrincipal.current = { ...mockedPrincipal.current, ...overrides };
}

function Probe({
  role,
  redirectTo,
  onResult,
}: {
  role: RequiredRole | RequiredRole[];
  redirectTo?: string;
  onResult: (result: { ready: boolean; allowed: boolean }) => void;
}) {
  const result = redirectTo ? useRequireRole(role, { redirectTo }) : useRequireRole(role);
  onResult(result);
  return null;
}

beforeEach(() => {
  navigateMock.mockClear();
  mockedPrincipal.current = {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'a@x.com',
    canonical: 'a@x.com',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => false,
    wardsInStake: () => [],
  };
});

describe('useRequireRole', () => {
  it('returns ready=false / allowed=false and does not redirect during the principal-loading window', () => {
    // Past the upstream `_authed` gate, the combination
    // `firebaseAuthSignedIn && !isAuthenticated` means claims are
    // still being fetched.
    setPrincipal({
      firebaseAuthSignedIn: true,
      isAuthenticated: false,
      canonical: '',
      managerStakes: [],
      isPlatformSuperadmin: false,
    });
    let captured: { ready: boolean; allowed: boolean } | null = null;
    render(<Probe role="manager" onResult={(r) => (captured = r)} />);
    expect(captured).toEqual({ ready: false, allowed: false });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('returns ready=true / allowed=true for a principal holding the required role', () => {
    setPrincipal({
      isAuthenticated: true,
      managerStakes: [STAKE_ID],
    });
    let captured: { ready: boolean; allowed: boolean } | null = null;
    render(<Probe role="manager" onResult={(r) => (captured = r)} />);
    expect(captured).toEqual({ ready: true, allowed: true });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('returns ready=true / allowed=true for a platform superadmin regardless of role', () => {
    setPrincipal({
      isAuthenticated: true,
      isPlatformSuperadmin: true,
    });
    let captured: { ready: boolean; allowed: boolean } | null = null;
    render(<Probe role="bishopric" onResult={(r) => (captured = r)} />);
    expect(captured).toEqual({ ready: true, allowed: true });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('returns ready=true / allowed=true for a Kindoo Manager against a stake role gate', () => {
    // Managers administer the entire app; the stake gate must accept
    // a manager who is not literally a stake member.
    setPrincipal({
      isAuthenticated: true,
      managerStakes: [STAKE_ID],
      stakeMemberStakes: [],
      bishopricWards: {},
      isPlatformSuperadmin: false,
    });
    let captured: { ready: boolean; allowed: boolean } | null = null;
    render(<Probe role="stake" onResult={(r) => (captured = r)} />);
    expect(captured).toEqual({ ready: true, allowed: true });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('returns ready=true / allowed=true for a Kindoo Manager against a bishopric role gate', () => {
    // Same superset rule for the bishopric gate.
    setPrincipal({
      isAuthenticated: true,
      managerStakes: [STAKE_ID],
      stakeMemberStakes: [],
      bishopricWards: {},
      isPlatformSuperadmin: false,
    });
    let captured: { ready: boolean; allowed: boolean } | null = null;
    render(<Probe role="bishopric" onResult={(r) => (captured = r)} />);
    expect(captured).toEqual({ ready: true, allowed: true });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('redirects to / by default when the principal lacks the required role', () => {
    setPrincipal({
      isAuthenticated: true,
      stakeMemberStakes: [STAKE_ID],
    });
    let captured: { ready: boolean; allowed: boolean } | null = null;
    render(<Probe role="manager" onResult={(r) => (captured = r)} />);
    expect(captured).toEqual({ ready: true, allowed: false });
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('redirects to the configured redirectTo when the principal lacks the required role', () => {
    setPrincipal({
      isAuthenticated: true,
      stakeMemberStakes: [STAKE_ID],
    });
    render(<Probe role="manager" redirectTo="/new" onResult={() => {}} />);
    expect(navigateMock).toHaveBeenCalledWith({ to: '/new', replace: true });
  });

  it('accepts an either-of array of roles', () => {
    setPrincipal({
      isAuthenticated: true,
      bishopricWards: { [STAKE_ID]: ['CO'] },
    });
    let captured: { ready: boolean; allowed: boolean } | null = null;
    render(<Probe role={['stake', 'bishopric']} onResult={(r) => (captured = r)} />);
    expect(captured).toEqual({ ready: true, allowed: true });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('redirects when the principal holds none of an either-of role array', () => {
    setPrincipal({
      isAuthenticated: true,
      stakeMemberStakes: [STAKE_ID],
    });
    let captured: { ready: boolean; allowed: boolean } | null = null;
    render(<Probe role={['manager', 'bishopric']} onResult={(r) => (captured = r)} />);
    expect(captured).toEqual({ ready: true, allowed: false });
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
  });
});

describe('holdsAnyRole', () => {
  function principal(overrides: Partial<Principal> = {}): Principal {
    return {
      isAuthenticated: true,
      firebaseAuthSignedIn: true,
      email: 'a@x.com',
      canonical: 'a@x.com',
      isPlatformSuperadmin: false,
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
      hasAnyRole: () => false,
      wardsInStake: () => [],
      ...overrides,
    };
  }

  it('returns true for a manager when manager is required', () => {
    expect(holdsAnyRole(principal({ managerStakes: [STAKE_ID] }), ['manager'])).toBe(true);
  });

  it('returns true for a bishopric user when bishopric is required', () => {
    expect(holdsAnyRole(principal({ bishopricWards: { [STAKE_ID]: ['CO'] } }), ['bishopric'])).toBe(
      true,
    );
  });

  it('returns true for a stake-member user when stake is required', () => {
    expect(holdsAnyRole(principal({ stakeMemberStakes: [STAKE_ID] }), ['stake'])).toBe(true);
  });

  it('returns true for a superadmin against any role', () => {
    expect(holdsAnyRole(principal({ isPlatformSuperadmin: true }), ['manager'])).toBe(true);
    expect(holdsAnyRole(principal({ isPlatformSuperadmin: true }), ['bishopric'])).toBe(true);
    expect(holdsAnyRole(principal({ isPlatformSuperadmin: true }), ['stake'])).toBe(true);
  });

  it('returns true for a Kindoo Manager against any role gate', () => {
    // Managers are an implicit superset: a manager in STAKE_ID passes
    // a stake or bishopric gate without literally holding those roles.
    const manager = principal({ managerStakes: [STAKE_ID] });
    expect(holdsAnyRole(manager, ['manager'])).toBe(true);
    expect(holdsAnyRole(manager, ['stake'])).toBe(true);
    expect(holdsAnyRole(manager, ['bishopric'])).toBe(true);
  });

  it('does not let a manager in a different stake bypass STAKE_ID gates', () => {
    // The manager-superset short-circuit must scope to STAKE_ID.
    const otherStakeManager = principal({ managerStakes: ['other-stake'] });
    expect(holdsAnyRole(otherStakeManager, ['stake'])).toBe(false);
    expect(holdsAnyRole(otherStakeManager, ['bishopric'])).toBe(false);
  });

  it('returns false for an empty bishopricWards array on the stake', () => {
    expect(holdsAnyRole(principal({ bishopricWards: { [STAKE_ID]: [] } }), ['bishopric'])).toBe(
      false,
    );
  });

  it('returns false for a role in a different stake', () => {
    expect(holdsAnyRole(principal({ managerStakes: ['other-stake'] }), ['manager'])).toBe(false);
  });

  it('returns true if any of an array of required roles match', () => {
    expect(holdsAnyRole(principal({ stakeMemberStakes: [STAKE_ID] }), ['manager', 'stake'])).toBe(
      true,
    );
  });

  it('returns false when no required role matches', () => {
    expect(
      holdsAnyRole(principal({ stakeMemberStakes: [STAKE_ID] }), ['manager', 'bishopric']),
    ).toBe(false);
  });
});
