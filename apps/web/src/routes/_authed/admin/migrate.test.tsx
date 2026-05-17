// Route gate tests for /_authed/admin/migrate. Manager-only.

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

vi.mock('../../../features/manager/migrate/MigratePage', () => ({
  MigratePage: () => <div data-testid="admin-migrate-page" />,
}));

import { Route } from './migrate';

const MigrateRoute = Route.options.component as () => React.ReactElement | null;

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

describe('/_authed/admin/migrate route gate', () => {
  it('renders the page for a manager principal', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      managerStakes: ['csnorth'],
    };
    render(<MigrateRoute />);
    expect(screen.getByTestId('admin-migrate-page')).toBeInTheDocument();
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
    render(<MigrateRoute />);
    expect(screen.queryByTestId('admin-migrate-page')).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
  });
});
