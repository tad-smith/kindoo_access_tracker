// Component tests for the Shell layout. Verifies the topbar's three
// promised slots — email, version, sign-out button — render for an
// authenticated principal, plus the shell stays stable when a child
// route swaps. Phase-2's principal hook is mocked at the module
// boundary so the test doesn't need a Firebase/reactfire context.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { Principal } from '../../lib/principal';

// Hoist-aware mocks so the imports below see the mocked module surface.
const mockedPrincipal: { current: Principal } = {
  current: {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'alice@example.com',
    canonical: 'alice@example.com',
    isPlatformSuperadmin: false,
    managerStakes: ['csnorth'],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => true,
    wardsInStake: () => [],
  },
};

vi.mock('../../lib/principal', () => ({
  usePrincipal: () => mockedPrincipal.current,
}));

const signOutMock = vi.fn();
vi.mock('../../features/auth/signOut', () => ({
  signOut: () => signOutMock(),
}));

// Lock the version stamp so the test assertion doesn't drift.
vi.mock('../../version', () => ({
  KINDOO_WEB_VERSION: '4.0.0-test',
}));

import { Shell } from './Shell';

function setPrincipal(p: Principal) {
  mockedPrincipal.current = p;
}

function defaultPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'alice@example.com',
    canonical: 'alice@example.com',
    isPlatformSuperadmin: false,
    managerStakes: ['csnorth'],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => true,
    wardsInStake: () => [],
    ...overrides,
  };
}

async function renderShell(content: React.ReactNode, pathname = '/') {
  const rootRoute = createRootRoute({ component: () => <Shell>{content}</Shell> });
  const catchAll = createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    component: () => <Outlet />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([catchAll]),
    history: createMemoryHistory({ initialEntries: [pathname] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  signOutMock.mockReset();
  setPrincipal(defaultPrincipal());
});

describe('Shell', () => {
  it('renders the principal email + sign-out button + version stamp', async () => {
    await renderShell(<p>Hello</p>);
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign out/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Build version')).toHaveTextContent('v4.0.0-test');
  });

  it('renders the child content', async () => {
    await renderShell(<p data-testid="content">child</p>);
    expect(screen.getByTestId('content')).toHaveTextContent('child');
  });

  it('clicking sign-out invokes the signOut helper', async () => {
    const user = userEvent.setup();
    signOutMock.mockResolvedValueOnce(undefined);
    await renderShell(<p>Hello</p>);
    await user.click(screen.getByRole('button', { name: /Sign out/ }));
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it('renders nav for a principal with roles', async () => {
    await renderShell(<p>Hello</p>);
    expect(screen.getByRole('navigation', { name: /Primary/ })).toBeInTheDocument();
  });

  it('does not render the email/sign-out pair for an unauthenticated principal', async () => {
    setPrincipal(
      defaultPrincipal({
        isAuthenticated: false,
        firebaseAuthSignedIn: false,
        email: '',
        canonical: '',
        managerStakes: [],
      }),
    );
    await renderShell(<p>Hello</p>);
    expect(screen.queryByText('alice@example.com')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign out/ })).toBeNull();
    // Nav suppressed for unauthenticated users — they only see the topbar.
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
