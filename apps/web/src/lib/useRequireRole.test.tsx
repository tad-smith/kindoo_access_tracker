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

const STAKE_ID = 'csnorth';
vi.mock('./useActiveStake', () => ({
  useActiveStake: () => STAKE_ID,
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

  it('redirects a manager-without-superadmin from a platformSuperadmin-only gate', () => {
    setPrincipal({
      isAuthenticated: true,
      managerStakes: [STAKE_ID],
      isPlatformSuperadmin: false,
    });
    let captured: { ready: boolean; allowed: boolean } | null = null;
    render(<Probe role="platformSuperadmin" onResult={(r) => (captured = r)} />);
    expect(captured).toEqual({ ready: true, allowed: false });
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('admits a platform superadmin to a platformSuperadmin-only gate', () => {
    setPrincipal({
      isAuthenticated: true,
      isPlatformSuperadmin: true,
    });
    let captured: { ready: boolean; allowed: boolean } | null = null;
    render(<Probe role="platformSuperadmin" onResult={(r) => (captured = r)} />);
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
    expect(holdsAnyRole(principal({ managerStakes: [STAKE_ID] }), ['manager'], STAKE_ID)).toBe(
      true,
    );
  });

  it('returns true for a bishopric user when bishopric is required', () => {
    expect(
      holdsAnyRole(principal({ bishopricWards: { [STAKE_ID]: ['CO'] } }), ['bishopric'], STAKE_ID),
    ).toBe(true);
  });

  it('returns true for a stake-member user when stake is required', () => {
    expect(holdsAnyRole(principal({ stakeMemberStakes: [STAKE_ID] }), ['stake'], STAKE_ID)).toBe(
      true,
    );
  });

  it('returns true for a superadmin against any role', () => {
    expect(holdsAnyRole(principal({ isPlatformSuperadmin: true }), ['manager'], STAKE_ID)).toBe(
      true,
    );
    expect(holdsAnyRole(principal({ isPlatformSuperadmin: true }), ['bishopric'], STAKE_ID)).toBe(
      true,
    );
    expect(holdsAnyRole(principal({ isPlatformSuperadmin: true }), ['stake'], STAKE_ID)).toBe(true);
  });

  it('returns true for a Kindoo Manager against any role gate', () => {
    // Managers are an implicit superset: a manager in the active stake
    // passes a stake or bishopric gate without literally holding those.
    const manager = principal({ managerStakes: [STAKE_ID] });
    expect(holdsAnyRole(manager, ['manager'], STAKE_ID)).toBe(true);
    expect(holdsAnyRole(manager, ['stake'], STAKE_ID)).toBe(true);
    expect(holdsAnyRole(manager, ['bishopric'], STAKE_ID)).toBe(true);
  });

  it('does NOT let a manager-without-superadmin pass a platformSuperadmin-only gate', () => {
    // The manager superset is for stake/bishopric/manager — the
    // platformSuperadmin gate is strict because the surfaces behind
    // it (Stake List, Create Stake) require the literal claim.
    const manager = principal({ managerStakes: [STAKE_ID], isPlatformSuperadmin: false });
    expect(holdsAnyRole(manager, ['platformSuperadmin'], STAKE_ID)).toBe(false);
  });

  it('still admits a true platform superadmin to a platformSuperadmin gate', () => {
    const sa = principal({ isPlatformSuperadmin: true });
    expect(holdsAnyRole(sa, ['platformSuperadmin'], STAKE_ID)).toBe(true);
  });

  it('does not let a manager in a different stake bypass the active-stake gates', () => {
    // The manager-superset short-circuit must scope to the active stake.
    const otherStakeManager = principal({ managerStakes: ['other-stake'] });
    expect(holdsAnyRole(otherStakeManager, ['stake'], STAKE_ID)).toBe(false);
    expect(holdsAnyRole(otherStakeManager, ['bishopric'], STAKE_ID)).toBe(false);
  });

  it('returns false for an empty bishopricWards array on the stake', () => {
    expect(
      holdsAnyRole(principal({ bishopricWards: { [STAKE_ID]: [] } }), ['bishopric'], STAKE_ID),
    ).toBe(false);
  });

  it('returns false for a role in a different stake', () => {
    expect(holdsAnyRole(principal({ managerStakes: ['other-stake'] }), ['manager'], STAKE_ID)).toBe(
      false,
    );
  });

  it('returns true if any of an array of required roles match', () => {
    expect(
      holdsAnyRole(principal({ stakeMemberStakes: [STAKE_ID] }), ['manager', 'stake'], STAKE_ID),
    ).toBe(true);
  });

  it('returns false when no required role matches', () => {
    expect(
      holdsAnyRole(
        principal({ stakeMemberStakes: [STAKE_ID] }),
        ['manager', 'bishopric'],
        STAKE_ID,
      ),
    ).toBe(false);
  });

  it('returns false for every per-stake role when stakeId is null', () => {
    // Zero-role platform superadmin path.
    const stakeMember = principal({ stakeMemberStakes: [STAKE_ID] });
    expect(holdsAnyRole(stakeMember, ['stake'], null)).toBe(false);
    expect(holdsAnyRole(stakeMember, ['manager'], null)).toBe(false);
    expect(holdsAnyRole(stakeMember, ['bishopric'], null)).toBe(false);
  });

  it('still admits a platform superadmin to any gate when stakeId is null', () => {
    const sa = principal({ isPlatformSuperadmin: true });
    expect(holdsAnyRole(sa, ['platformSuperadmin'], null)).toBe(true);
    expect(holdsAnyRole(sa, ['manager'], null)).toBe(true);
  });
});
