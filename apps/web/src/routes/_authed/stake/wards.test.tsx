// Route gate tests for /_authed/stake/wards. Stake-only; bishopric /
// manager-only / no-role principals redirect to /.

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

vi.mock('../../../features/stake/WardRostersPage', () => ({
  WardRostersPage: () => <div data-testid="stake-wards-page" />,
}));

import { Route } from './wards';

vi.spyOn(Route, 'useSearch').mockReturnValue({} as never);

const WardRostersRoute = Route.options.component as () => React.ReactElement | null;

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

describe('/_authed/stake/wards route gate', () => {
  it('renders the page for a stake-member principal', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      stakeMemberStakes: ['csnorth'],
    };
    render(<WardRostersRoute />);
    expect(screen.getByTestId('stake-wards-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('redirects a bishopric-only principal to /', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      bishopricWards: { csnorth: ['CO'] },
      stakeMemberStakes: [],
    };
    render(<WardRostersRoute />);
    expect(screen.queryByTestId('stake-wards-page')).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('redirects a manager-only principal to /', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      managerStakes: ['csnorth'],
      stakeMemberStakes: [],
    };
    render(<WardRostersRoute />);
    expect(screen.queryByTestId('stake-wards-page')).toBeNull();
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
    render(<WardRostersRoute />);
    expect(screen.queryByTestId('stake-wards-page')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
  });
});
