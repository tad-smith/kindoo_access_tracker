// Route gate tests for /_authed/notifications. The route is
// manager-only for-now; non-managers redirect to `/`. The page itself
// (rendered when gated through) is exercised by NotificationsPage's
// own component test.
//
// Loading-window coverage: `usePrincipal()` is component-scoped state.
// On a fresh mount, claims start `null` and the derived Principal
// looks identical to a no-role user (`isAuthenticated: false`). The
// gate must NOT redirect during that window — only after claims have
// arrived (i.e., `isAuthenticated: true`).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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
      isAuthenticated: true,
      managerStakes: ['csnorth'],
    };
    render(<NotificationsRoute />);
    expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('renders the page for a platform superadmin', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
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
      isAuthenticated: true,
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
      isAuthenticated: true,
      managerStakes: [],
      isPlatformSuperadmin: false,
      bishopricWards: {},
      stakeMemberStakes: ['csnorth'],
    };
    render(<NotificationsRoute />);
    expect(screen.queryByTestId('notifications-page')).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('does not redirect during the principal-loading window (signed in but claims not arrived)', () => {
    // Fresh mount of `usePrincipal()` inside an `_authed` child route:
    // the user is signed in (Firebase Auth), but custom claims are
    // still being fetched. The derived Principal looks like a no-role
    // user. Past the `_authed` gate this combination unambiguously
    // means "claims still loading."
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
    render(<NotificationsRoute />);
    // Loading affordance, not the page, not a redirect.
    expect(screen.queryByTestId('notifications-page')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
  });

  it('renders the page once claims arrive after the loading window', () => {
    // First render — claims pending.
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
    const { rerender } = render(<NotificationsRoute />);
    expect(navigateMock).not.toHaveBeenCalled();

    // Second render — claims arrive, user is a manager.
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      isAuthenticated: true,
      canonical: 'a@x.com',
      managerStakes: ['csnorth'],
    };
    act(() => {
      rerender(<NotificationsRoute />);
    });
    expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
