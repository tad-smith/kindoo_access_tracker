// Route gate tests for /_authed/manager/seats. Manager-only.

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

vi.mock('../../../features/manager/allSeats/AllSeatsPage', () => ({
  AllSeatsPage: () => <div data-testid="manager-seats-page" />,
}));

import { Route } from './seats';

vi.spyOn(Route, 'useSearch').mockReturnValue({} as never);

const AllSeatsRoute = Route.options.component as () => React.ReactElement | null;

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

describe('/_authed/manager/seats route gate', () => {
  it('renders the page for a manager principal', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      managerStakes: ['csnorth'],
    };
    render(<AllSeatsRoute />);
    expect(screen.getByTestId('manager-seats-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('redirects a non-manager (bishopric only) to /', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      managerStakes: [],
      isPlatformSuperadmin: false,
      bishopricWards: { csnorth: ['CO'] },
    };
    render(<AllSeatsRoute />);
    expect(screen.queryByTestId('manager-seats-page')).toBeNull();
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
    render(<AllSeatsRoute />);
    expect(screen.queryByTestId('manager-seats-page')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
  });
});
