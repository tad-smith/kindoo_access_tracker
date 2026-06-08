// Component tests for the sectioned Nav. The pure derivation
// `navSectionsForPrincipal` is exported from `navModel.ts` so we can
// hit it directly without mounting a TanStack Router; for the
// rendered-DOM cases we wrap a minimal in-memory router.

import { describe, expect, it, vi } from 'vitest';
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
import { Nav } from './Nav';
import { navSectionsForPrincipal, wardRosterPathFor } from './navModel';
import type { Principal } from '../../lib/principal';

const STAKE_ID = 'csnorth';

vi.mock('../../lib/useActiveStake', () => ({
  useActiveStake: () => STAKE_ID,
}));

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
    expect(navSectionsForPrincipal(makePrincipal(), STAKE_ID)).toEqual([]);
  });

  it('manager-only: shows all four sections, all manager items', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({ managerStakes: ['csnorth'] }),
      STAKE_ID,
    );
    expect(sections.map((s) => s.key)).toEqual(['quick-links', 'rosters', 'settings', 'account']);
    const quick = sections.find((s) => s.key === 'quick-links')?.items.map((i) => i.label);
    expect(quick).toEqual(['Dashboard', 'Request Queue', 'My Requests', 'Get Help']);
    const rosters = sections.find((s) => s.key === 'rosters')?.items.map((i) => i.label);
    expect(rosters).toEqual(['Ward Roster', 'Stake Roster', 'All Seats']);
    const settings = sections.find((s) => s.key === 'settings')?.items.map((i) => i.label);
    expect(settings).toEqual(['Configuration', 'App Access', 'Audit Log']);
    const account = sections.find((s) => s.key === 'account')?.items.map((i) => i.label);
    expect(account).toEqual(['Notifications', 'Logout']);
  });

  it('bishopric-only: shows Quick Links + Rosters + Account; hides Settings entirely', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({ bishopricWards: { csnorth: ['CO'] } }),
      STAKE_ID,
    );
    expect(sections.map((s) => s.key)).toEqual(['quick-links', 'rosters', 'account']);
    const quick = sections.find((s) => s.key === 'quick-links')?.items.map((i) => i.label);
    expect(quick).toEqual(['My Requests', 'Get Help']);
    const rosters = sections.find((s) => s.key === 'rosters')?.items.map((i) => i.label);
    expect(rosters).toEqual(['Ward Roster']);
    const account = sections.find((s) => s.key === 'account')?.items.map((i) => i.label);
    expect(account).toEqual(['Logout']);
  });

  it('stake-only: shows Quick Links + Rosters + Account; hides Settings entirely', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({ stakeMemberStakes: ['csnorth'] }),
      STAKE_ID,
    );
    expect(sections.map((s) => s.key)).toEqual(['quick-links', 'rosters', 'account']);
    const quick = sections.find((s) => s.key === 'quick-links')?.items.map((i) => i.label);
    expect(quick).toEqual(['My Requests', 'Get Help']);
    const rosters = sections.find((s) => s.key === 'rosters')?.items.map((i) => i.label);
    expect(rosters).toEqual(['Ward Roster', 'Stake Roster']);
  });

  it('manager + bishopric: all four sections; Quick Links keeps Dashboard/Queue/My Requests', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({
        managerStakes: ['csnorth'],
        bishopricWards: { csnorth: ['CO'] },
      }),
      STAKE_ID,
    );
    expect(sections.map((s) => s.key)).toEqual(['quick-links', 'rosters', 'settings', 'account']);
    const quick = sections.find((s) => s.key === 'quick-links')?.items.map((i) => i.label);
    expect(quick).toEqual(['Dashboard', 'Request Queue', 'My Requests', 'Get Help']);
  });

  it('Account section visible to every authorized user (manager / stake / bishopric)', () => {
    const cases: Array<{ overrides: Partial<Principal>; expected: string[] }> = [
      { overrides: { managerStakes: ['csnorth'] }, expected: ['Notifications', 'Logout'] },
      { overrides: { stakeMemberStakes: ['csnorth'] }, expected: ['Logout'] },
      { overrides: { bishopricWards: { csnorth: ['CO'] } }, expected: ['Logout'] },
    ];
    for (const { overrides, expected } of cases) {
      const sections = navSectionsForPrincipal(makePrincipal(overrides), STAKE_ID);
      const account = sections.find((s) => s.key === 'account');
      expect(account?.items.map((i) => i.label)).toEqual(expected);
    }
  });

  it('Logout is an action item, not a link', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({ managerStakes: ['csnorth'] }),
      STAKE_ID,
    );
    const logout = sections.find((s) => s.key === 'account')?.items.find((i) => i.key === 'logout');
    expect(logout?.kind).toBe('action');
    if (logout?.kind === 'action') {
      expect(logout.action).toBe('sign-out');
    }
  });

  it('platform superadmin without explicit manager claim still sees Settings', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({ isPlatformSuperadmin: true }),
      STAKE_ID,
    );
    expect(sections.map((s) => s.key)).toContain('settings');
  });

  it('Super Admin section appears for `isPlatformSuperadmin === true` with the Stake List entry', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({ isPlatformSuperadmin: true }),
      STAKE_ID,
    );
    const superadmin = sections.find((s) => s.key === 'superadmin');
    expect(superadmin).toBeDefined();
    expect(superadmin?.label).toBe('Super Admin');
    expect(superadmin?.items.map((i) => i.label)).toEqual(['Stake List']);
    // Per `navigation-redesign.md` §8, Super Admin sits between Settings and Account.
    const keys = sections.map((s) => s.key);
    const superIdx = keys.indexOf('superadmin');
    expect(superIdx).toBeGreaterThan(keys.indexOf('settings'));
    expect(superIdx).toBeLessThan(keys.indexOf('account'));
  });

  it('Superadmin section is hidden for a Kindoo Manager who is not a superadmin', () => {
    // The manager-superset is for stake/bishopric/manager gates — the
    // Superadmin section is gated strictly on the literal claim.
    const sections = navSectionsForPrincipal(
      makePrincipal({ managerStakes: ['csnorth'] }),
      STAKE_ID,
    );
    expect(sections.map((s) => s.key)).not.toContain('superadmin');
  });

  it('Superadmin section is hidden for users with no role at all', () => {
    expect(navSectionsForPrincipal(makePrincipal(), STAKE_ID).map((s) => s.key)).not.toContain(
      'superadmin',
    );
  });

  it('Superadmin section is hidden for a bishopric- or stake-only user', () => {
    expect(
      navSectionsForPrincipal(makePrincipal({ bishopricWards: { csnorth: ['CO'] } }), STAKE_ID).map(
        (s) => s.key,
      ),
    ).not.toContain('superadmin');
    expect(
      navSectionsForPrincipal(makePrincipal({ stakeMemberStakes: ['csnorth'] }), STAKE_ID).map(
        (s) => s.key,
      ),
    ).not.toContain('superadmin');
  });

  it('items have unique keys', () => {
    const sections = navSectionsForPrincipal(
      makePrincipal({
        managerStakes: ['csnorth'],
        stakeMemberStakes: ['csnorth'],
        bishopricWards: { csnorth: ['CO'] },
      }),
      STAKE_ID,
    );
    const keys = sections.flatMap((s) => s.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('Get Help — role-aware static guide Quick Link', () => {
  function getHelpItem(overrides: Partial<Principal>) {
    const sections = navSectionsForPrincipal(makePrincipal(overrides), STAKE_ID);
    return sections.find((s) => s.key === 'quick-links')?.items.find((i) => i.key === 'get-help');
  }

  it('appears last in Quick Links for every role', () => {
    const cases: Partial<Principal>[] = [
      { managerStakes: ['csnorth'] },
      { stakeMemberStakes: ['csnorth'] },
      { bishopricWards: { csnorth: ['CO'] } },
    ];
    for (const overrides of cases) {
      const quick = navSectionsForPrincipal(makePrincipal(overrides), STAKE_ID).find(
        (s) => s.key === 'quick-links',
      );
      expect(quick?.items.at(-1)?.label).toBe('Get Help');
    }
  });

  it('is an external item (plain link, not an SPA route)', () => {
    const item = getHelpItem({ managerStakes: ['csnorth'] });
    expect(item?.kind).toBe('external');
  });

  it('points a manager at the Kindoo Manager guide', () => {
    const item = getHelpItem({ managerStakes: ['csnorth'] });
    expect(item?.kind === 'external' && item.href).toBe('/help/kindoo-manager-guide.html');
  });

  it('points a bishopric user at the requester guide', () => {
    const item = getHelpItem({ bishopricWards: { csnorth: ['CO'] } });
    expect(item?.kind === 'external' && item.href).toBe('/help/requesting-access.html');
  });

  it('points a stake (non-manager) user at the requester guide', () => {
    const item = getHelpItem({ stakeMemberStakes: ['csnorth'] });
    expect(item?.kind === 'external' && item.href).toBe('/help/requesting-access.html');
  });

  it('points a manager who is also bishopric at the manager guide (manager wins)', () => {
    const item = getHelpItem({
      managerStakes: ['csnorth'],
      bishopricWards: { csnorth: ['CO'] },
    });
    expect(item?.kind === 'external' && item.href).toBe('/help/kindoo-manager-guide.html');
  });

  it('is absent for a zero-role principal (no Quick Links section at all)', () => {
    const sections = navSectionsForPrincipal(makePrincipal(), STAKE_ID);
    expect(sections.find((s) => s.key === 'quick-links')).toBeUndefined();
  });
});

describe('wardRosterPathFor — Ward Roster routing logic (§9)', () => {
  it('manager → /stake/wards (any-ward picker)', () => {
    expect(wardRosterPathFor(makePrincipal({ managerStakes: ['csnorth'] }), STAKE_ID)).toBe(
      '/stake/wards',
    );
  });

  it('stake → /stake/wards (any-ward picker)', () => {
    expect(wardRosterPathFor(makePrincipal({ stakeMemberStakes: ['csnorth'] }), STAKE_ID)).toBe(
      '/stake/wards',
    );
  });

  it('bishopric only → /bishopric/roster', () => {
    expect(
      wardRosterPathFor(makePrincipal({ bishopricWards: { csnorth: ['CO'] } }), STAKE_ID),
    ).toBe('/bishopric/roster');
  });

  it('manager + bishopric → /stake/wards (manager wins; bishopric ward is one option)', () => {
    expect(
      wardRosterPathFor(
        makePrincipal({
          managerStakes: ['csnorth'],
          bishopricWards: { csnorth: ['CO'] },
        }),
        STAKE_ID,
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
        STAKE_ID,
      ),
    ).toBe('/stake/wards');
  });

  it('platform superadmin without explicit manager → /stake/wards', () => {
    expect(wardRosterPathFor(makePrincipal({ isPlatformSuperadmin: true }), STAKE_ID)).toBe(
      '/stake/wards',
    );
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
    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dashboard/ })).toBeInTheDocument();
    // Account section's Logout renders as a button (action item).
    expect(screen.getByRole('button', { name: /Logout/ })).toBeInTheDocument();
  });

  it('Logout button invokes onSignOut', async () => {
    const principal = makePrincipal({ managerStakes: ['csnorth'] });
    const onSignOut = vi.fn();
    const rootRoute = createRootRoute({
      component: () => <Nav principal={principal} onSignOut={onSignOut} />,
    });
    const catchAll = createRoute({
      getParentRoute: () => rootRoute,
      path: '$',
      component: () => <Outlet />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([catchAll]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await router.load();
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Logout/ }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
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

  it('renders Get Help as a plain link to the role-appropriate guide, never active', async () => {
    // A manager sitting on the manager guide's URL must still not get an
    // active-state highlight — external items carry no active marker.
    await renderNavAtPath(
      makePrincipal({ managerStakes: ['csnorth'] }),
      '/help/kindoo-manager-guide.html',
    );
    const link = screen.getByRole('link', { name: /Get Help/ });
    expect(link).toHaveAttribute('href', '/help/kindoo-manager-guide.html');
    expect(link).not.toHaveAttribute('aria-current');
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
