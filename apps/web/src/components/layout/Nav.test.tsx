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

  it('returns the manager link set with Queue + admin pages', () => {
    const links = navLinksForPrincipal(makePrincipal({ managerStakes: ['csnorth'] }));
    expect(links.map((l) => l.label)).toEqual([
      'Dashboard',
      'Queue',
      'All Seats',
      'Audit Log',
      'Access',
      'Configuration',
      'Import',
      'My Requests',
    ]);
  });

  it('returns the stake link set with New Request leftmost', () => {
    const links = navLinksForPrincipal(makePrincipal({ stakeMemberStakes: ['csnorth'] }));
    expect(links.map((l) => l.label)).toEqual([
      'New Request',
      'Roster',
      'Ward Rosters',
      'My Requests',
    ]);
  });

  it('returns the bishopric link set with New Request leftmost', () => {
    const links = navLinksForPrincipal(makePrincipal({ bishopricWards: { csnorth: ['CO'] } }));
    expect(links.map((l) => l.label)).toEqual(['New Request', 'Roster', 'My Requests']);
  });

  it('orders priority manager > stake > bishopric in a multi-role union', () => {
    const links = navLinksForPrincipal(
      makePrincipal({
        managerStakes: ['csnorth'],
        stakeMemberStakes: ['csnorth'],
        bishopricWards: { csnorth: ['CO'] },
      }),
    );
    // Manager block leads (Dashboard at index 0).
    expect(links[0]?.label).toBe('Dashboard');
    // Stake's Roster + Ward Rosters appear after the manager block.
    expect(links.map((l) => l.label)).toContain('Roster');
    expect(links.map((l) => l.label)).toContain('Ward Rosters');
    // No duplicates after de-dup (My Requests collapses across roles).
    expect(new Set(links.map((l) => l.key)).size).toBe(links.length);
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

  it('renders manager links and marks the active one', async () => {
    await renderNavAtPath(makePrincipal({ managerStakes: ['csnorth'] }), '/manager/seats');
    const link = screen.getByRole('link', { name: /^All Seats$/ });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link.className).toContain('active');
    // Other links exist but are not marked active.
    const dashboard = screen.getByRole('link', { name: /^Dashboard$/ });
    expect(dashboard).not.toHaveAttribute('aria-current');
  });

  // Regression guard for the "Nav links read as tabs, not buttons"
  // ask. Three structural assertions that distinguish the two
  // affordances at the markup level:
  //   1. The clickable element is an `<a>` (role=link), not a
  //      `<button>` — a button would change the tab/keyboard
  //      semantics entirely.
  //   2. No `.btn` / `.btn-secondary` shadcn-Button class on the
  //      link — those are the pill-button affordance the operator
  //      flagged.
  //   3. The active link advertises itself via `aria-current="page"`
  //      (tab-bar pattern), not via `aria-pressed` / `role=button`
  //      (button-bar pattern).
  // Visual styling lives in CSS and is exercised by the Playwright
  // regression spec at e2e/tests/auth/nav-tabs-render.spec.ts;
  // jsdom doesn't apply CSS so we can only assert markup contracts
  // here.
  it('renders links as tab-shaped anchors, not button-shaped controls', async () => {
    await renderNavAtPath(makePrincipal({ managerStakes: ['csnorth'] }), '/manager/dashboard');

    const navLinks = screen.getAllByRole('link');
    expect(navLinks.length).toBeGreaterThan(0);
    for (const link of navLinks) {
      // The clickable element is an anchor, not a button.
      expect(link.tagName).toBe('A');
      // None of the shadcn Button / pill chrome classes leaked in.
      expect(link.className).not.toContain('btn ');
      expect(link.className).not.toMatch(/\bbtn\b/);
      expect(link.className).not.toContain('btn-secondary');
      // No `role="button"` override — link role stays a link.
      expect(link).not.toHaveAttribute('role', 'button');
      // No `aria-pressed` — that's the button-toggle ARIA, not the
      // tab-bar ARIA.
      expect(link).not.toHaveAttribute('aria-pressed');
    }

    // Active selection uses `aria-current="page"`, the tab-bar
    // ARIA pattern.
    const active = screen.getByRole('link', { name: /^Dashboard$/ });
    expect(active).toHaveAttribute('aria-current', 'page');
  });
});
