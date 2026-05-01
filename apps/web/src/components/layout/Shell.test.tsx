// Component tests for the Shell layout. The brand bar's promised
// slots — stake name, user email — render for an authenticated
// principal at desktop / tablet widths; on phone the email moves
// into the drawer footer. The shell stays stable when a child
// route swaps. The brand-text source (stake.stake_name → fallback
// product name) is exercised here too.
//
// `usePrincipal`, the `signOut` helper, and the Firestore stake-doc
// hook are mocked at the module boundary so the test doesn't need a
// Firebase / DIY-data context.

import { describe, expect, it, vi, beforeEach } from 'vitest';
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
import type { Principal } from '../../lib/principal';
import type { Stake } from '@kindoo/shared';

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

vi.mock('../../version', () => ({
  KINDOO_WEB_VERSION: '4.0.0-test',
}));

type StakeDocState = {
  data: Partial<Stake> | undefined;
  isLoading: boolean;
};
const mockedStakeDocResult: { current: StakeDocState } = {
  current: { data: { stake_name: 'CS North Stake' }, isLoading: false },
};

vi.mock('../../lib/data', () => ({
  useFirestoreDoc: () => mockedStakeDocResult.current,
}));

vi.mock('../../lib/firebase', () => ({
  db: {} as unknown,
}));
vi.mock('../../lib/docs', () => ({
  stakeRef: () => ({ id: 'csnorth' }) as unknown,
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [false, () => {}],
    offlineReady: [false, () => {}],
    updateServiceWorker: async () => {},
  }),
}));

// Breakpoint mock — defaults to desktop. Individual tests can swap.
type BreakpointKind = 'phone' | 'tablet' | 'desktop';
const mockedBreakpoint: { current: BreakpointKind } = { current: 'desktop' };
vi.mock('../../lib/useBreakpoint', () => ({
  useBreakpoint: () => mockedBreakpoint.current,
}));

import { Shell } from './Shell';

function setPrincipal(p: Principal) {
  mockedPrincipal.current = p;
}

function setStakeDocResult(state: StakeDocState) {
  mockedStakeDocResult.current = state;
}

function setBreakpoint(bp: BreakpointKind) {
  mockedBreakpoint.current = bp;
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
  setStakeDocResult({ data: { stake_name: 'CS North Stake' }, isLoading: false });
  setBreakpoint('desktop');
});

describe('Shell — brand bar', () => {
  it('renders the principal email + version stamp at desktop width', async () => {
    await renderShell(<p>Hello</p>);
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByLabelText('Build version')).toHaveTextContent('v4.0.0-test');
  });

  it('does NOT render a logout button in the brand bar at desktop width', async () => {
    await renderShell(<p>Hello</p>);
    const brandbar = document.querySelector('.kd-brandbar');
    expect(brandbar).not.toBeNull();
    // The brand bar carries no sign-out affordance; logout lives in
    // the rail's footer.
    expect(within(brandbar as HTMLElement).queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  it('does NOT render a logout button in the brand bar at tablet width', async () => {
    setBreakpoint('tablet');
    await renderShell(<p>Hello</p>);
    const brandbar = document.querySelector('.kd-brandbar');
    expect(within(brandbar as HTMLElement).queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  it('does NOT render a logout button in the brand bar at phone width', async () => {
    setBreakpoint('phone');
    await renderShell(<p>Hello</p>);
    const brandbar = document.querySelector('.kd-brandbar');
    expect(within(brandbar as HTMLElement).queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  it('renders the brand-bar icon next to the wordmark', async () => {
    await renderShell(<p>Hello</p>);
    const brand = document.querySelector('.kd-brandbar-brand');
    const icon = brand?.querySelector('img.kd-brand-icon') as HTMLImageElement | null;
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('src')).toBe('/favicon.svg');
  });

  it('shows the stake name in the brand bar once the stake doc loads', async () => {
    setStakeDocResult({ data: { stake_name: 'CS North Stake' }, isLoading: false });
    await renderShell(<p>Hello</p>);
    const brand = document.querySelector('.kd-brandbar-brand');
    expect(brand).not.toBeNull();
    expect(brand).toHaveTextContent('CS North Stake');
    expect(brand).not.toHaveTextContent('Stake Building Access');
  });

  it('falls back to the product name while the stake doc is loading', async () => {
    setStakeDocResult({ data: undefined, isLoading: true });
    await renderShell(<p>Hello</p>);
    const brand = document.querySelector('.kd-brandbar-brand');
    expect(brand).toHaveTextContent('Stake Building Access');
  });

  it('hides the email in the brand bar at phone width', async () => {
    setBreakpoint('phone');
    await renderShell(<p>Hello</p>);
    const brandbar = document.querySelector('.kd-brandbar');
    expect(within(brandbar as HTMLElement).queryByText('alice@example.com')).toBeNull();
  });

  it('renders the hamburger button at phone width', async () => {
    setBreakpoint('phone');
    await renderShell(<p>Hello</p>);
    expect(screen.getByRole('button', { name: /open navigation/i })).toBeInTheDocument();
  });

  it('does NOT render the hamburger at desktop width', async () => {
    setBreakpoint('desktop');
    await renderShell(<p>Hello</p>);
    expect(screen.queryByRole('button', { name: /open navigation/i })).toBeNull();
  });
});

describe('Shell — desktop rail', () => {
  it("renders the persistent left rail with the Account section's Logout button", async () => {
    await renderShell(<p>Hello</p>);
    const rail = document.querySelector('.kd-left-rail');
    expect(rail).not.toBeNull();
    // Logout lives inside the Account section's nav body now, not at
    // the rail foot.
    const logout = within(rail as HTMLElement).getByRole('button', { name: /^Logout$/ });
    expect(logout).toBeInTheDocument();
  });

  it('clicking Logout invokes the signOut helper', async () => {
    const user = userEvent.setup();
    signOutMock.mockResolvedValueOnce(undefined);
    await renderShell(<p>Hello</p>);
    const rail = document.querySelector('.kd-left-rail') as HTMLElement;
    await user.click(within(rail).getByRole('button', { name: /^Logout$/ }));
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it('renders the version stamp in the rail footer (no Logout in foot)', async () => {
    await renderShell(<p>Hello</p>);
    const rail = document.querySelector('.kd-left-rail') as HTMLElement;
    expect(within(rail).getByLabelText('Build version')).toHaveTextContent('v4.0.0-test');
    // No logout button at the foot — the foot holds only the version.
    const foot = rail.querySelector('.kd-left-rail-foot') as HTMLElement;
    expect(within(foot).queryByRole('button')).toBeNull();
  });
});

describe('Shell — tablet icon rail', () => {
  beforeEach(() => {
    setBreakpoint('tablet');
  });

  it('renders the icons-only rail', async () => {
    await renderShell(<p>Hello</p>);
    const rail = document.querySelector('.kd-icon-rail');
    expect(rail).not.toBeNull();
  });

  it('does not render the desktop rail', async () => {
    await renderShell(<p>Hello</p>);
    expect(document.querySelector('.kd-left-rail')).toBeNull();
  });

  it('clicking an icon does NOT open the panel (icons navigate directly)', async () => {
    const user = userEvent.setup();
    await renderShell(<p>Hello</p>);
    expect(document.querySelector('.kd-nav-overlay')).toBeNull();
    const rail = document.querySelector('.kd-icon-rail') as HTMLElement;
    const firstIconLink = within(rail).getAllByRole('link')[0];
    if (!firstIconLink) throw new Error('icon rail had no links');
    await user.click(firstIconLink);
    // Direct navigation; no overlay opens.
    expect(document.querySelector('.kd-nav-overlay-panel')).toBeNull();
  });

  it('clicking a non-icon rail area opens the floating panel', async () => {
    const user = userEvent.setup();
    await renderShell(<p>Hello</p>);
    expect(document.querySelector('.kd-nav-overlay')).toBeNull();
    // The section divider sits between sections and is a non-icon
    // hit-target; clicking it bubbles up to the rail's onClick which
    // opens the panel.
    const divider = document.querySelector('.kd-icon-rail-divider') as HTMLElement | null;
    if (!divider) throw new Error('icon rail had no divider');
    await user.click(divider);
    expect(document.querySelector('.kd-nav-overlay-panel')).not.toBeNull();
  });

  it('clicking the backdrop closes the panel', async () => {
    const user = userEvent.setup();
    await renderShell(<p>Hello</p>);
    // Open via non-icon area (gap click).
    const divider = document.querySelector('.kd-icon-rail-divider') as HTMLElement | null;
    if (!divider) throw new Error('icon rail had no divider');
    await user.click(divider);
    expect(document.querySelector('.kd-nav-overlay-panel')).not.toBeNull();
    await user.click(screen.getByTestId('nav-overlay-backdrop'));
    expect(document.querySelector('.kd-nav-overlay-panel')).toBeNull();
  });

  it('clicking the Logout icon does NOT open the panel (signs out directly)', async () => {
    const user = userEvent.setup();
    signOutMock.mockResolvedValueOnce(undefined);
    await renderShell(<p>Hello</p>);
    const rail = document.querySelector('.kd-icon-rail') as HTMLElement;
    // Logout is now an action item inside the rail body (Account
    // section), not a dedicated foot button.
    const logout = within(rail).getByRole('button', { name: /^Logout$/ });
    await user.click(logout);
    expect(document.querySelector('.kd-nav-overlay-panel')).toBeNull();
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });
});

describe('Shell — phone drawer', () => {
  beforeEach(() => {
    setBreakpoint('phone');
  });

  it('clicking the hamburger opens the drawer', async () => {
    const user = userEvent.setup();
    await renderShell(<p>Hello</p>);
    expect(document.querySelector('.kd-nav-overlay-drawer')).toBeNull();
    await user.click(screen.getByRole('button', { name: /open navigation/i }));
    expect(document.querySelector('.kd-nav-overlay-drawer')).not.toBeNull();
  });

  it('drawer footer carries the email + version (Logout moved into Account section)', async () => {
    const user = userEvent.setup();
    await renderShell(<p>Hello</p>);
    await user.click(screen.getByRole('button', { name: /open navigation/i }));
    const drawer = document.querySelector('.kd-nav-overlay-drawer') as HTMLElement;
    expect(within(drawer).getByText('alice@example.com')).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Build version')).toHaveTextContent('v4.0.0-test');
    // Logout is now an Account-section nav item inside the drawer
    // body, not a foot button.
    const foot = drawer.querySelector('.kd-nav-overlay-foot') as HTMLElement;
    expect(within(foot).queryByRole('button')).toBeNull();
    expect(within(drawer).getByRole('button', { name: /^Logout$/ })).toBeInTheDocument();
  });

  it('clicking the backdrop closes the drawer', async () => {
    const user = userEvent.setup();
    await renderShell(<p>Hello</p>);
    await user.click(screen.getByRole('button', { name: /open navigation/i }));
    expect(document.querySelector('.kd-nav-overlay-drawer')).not.toBeNull();
    await user.click(screen.getByTestId('nav-overlay-backdrop'));
    expect(document.querySelector('.kd-nav-overlay-drawer')).toBeNull();
  });

  it('does not render the desktop rail or the icon rail', async () => {
    await renderShell(<p>Hello</p>);
    expect(document.querySelector('.kd-left-rail')).toBeNull();
    expect(document.querySelector('.kd-icon-rail')).toBeNull();
  });
});

describe('Shell — auth gating', () => {
  it('does not render the email/sign-out for an unauthenticated principal', async () => {
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
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(document.querySelector('.kd-left-rail')).toBeNull();
  });

  it('renders the child content', async () => {
    await renderShell(<p data-testid="content">child</p>);
    expect(screen.getByTestId('content')).toHaveTextContent('child');
  });
});
