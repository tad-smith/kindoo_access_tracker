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
