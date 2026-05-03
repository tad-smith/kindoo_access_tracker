// Route gate tests for /_authed/notifications. The route is
// manager-only for-now; non-managers redirect to `/`. The page itself
// (rendered when gated through) is exercised by NotificationsPage's
// own component test.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Principal } from '../../lib/principal';

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

vi.mock('../../lib/principal', () => ({
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

vi.mock('../../features/notifications/pages/NotificationsPage', () => ({
  NotificationsPage: () => <div data-testid="notifications-page" />,
}));

import { Route } from './notifications';

const NotificationsRoute = Route.options.component as () => React.ReactElement | null;

beforeEach(() => {
  navigateMock.mockClear();
});

describe('/_authed/notifications route gate', () => {
  it('renders the page for a manager principal', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      managerStakes: ['csnorth'],
    };
    render(<NotificationsRoute />);
    expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('renders the page for a platform superadmin', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      managerStakes: [],
      isPlatformSuperadmin: true,
    };
    render(<NotificationsRoute />);
    expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('redirects a non-manager (bishopric only) to /', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      managerStakes: [],
      isPlatformSuperadmin: false,
      bishopricWards: { csnorth: ['CO'] },
    };
    render(<NotificationsRoute />);
    expect(screen.queryByTestId('notifications-page')).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('redirects a non-manager (stake only) to /', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      managerStakes: [],
      isPlatformSuperadmin: false,
      bishopricWards: {},
      stakeMemberStakes: ['csnorth'],
    };
    render(<NotificationsRoute />);
    expect(screen.queryByTestId('notifications-page')).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
  });
});
