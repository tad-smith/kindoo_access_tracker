// Route gate tests for /_authed/bishopric/roster. Bishopric-only;
// stake / manager-only / no-role principals redirect to /.

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

vi.mock('../../../features/bishopric/RosterPage', () => ({
  BishopricRosterPage: () => <div data-testid="bishopric-roster-page" />,
}));

import { Route } from './roster';

vi.spyOn(Route, 'useSearch').mockReturnValue({} as never);

const BishopricRosterRoute = Route.options.component as () => React.ReactElement | null;

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

describe('/_authed/bishopric/roster route gate', () => {
  it('renders the page for a bishopric principal', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      bishopricWards: { csnorth: ['CO'] },
    };
    render(<BishopricRosterRoute />);
    expect(screen.getByTestId('bishopric-roster-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('renders the page for a platform superadmin', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      isPlatformSuperadmin: true,
    };
    render(<BishopricRosterRoute />);
    expect(screen.getByTestId('bishopric-roster-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('redirects a stake-only principal to /', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      stakeMemberStakes: ['csnorth'],
      bishopricWards: {},
    };
    render(<BishopricRosterRoute />);
    expect(screen.queryByTestId('bishopric-roster-page')).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('redirects a manager-only principal to /', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      managerStakes: ['csnorth'],
      bishopricWards: {},
    };
    render(<BishopricRosterRoute />);
    expect(screen.queryByTestId('bishopric-roster-page')).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
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
    render(<BishopricRosterRoute />);
    expect(screen.queryByTestId('bishopric-roster-page')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
  });
});
