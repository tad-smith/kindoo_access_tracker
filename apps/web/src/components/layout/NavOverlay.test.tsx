// Component tests for the NavOverlay footer surface. The overlay
// hosts the version stamp and (per T-20) the link to the bundled
// THIRD_PARTY_LICENSES.txt artifact that Firebase Hosting serves at
// /THIRD_PARTY_LICENSES.txt. The link is a plain anchor (not a
// TanStack Router Link) because the target is a static file.
//
// Nav (rendered inside NavOverlay) reads from `useRouterState`, so
// each test mounts the overlay inside a minimal in-memory TanStack
// router; the test pattern mirrors Shell.test.tsx.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { NavOverlay } from './NavOverlay';
import type { Principal } from '../../lib/principal';

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
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

async function renderOverlay(variant: 'panel' | 'drawer' = 'drawer') {
  const overlay = (
    <NavOverlay
      open
      variant={variant}
      principal={makePrincipal()}
      email="alice@example.com"
      version="0.1.0-test"
      signingOut={false}
      onDismiss={() => {}}
      onSignOut={() => {}}
      onNavigate={() => {}}
    />
  );
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const catchAll = createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    component: () => overlay,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([catchAll]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

describe('NavOverlay — footer licenses link', () => {
  it('renders a Licenses link in the foot pointing at /THIRD_PARTY_LICENSES.txt', async () => {
    await renderOverlay('drawer');
    const link = screen.getByRole('link', { name: 'Licenses' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/THIRD_PARTY_LICENSES.txt');
  });

  it('opens the licenses link in a new tab with noopener', async () => {
    await renderOverlay('drawer');
    const link = screen.getByRole('link', { name: 'Licenses' });
    expect(link).toHaveAttribute('target', '_blank');
    // rel includes noopener so the new tab cannot reach back via window.opener.
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('keeps the version stamp adjacent to the licenses link in the foot', async () => {
    await renderOverlay('drawer');
    const version = screen.getByLabelText('Build version');
    expect(version).toHaveTextContent('v0.1.0-test');
    // The link is rendered inside the same .kd-nav-version span so
    // they share the muted-monospace footer styling.
    expect(version.querySelector('a')).toHaveTextContent('Licenses');
  });

  it('renders the Licenses link in the tablet panel variant too', async () => {
    await renderOverlay('panel');
    expect(screen.getByRole('link', { name: 'Licenses' })).toHaveAttribute(
      'href',
      '/THIRD_PARTY_LICENSES.txt',
    );
  });
});
