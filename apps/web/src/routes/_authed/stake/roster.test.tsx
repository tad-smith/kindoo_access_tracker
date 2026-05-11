// Route gate tests for /_authed/stake/roster. Stake-gated, but managers
// (and platform superadmins) implicitly pass because they administer
// the entire app; bishopric-only / no-role principals redirect to /.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Principal } from '../../../lib/principal';

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

vi.mock('../../../lib/principal', () => ({
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

vi.mock('../../../features/stake/RosterPage', () => ({
  StakeRosterPage: () => <div data-testid="stake-roster-page" />,
}));

import { Route } from './roster';

const StakeRosterRoute = Route.options.component as () => React.ReactElement | null;

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

describe('/_authed/stake/roster route gate', () => {
  it('renders the page for a stake-member principal', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      stakeMemberStakes: ['csnorth'],
    };
    render(<StakeRosterRoute />);
    expect(screen.getByTestId('stake-roster-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('renders the page for a platform superadmin', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      isPlatformSuperadmin: true,
    };
    render(<StakeRosterRoute />);
    expect(screen.getByTestId('stake-roster-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('redirects a bishopric-only principal to /', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      bishopricWards: { csnorth: ['CO'] },
      stakeMemberStakes: [],
    };
    render(<StakeRosterRoute />);
    expect(screen.queryByTestId('stake-roster-page')).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('renders the page for a Kindoo Manager principal', () => {
    // Managers administer the entire app, so they pass the stake gate
    // without literally holding the stake role.
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      managerStakes: ['csnorth'],
      stakeMemberStakes: [],
    };
    render(<StakeRosterRoute />);
    expect(screen.getByTestId('stake-roster-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('does not redirect during the principal-loading window', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      firebaseAuthSignedIn: true,
      isAuthenticated: false,
      canonical: '',
      managerStakes: [],
      isPlatformSuperadmin: false,
      bishopricWards: {},
      stakeMemberStakes: [],
    };
    render(<StakeRosterRoute />);
    expect(screen.queryByTestId('stake-roster-page')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
  });
});
