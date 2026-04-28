// Component tests for the role-aware Nav. The pure derivation
// `navLinksForPrincipal` is exported so we can hit it directly without
// mounting a TanStack Router; for the rendered-DOM cases we wrap a
// minimal in-memory router.

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
import { navLinksForPrincipal, Nav } from './Nav';
import type { Principal } from '../../lib/principal';

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'alice@example.com',
    canonical: 'alice@example.com',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => true,
    wardsInStake: () => [],
    ...overrides,
  };
}

describe('navLinksForPrincipal (pure derivation)', () => {
  it('returns no links for a principal with no roles', () => {
    expect(navLinksForPrincipal(makePrincipal())).toEqual([]);
  });

  it('returns the manager link set for a manager principal', () => {
    const links = navLinksForPrincipal(makePrincipal({ managerStakes: ['csnorth'] }));
    expect(links.map((l) => l.label)).toEqual([
      'Dashboard',
      'Requests Queue',
      'All Seats',
      'Configuration',
      'Access',
      'Import',
      'Audit Log',
    ]);
  });

  it('returns the stake link set for a stake-member principal', () => {
    const links = navLinksForPrincipal(makePrincipal({ stakeMemberStakes: ['csnorth'] }));
    expect(links.map((l) => l.label)).toEqual([
      'Roster',
      'New Kindoo Request',
      'My Requests',
      'Ward Rosters',
    ]);
  });

  it('returns the bishopric link set for a bishopric principal', () => {
    const links = navLinksForPrincipal(makePrincipal({ bishopricWards: { csnorth: ['CO'] } }));
    expect(links.map((l) => l.label)).toEqual(['Roster', 'New Kindoo Request', 'My Requests']);
  });

  it('orders priority manager > stake > bishopric in a multi-role union', () => {
    const links = navLinksForPrincipal(
      makePrincipal({
        managerStakes: ['csnorth'],
        stakeMemberStakes: ['csnorth'],
        bishopricWards: { csnorth: ['CO'] },
      }),
    );
    // Manager links lead; stake links follow (de-duplicated where keys overlap).
    expect(links[0]?.label).toBe('Dashboard');
    // Stake's "Roster" follows the manager block.
    expect(links.map((l) => l.label)).toContain('Roster');
    // No duplicates after de-dup.
    expect(new Set(links.map((l) => l.key)).size).toBe(links.length);
  });
});

// Minimal router fixture so `<Nav />` can call `useRouterState`.
async function renderNavAtPath(principal: Principal, pathname: string) {
  const rootRoute = createRootRoute({ component: () => <Nav principal={principal} /> });
  // We don't need real child routes — they're never matched; the nav
  // just reads `useRouterState().location.pathname`. Adding a catch-all
  // child route keeps the router happy for arbitrary `pathname` values.
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
  render(<RouterProvider router={router} />);
}

describe('<Nav />', () => {
  it('renders nothing for a principal with no roles', async () => {
    await renderNavAtPath(makePrincipal(), '/');
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('renders manager links and marks the active one', async () => {
    await renderNavAtPath(makePrincipal({ managerStakes: ['csnorth'] }), '/manager/queue');
    const link = screen.getByRole('link', { name: /Requests Queue/ });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link.className).toContain('active');
    // Other links exist but are not marked active.
    const dashboard = screen.getByRole('link', { name: /^Dashboard$/ });
    expect(dashboard).not.toHaveAttribute('aria-current');
  });
});
