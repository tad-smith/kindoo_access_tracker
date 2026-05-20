// Component tests for the desktop persistent rail. Existing
// integration coverage lives in Shell.test.tsx (which exercises the
// rail through the full shell tree); this focused file exists so the
// rail-specific affordances — version stamp, third-party Licenses
// link in the foot — have direct assertions that survive a Shell-
// level refactor.

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { LeftRail } from './LeftRail';
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

async function renderLeftRail() {
  const rail = (
    <LeftRail
      principal={makePrincipal()}
      signingOut={false}
      version="0.1.0-test"
      onSignOut={() => {}}
    />
  );
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const catchAll = createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    component: () => rail,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([catchAll]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

describe('LeftRail — footer', () => {
  it('renders the version stamp', async () => {
    await renderLeftRail();
    expect(screen.getByLabelText('Build version')).toHaveTextContent('v0.1.0-test');
  });

  it('renders the third-party Licenses link pointing at /THIRD_PARTY_LICENSES.txt', async () => {
    await renderLeftRail();
    const foot = document.querySelector('.kd-left-rail-foot') as HTMLElement;
    const link = within(foot).getByRole('link', { name: 'Licenses' });
    expect(link).toHaveAttribute('href', '/THIRD_PARTY_LICENSES.txt');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('renders the Licenses link adjacent to the version stamp (same span)', async () => {
    await renderLeftRail();
    const version = screen.getByLabelText('Build version');
    expect(version.querySelector('a')).toHaveTextContent('Licenses');
  });
});
