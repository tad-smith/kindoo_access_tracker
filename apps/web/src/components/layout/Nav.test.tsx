// Component tests for the sectioned Nav. The pure derivation
// `navSectionsForPrincipal` is exported from `navModel.ts` so we can
// hit it directly without mounting a TanStack Router; for the
// rendered-DOM cases we wrap a minimal in-memory router.

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
import { Nav } from './Nav';
import { navSectionsForPrincipal, wardRosterPathFor } from './navModel';
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

describe('navSectionsForPrincipal — section visibility by role', () => {
  it('returns no sections for a principal with no roles', () => {
    expect(navSectionsForPrincipal(makePrincipal())).toEqual([]);
  });

  it('manager-only: shows all three sections, all manager items', () => {
    const sections = navSectionsForPrincipal(makePrincipal({ managerStakes: ['csnorth'] }));
    expect(sections.map((s) => s.key)).toEqual(['quick-links', 'rosters', 'settings']);
    const quick = sections.find((s) => s.key === 'quick-links')?.items.map((i) => i.label);
    expect(quick).toEqual(['Dashboard', 'Request Queue', 'My Requests']);
    const rosters = sections.find((s) => s.key === 'rosters')?.items.map((i) => i.label);
    expect(rosters).toEqual(['Ward Roster', 'Stake Roster', 'All Seats']);
    const settings = sections.find((s) => s.key === 'settings')?.items.map((i) => i.label);
    expect(settings).toEqual(['App Access', 'Import', 'Configuration', 'Audit Log']);
  });

  it('bishopric-only: shows Quick Links + Rosters; hides Settings entirely', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({ bishopricWards: { csnorth: ['CO'] } }),
    );
    expect(sections.map((s) => s.key)).toEqual(['quick-links', 'rosters']);
    const quick = sections.find((s) => s.key === 'quick-links')?.items.map((i) => i.label);
    expect(quick).toEqual(['New Request', 'My Requests']);
    const rosters = sections.find((s) => s.key === 'rosters')?.items.map((i) => i.label);
    expect(rosters).toEqual(['Ward Roster']);
  });

  it('stake-only: shows Quick Links + Rosters; hides Settings entirely', () => {
    const sections = navSectionsForPrincipal(makePrincipal({ stakeMemberStakes: ['csnorth'] }));
    expect(sections.map((s) => s.key)).toEqual(['quick-links', 'rosters']);
    const quick = sections.find((s) => s.key === 'quick-links')?.items.map((i) => i.label);
    expect(quick).toEqual(['New Request', 'My Requests']);
    const rosters = sections.find((s) => s.key === 'rosters')?.items.map((i) => i.label);
    expect(rosters).toEqual(['Ward Roster', 'Stake Roster']);
  });

  it('manager + bishopric: all three sections; bishopric brings nothing new in Quick Links', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({
        managerStakes: ['csnorth'],
        bishopricWards: { csnorth: ['CO'] },
      }),
    );
    expect(sections.map((s) => s.key)).toEqual(['quick-links', 'rosters', 'settings']);
    const quick = sections.find((s) => s.key === 'quick-links')?.items.map((i) => i.label);
    // Manager keeps the leading Dashboard/Queue; New Request appears
    // because of the bishopric overlay.
    expect(quick).toEqual(['Dashboard', 'Request Queue', 'New Request', 'My Requests']);
  });

  it('platform superadmin without explicit manager claim still sees Settings', () => {
    const sections = navSectionsForPrincipal(makePrincipal({ isPlatformSuperadmin: true }));
    expect(sections.map((s) => s.key)).toContain('settings');
  });

  it('items have unique keys', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({
        managerStakes: ['csnorth'],
        stakeMemberStakes: ['csnorth'],
        bishopricWards: { csnorth: ['CO'] },
      }),
    );
    const keys = sections.flatMap((s) => s.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('wardRosterPathFor — Ward Roster routing logic (§9)', () => {
  it('manager → /stake/wards (any-ward picker)', () => {
    expect(wardRosterPathFor(makePrincipal({ managerStakes: ['csnorth'] }))).toBe('/stake/wards');
  });

  it('stake → /stake/wards (any-ward picker)', () => {
    expect(wardRosterPathFor(makePrincipal({ stakeMemberStakes: ['csnorth'] }))).toBe(
      '/stake/wards',
    );
  });

  it('bishopric only → /bishopric/roster', () => {
    expect(wardRosterPathFor(makePrincipal({ bishopricWards: { csnorth: ['CO'] } }))).toBe(
      '/bishopric/roster',
    );
  });

  it('manager + bishopric → /stake/wards (manager wins; bishopric ward is one option)', () => {
    expect(
      wardRosterPathFor(
        makePrincipal({
          managerStakes: ['csnorth'],
          bishopricWards: { csnorth: ['CO'] },
        }),
      ),
    ).toBe('/stake/wards');
  });

  it('stake + bishopric → /stake/wards (stake wins; bishopric ward is one option)', () => {
    expect(
      wardRosterPathFor(
        makePrincipal({
          stakeMemberStakes: ['csnorth'],
          bishopricWards: { csnorth: ['CO'] },
        }),
      ),
    ).toBe('/stake/wards');
  });

  it('platform superadmin without explicit manager → /stake/wards', () => {
    expect(wardRosterPathFor(makePrincipal({ isPlatformSuperadmin: true }))).toBe('/stake/wards');
  });
});

// Minimal router fixture so `<Nav />` can call `useRouterState`.
async function renderNavAtPath(principal: Principal, pathname: string) {
  const rootRoute = createRootRoute({ component: () => <Nav principal={principal} /> });
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

  it('renders section headers + items', async () => {
    await renderNavAtPath(makePrincipal({ managerStakes: ['csnorth'] }), '/manager/dashboard');
    expect(screen.getByRole('heading', { name: 'Quick Links' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rosters' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dashboard/ })).toBeInTheDocument();
  });

  it('marks only the current page as active (single-active invariant)', async () => {
    await renderNavAtPath(makePrincipal({ managerStakes: ['csnorth'] }), '/manager/seats');
    const all = screen.getAllByRole('link');
    const current = all.filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName(/All Seats/);
  });

  it('hides the Settings section header when no settings items are visible', async () => {
    await renderNavAtPath(makePrincipal({ bishopricWards: { csnorth: ['CO'] } }), '/');
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  });

  it('Ward Roster link routes to /bishopric/roster for a bishopric-only user', async () => {
    await renderNavAtPath(makePrincipal({ bishopricWards: { csnorth: ['CO'] } }), '/');
    const link = screen.getByRole('link', { name: /Ward Roster/ });
    expect(link).toHaveAttribute('href', '/bishopric/roster');
  });

  it('Ward Roster link routes to /stake/wards for a manager', async () => {
    await renderNavAtPath(makePrincipal({ managerStakes: ['csnorth'] }), '/');
    const link = screen.getByRole('link', { name: /Ward Roster/ });
    expect(link).toHaveAttribute('href', '/stake/wards');
  });

  it('reflects the current page identity, not the source, on a deep-linked sub-page', async () => {
    // Deep-link to All Seats with a query string. Active state must
    // still be All Seats — pathname only.
    await renderNavAtPath(makePrincipal({ managerStakes: ['csnorth'] }), '/manager/seats?ward=CO');
    const active = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('aria-current') === 'page');
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAccessibleName(/All Seats/);
  });
});
