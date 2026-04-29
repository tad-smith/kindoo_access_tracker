// Component tests for the `_authed` route's setup-complete gate. The
// gate routes per `docs/firebase-migration.md` §Phase 7 +
// `docs/spec.md` §10 — see the file header in `_authed.tsx`.
//
// Each test mocks `usePrincipal` and `useFirestoreDoc` to drive the
// gate inputs deterministically; we render `<AuthedLayout />` directly
// (exported for testing) so we don't need to rebuild the file-based
// route tree.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Principal } from '../lib/principal';
import type { Stake } from '@kindoo/shared';

const mockedPrincipal: { current: Principal } = {
  current: {
    isAuthenticated: false,
    firebaseAuthSignedIn: false,
    email: '',
    canonical: '',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => false,
    wardsInStake: () => [],
  },
};

vi.mock('../lib/principal', () => ({
  usePrincipal: () => mockedPrincipal.current,
}));

type StakeResult = {
  data: Partial<Stake> | undefined;
  status: 'pending' | 'success' | 'error';
  isLoading: boolean;
  error: null;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: 'idle';
};
const mockedStake: { current: StakeResult } = {
  current: {
    data: undefined,
    status: 'pending',
    isLoading: true,
    error: null,
    isPending: true,
    isSuccess: false,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  },
};

vi.mock('../lib/data', () => ({
  useFirestoreDoc: () => mockedStake.current,
}));

vi.mock('../lib/firebase', () => ({ db: {} }));
vi.mock('../lib/docs', () => ({ stakeRef: () => ({}) }));

// Stub-render the leaf pages the gate may show. The gate's branch
// selection is what we test; page content is mocked.
vi.mock('../components/layout/Shell', () => ({
  Shell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell-rendered">{children}</div>
  ),
}));
vi.mock('../features/auth/SignInPage', () => ({
  SignInPage: () => <div data-testid="signin-page">SignIn</div>,
}));
vi.mock('../features/auth/NotAuthorizedPage', () => ({
  NotAuthorizedPage: () => <div data-testid="notauth-page">NotAuth</div>,
}));
vi.mock('../features/auth/SetupInProgressPage', () => ({
  SetupInProgressPage: () => <div data-testid="setup-in-progress">SetupInProgress</div>,
}));
vi.mock('../features/bootstrap/BootstrapWizardPage', () => ({
  BootstrapWizardPage: () => <div data-testid="wizard-page">Wizard</div>,
}));

// `<Outlet />` from @tanstack/react-router needs a router context;
// stub it so we can render `<AuthedLayout />` standalone.
vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    Outlet: () => <div data-testid="outlet" />,
  };
});

import { AuthedLayout } from './_authed';

function setStake(over: Partial<StakeResult>) {
  mockedStake.current = { ...mockedStake.current, ...over };
}
function makeStakeDoc(over: Partial<Stake> = {}): Partial<Stake> {
  return {
    stake_id: 'csnorth',
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.current = {
    isAuthenticated: false,
    firebaseAuthSignedIn: false,
    email: '',
    canonical: '',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => false,
    wardsInStake: () => [],
  };
  setStake({
    data: undefined,
    status: 'pending',
    isLoading: true,
    isPending: true,
    isSuccess: false,
    isError: false,
  });
});

describe('_authed gate', () => {
  it('renders SignInPage when no Firebase Auth user is present', () => {
    render(<AuthedLayout />);
    expect(screen.getByTestId('signin-page')).toBeInTheDocument();
  });

  it('renders the Wizard when bootstrap admin signs in during setup', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      firebaseAuthSignedIn: true,
      isAuthenticated: false,
      email: 'admin@example.com',
      canonical: 'admin@example.com',
    };
    setStake({
      data: makeStakeDoc({ setup_complete: false, bootstrap_admin_email: 'admin@example.com' }),
      status: 'success',
      isLoading: false,
      isPending: false,
      isSuccess: true,
    });
    render(<AuthedLayout />);
    expect(screen.getByTestId('wizard-page')).toBeInTheDocument();
  });

  it('renders SetupInProgress for non-admin during setup (precedence over NotAuthorized)', () => {
    // Non-admin with NO claims signs in during setup_complete=false.
    // SetupInProgress takes precedence over NotAuthorized per spec §10.
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      firebaseAuthSignedIn: true,
      isAuthenticated: false,
      email: 'random@example.com',
      canonical: 'random@example.com',
    };
    setStake({
      data: makeStakeDoc({ setup_complete: false, bootstrap_admin_email: 'admin@example.com' }),
      status: 'success',
      isLoading: false,
      isPending: false,
      isSuccess: true,
    });
    render(<AuthedLayout />);
    expect(screen.getByTestId('setup-in-progress')).toBeInTheDocument();
    expect(screen.queryByTestId('notauth-page')).toBeNull();
  });

  it('renders NotAuthorized for no-claims user post-setup', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      firebaseAuthSignedIn: true,
      isAuthenticated: false,
      email: 'random@example.com',
      canonical: 'random@example.com',
    };
    setStake({
      data: makeStakeDoc({ setup_complete: true }),
      status: 'success',
      isLoading: false,
      isPending: false,
      isSuccess: true,
    });
    render(<AuthedLayout />);
    expect(screen.getByTestId('notauth-page')).toBeInTheDocument();
  });

  it('renders Shell+Outlet for authenticated principal post-setup', () => {
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      firebaseAuthSignedIn: true,
      isAuthenticated: true,
      email: 'mgr@example.com',
      canonical: 'mgr@example.com',
      managerStakes: ['csnorth'],
      hasAnyRole: () => true,
    };
    setStake({
      data: makeStakeDoc({ setup_complete: true }),
      status: 'success',
      isLoading: false,
      isPending: false,
      isSuccess: true,
    });
    render(<AuthedLayout />);
    expect(screen.getByTestId('shell-rendered')).toBeInTheDocument();
  });

  it('renders NotAuthorized immediately for no-claims user even while stake-doc is pending', () => {
    // The Firestore permission-denied listener can take seconds to
    // fire its error callback in CI; we don't block on it for
    // no-claims users. They land on NotAuthorized straight away. If
    // the stake doc later resolves with `setup_complete=false`, the
    // gate above re-renders into SetupInProgress (the rare
    // non-admin-during-bootstrap case).
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      firebaseAuthSignedIn: true,
      isAuthenticated: false,
      email: 'someone@example.com',
      canonical: 'someone@example.com',
    };
    // Stake status remains pending.
    render(<AuthedLayout />);
    expect(screen.getByTestId('notauth-page')).toBeInTheDocument();
  });

  it('waits (renders nothing) while the stake-doc subscription is pending for AUTHENTICATED users', () => {
    // For authenticated principals (managers etc.) we still wait so a
    // manager who's also the bootstrap admin doesn't flash the
    // dashboard before the wizard gate fires.
    mockedPrincipal.current = {
      ...mockedPrincipal.current,
      firebaseAuthSignedIn: true,
      isAuthenticated: true,
      email: 'mgr@example.com',
      canonical: 'mgr@example.com',
      managerStakes: ['csnorth'],
      hasAnyRole: () => true,
    };
    // Stake status pending → null render (no Shell yet).
    const { container } = render(<AuthedLayout />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('shell-rendered')).toBeNull();
  });
});
