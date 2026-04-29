// Component tests for the Shell layout. Verifies the topbar's three
// promised slots — email, version, sign-out button — render for an
// authenticated principal, plus the shell stays stable when a child
// route swaps. The brand-text source (stake.stake_name → fallback
// product name) is exercised here too. Phase-2's principal hook,
// signOut helper, and the Firestore stake-doc hook are mocked at the
// module boundary so the test doesn't need a Firebase/reactfire
// context.

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
import type { Stake } from '@kindoo/shared';

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

// Mock the live stake-doc hook so the Shell renders deterministically
// in jsdom without a real Firestore connection. The default state is
// "loaded with a stake_name"; individual tests override via
// `setStakeDocResult`.
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

// `Shell` imports `db` and `stakeRef` to feed the hook; both are
// effectively no-ops here because the hook is mocked. Stub them to
// avoid pulling in the real Firebase init module under jsdom.
vi.mock('../../lib/firebase', () => ({
  db: {} as unknown,
}));
vi.mock('../../lib/docs', () => ({
  stakeRef: () => ({ id: 'csnorth' }) as unknown,
}));

import { Shell } from './Shell';

function setPrincipal(p: Principal) {
  mockedPrincipal.current = p;
}

function setStakeDocResult(state: StakeDocState) {
  mockedStakeDocResult.current = state;
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

  it('shows the stake name in the brand bar once the stake doc loads', async () => {
    setStakeDocResult({ data: { stake_name: 'CS North Stake' }, isLoading: false });
    await renderShell(<p>Hello</p>);
    const brand = document.querySelector('.kd-topbar-brand');
    expect(brand).not.toBeNull();
    expect(brand).toHaveTextContent('CS North Stake');
    expect(brand).not.toHaveTextContent('Stake Building Access');
  });

  it('falls back to the product name while the stake doc is loading', async () => {
    setStakeDocResult({ data: undefined, isLoading: true });
    await renderShell(<p>Hello</p>);
    const brand = document.querySelector('.kd-topbar-brand');
    expect(brand).toHaveTextContent('Stake Building Access');
  });

  it('falls back to the product name when the stake doc is missing', async () => {
    setStakeDocResult({ data: undefined, isLoading: false });
    await renderShell(<p>Hello</p>);
    const brand = document.querySelector('.kd-topbar-brand');
    expect(brand).toHaveTextContent('Stake Building Access');
  });

  it('falls back to the product name for unauthenticated users', async () => {
    setPrincipal(
      defaultPrincipal({
        isAuthenticated: false,
        firebaseAuthSignedIn: false,
        email: '',
        canonical: '',
        managerStakes: [],
      }),
    );
    // Even if a stale stake-doc were cached, the unauthenticated arm
    // should never show stake_name — it should always show the product
    // name. Clear the mock to simulate "no doc cached" too.
    setStakeDocResult({ data: undefined, isLoading: false });
    await renderShell(<p>Hello</p>);
    const brand = document.querySelector('.kd-topbar-brand');
    expect(brand).toHaveTextContent('Stake Building Access');
  });
});
