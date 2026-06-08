// Component tests for the tablet icon-only rail. Existing integration
// coverage lives in Shell.test.tsx; this focused file exists so the
// rail-specific affordances — version stamp, third-party Licenses
// link in the foot, panel-activation guard on the Licenses click —
// have direct assertions that survive a Shell-level refactor.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { IconRail } from './IconRail';
import type { Principal } from '../../lib/principal';

// The rail derives its sections from `navSectionsForPrincipal(principal,
// activeStakeId)`. Pin the active stake so the manager fixture below
// actually resolves its Quick Links (incl. the "Get Help" external item)
// — mirrors the same mock in Nav.test.tsx.
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
    managerStakes: ['csnorth'],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => true,
    wardsInStake: () => [],
    ...overrides,
  };
}

async function renderIconRail(onActivate = vi.fn()) {
  const rail = (
    <IconRail
      principal={makePrincipal()}
      onActivate={onActivate}
      onSignOut={() => {}}
      signingOut={false}
      version="0.1.0-test"
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
  const result = render(<RouterProvider router={router} />);
  return { ...result, onActivate };
}

describe('IconRail — footer', () => {
  it('renders the version stamp', async () => {
    await renderIconRail();
    expect(screen.getByLabelText('Build version')).toHaveTextContent('v0.1.0-test');
  });

  it('renders the third-party Licenses link pointing at /THIRD_PARTY_LICENSES.txt', async () => {
    await renderIconRail();
    const foot = document.querySelector('.kd-icon-rail-foot') as HTMLElement;
    const link = within(foot).getByRole('link', { name: 'Licenses' });
    expect(link).toHaveAttribute('href', '/THIRD_PARTY_LICENSES.txt');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('clicking the Licenses link does NOT bubble to the rail-level onActivate', async () => {
    const user = userEvent.setup();
    const { onActivate } = await renderIconRail();
    const foot = document.querySelector('.kd-icon-rail-foot') as HTMLElement;
    const link = within(foot).getByRole('link', { name: 'Licenses' });
    await user.click(link);
    expect(onActivate).not.toHaveBeenCalled();
  });
});

// The "Get Help" Quick Link is a `kind: 'external'` nav item — the only
// external item on the rail. It must render as a plain `<a href>` to the
// role-appropriate static guide (a manager principal → the Kindoo
// Manager guide), not a router `<Link>` or `<button>`, and its click
// must not bubble to the rail's open-panel handler.
describe('IconRail — external nav item (Get Help)', () => {
  it('renders the Get Help item as an <a href> to the static guide', async () => {
    await renderIconRail();
    // navModel routes a manager to the Kindoo Manager guide.
    const link = screen.getByRole('link', { name: 'Get Help' });
    expect(link).toHaveAttribute('href', '/help/kindoo-manager-guide.html');
    // Same-tab guide: no target/rel (we only set those for newTab items).
    expect(link).not.toHaveAttribute('target');
    expect(link).not.toHaveAttribute('rel');
    // External item carries no active state.
    expect(link).not.toHaveAttribute('aria-current');
  });

  it('clicking Get Help does NOT bubble to the rail-level onActivate', async () => {
    const user = userEvent.setup();
    const { onActivate } = await renderIconRail();
    await user.click(screen.getByRole('link', { name: 'Get Help' }));
    expect(onActivate).not.toHaveBeenCalled();
  });
});
