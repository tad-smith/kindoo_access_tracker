// Panel state-machine tests. Exercises the top-level App router by
// driving the mocked extensionApi hooks across:
//   - SignedOut (full takeover, no toolbar/tabs)
//   - NotAuthorized (full takeover, no toolbar/tabs)
//   - First-run Configure (full takeover, wizard mode, no toolbar/tabs)
//   - Tabbed shell (toolbar + tabs, defaults to Queue, switchable)
//
// The Provision & Complete flow (button click → Kindoo orchestration
// → markRequestComplete → result dialog) is covered in
// `RequestCard.test.tsx`; App tests assert only the routing + the
// tab-switch wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const useAuthStateMock = vi.fn();
const signInMock = vi.fn();
const signOutMock = vi.fn();
const getMyPendingRequestsMock = vi.fn();
const markRequestCompleteMock = vi.fn();
const getStakeConfigMock = vi.fn();
const writeKindooConfigMock = vi.fn();
const getSyncDataMock = vi.fn();
const readKindooSessionMock = vi.fn();
const listAllEnvironmentUsersMock = vi.fn();

vi.mock('../lib/extensionApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/extensionApi')>('../lib/extensionApi');
  return {
    ...actual,
    useAuthState: () => useAuthStateMock(),
    signIn: (...args: unknown[]) => signInMock(...args),
    signOut: (...args: unknown[]) => signOutMock(...args),
    getMyPendingRequests: (...args: unknown[]) => getMyPendingRequestsMock(...args),
    markRequestComplete: (...args: unknown[]) => markRequestCompleteMock(...args),
    getStakeConfig: (...args: unknown[]) => getStakeConfigMock(...args),
    writeKindooConfig: (...args: unknown[]) => writeKindooConfigMock(...args),
    getSyncData: (...args: unknown[]) => getSyncDataMock(...args),
  };
});

vi.mock('../content/kindoo/auth', () => ({
  readKindooSession: (...args: unknown[]) => readKindooSessionMock(...args),
}));

vi.mock('../content/kindoo/endpoints', async () => {
  const actual = await vi.importActual<typeof import('../content/kindoo/endpoints')>(
    '../content/kindoo/endpoints',
  );
  return {
    ...actual,
    listAllEnvironmentUsers: (...args: unknown[]) => listAllEnvironmentUsersMock(...args),
  };
});

/** Bundle that satisfies App's "fully configured" check. */
function configuredBundle() {
  return {
    stake: {
      stake_id: 'csnorth',
      stake_name: 'Colorado Springs North Stake',
      kindoo_config: {
        site_id: 27994,
        site_name: 'Colorado Springs North Stake',
        configured_at: { seconds: 1, nanoseconds: 0 },
        configured_by: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
      },
    },
    buildings: [
      {
        building_id: 'cordera',
        building_name: 'Cordera Building',
        kindoo_rule: { rule_id: 6248, rule_name: 'Cordera Doors' },
      },
    ],
    wards: [],
  };
}

/** Bundle that triggers needs-config (no kindoo_config on stake). */
function unconfiguredBundle() {
  return {
    stake: {
      stake_id: 'csnorth',
      stake_name: 'Colorado Springs North Stake',
    },
    buildings: [{ building_id: 'cordera', building_name: 'Cordera Building' }],
    wards: [],
  };
}

// Re-import after mocks so the module graph picks them up.
async function renderApp() {
  const { App } = await import('./App');
  return render(<App />);
}

function fakeRequest(overrides: Record<string, unknown> = {}) {
  return {
    request_id: 'r1',
    type: 'add_manual',
    scope: 'CO',
    member_email: 'subject@example.com',
    member_canonical: 'subject@example.com',
    member_name: 'Subject Name',
    reason: 'Elders Quorum President',
    comment: '',
    building_names: ['Centerville'],
    status: 'pending',
    requester_email: 'requester@example.com',
    requester_canonical: 'requester@example.com',
    requested_at: { seconds: 1714000000, nanoseconds: 0 },
    lastActor: { email: 'requester@example.com', canonical: 'requester@example.com' },
    ...overrides,
  };
}

describe('App', () => {
  beforeEach(() => {
    useAuthStateMock.mockReset();
    signInMock.mockReset();
    signOutMock.mockReset();
    getMyPendingRequestsMock.mockReset();
    markRequestCompleteMock.mockReset();
    getStakeConfigMock.mockReset();
    writeKindooConfigMock.mockReset();
    getSyncDataMock.mockReset();
    readKindooSessionMock.mockReset();
    listAllEnvironmentUsersMock.mockReset();
    // Most existing tests assume the stake is already configured; the
    // needs-config flow has its own dedicated tests.
    getStakeConfigMock.mockResolvedValue(configuredBundle());
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('renders the loading panel until the first auth-state fires', async () => {
    useAuthStateMock.mockReturnValue({ status: 'loading' });
    await renderApp();
    expect(screen.getByTestId('sba-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-toolbar')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('renders SignedOutPanel with no toolbar / tabs when no user is signed in', async () => {
    useAuthStateMock.mockReturnValue({ status: 'signed-out' });
    await renderApp();
    expect(screen.getByTestId('sba-signed-out')).toBeInTheDocument();
    expect(screen.getByTestId('sba-sign-in')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-toolbar')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('renders NotAuthorizedPanel with no toolbar / tabs when the callable returns permission-denied', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    const denied = Object.assign(new Error('not a manager'), { code: 'permission-denied' });
    getMyPendingRequestsMock.mockRejectedValue(denied);

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-not-authorized')).toBeInTheDocument());
    expect(screen.getByText('mgr@example.com')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-toolbar')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('renders ConfigurePanel wizard with no toolbar / tabs when signed-in but not configured', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getStakeConfigMock.mockResolvedValue(unconfiguredBundle());
    readKindooSessionMock.mockReturnValue({ ok: false, error: 'no-token' });

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-configure')).toBeInTheDocument());
    // First-run wizard renders its own "Configure Kindoo" header — no
    // shell toolbar / tab bar.
    expect(screen.getByText('Configure Kindoo')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-toolbar')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('renders TabbedShell on Queue by default once fully configured', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-tabbed-shell')).toBeInTheDocument());
    expect(screen.getByTestId('sba-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('sba-toolbar-email')).toHaveTextContent('mgr@example.com');
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    // Three tabs.
    expect(screen.getByTestId('sba-tab-queue')).toBeInTheDocument();
    expect(screen.getByTestId('sba-tab-sync')).toBeInTheDocument();
    expect(screen.getByTestId('sba-tab-configure')).toBeInTheDocument();
    // Queue is active by default.
    expect(screen.getByTestId('sba-tab-queue')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('sba-tab-sync')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('sba-tab-configure')).toHaveAttribute('aria-selected', 'false');
    // Queue body renders.
    await waitFor(() => expect(screen.getByTestId('sba-queue-empty')).toBeInTheDocument());
  });

  it('renders the pending-request list inside the Queue tab body', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getMyPendingRequestsMock.mockResolvedValue({ requests: [fakeRequest()] });

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-queue-list')).toBeInTheDocument());
    expect(screen.getByTestId('sba-request-r1')).toBeInTheDocument();
    expect(screen.getByText('Subject Name')).toBeInTheDocument();
    expect(screen.getByText(/Elders Quorum President/)).toBeInTheDocument();
  });

  it('switches to the Sync tab when clicked', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });

    const user = userEvent.setup();
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-tabbed-shell')).toBeInTheDocument());
    await user.click(screen.getByTestId('sba-tab-sync'));

    expect(screen.getByTestId('sba-tab-sync')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('sba-tab-queue')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('sba-sync')).toBeInTheDocument();
    expect(screen.getByTestId('sba-sync-idle')).toBeInTheDocument();
  });

  it('switches to the Configure (gear) tab when clicked — body has no wizard header', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    // ConfigurePanel inside the tab starts loading on mount; stub the
    // session so it does not throw.
    readKindooSessionMock.mockReturnValue({ ok: false, error: 'no-token' });

    const user = userEvent.setup();
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-tabbed-shell')).toBeInTheDocument());
    await user.click(screen.getByTestId('sba-tab-configure'));

    expect(screen.getByTestId('sba-tab-configure')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('sba-configure')).toBeInTheDocument();
    // The gear-tab body must NOT render its own "Configure Kindoo"
    // header — that belongs to wizard mode only.
    expect(screen.queryByText('Configure Kindoo')).toBeNull();
  });

  it('gear tab is labelled "Configure" for screen readers', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-tab-configure')).toBeInTheDocument());
    expect(screen.getByTestId('sba-tab-configure')).toHaveAttribute('aria-label', 'Configure');
  });

  it('labels the add-type button "Add Kindoo Access"', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getMyPendingRequestsMock.mockResolvedValue({ requests: [fakeRequest()] });

    await renderApp();
    await waitFor(() => expect(screen.getByTestId('sba-add-r1')).toBeInTheDocument());
    expect(screen.getByTestId('sba-add-r1')).toHaveTextContent('Add Kindoo Access');
  });

  it('labels remove-type cards with "Remove Kindoo Access"', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [fakeRequest({ request_id: 'r2', type: 'remove' })],
    });

    await renderApp();
    await waitFor(() => expect(screen.getByTestId('sba-remove-r2')).toBeInTheDocument());
    expect(screen.getByTestId('sba-remove-r2')).toHaveTextContent('Remove Kindoo Access');
  });
});
