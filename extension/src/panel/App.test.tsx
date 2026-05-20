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
const resolveEidStakesMock = vi.fn();
const readEidStakeChoiceMock = vi.fn();
const writeEidStakeChoiceMock = vi.fn();
const clearEidStakeChoiceMock = vi.fn();
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
    resolveEidStakes: (...args: unknown[]) => resolveEidStakesMock(...args),
    readEidStakeChoice: (...args: unknown[]) => readEidStakeChoiceMock(...args),
    writeEidStakeChoice: (...args: unknown[]) => writeEidStakeChoiceMock(...args),
    clearEidStakeChoice: (...args: unknown[]) => clearEidStakeChoiceMock(...args),
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
    kindooSites: [],
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
    kindooSites: [],
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
    resolveEidStakesMock.mockReset();
    readEidStakeChoiceMock.mockReset();
    writeEidStakeChoiceMock.mockReset();
    clearEidStakeChoiceMock.mockReset();
    readKindooSessionMock.mockReset();
    listAllEnvironmentUsersMock.mockReset();
    // Most existing tests assume the stake is already configured; the
    // needs-config flow has its own dedicated tests.
    getStakeConfigMock.mockResolvedValue(configuredBundle());
    // Default to "operator is on a Kindoo site that maps to exactly
    // one managed stake" — keeps existing tests on the happy path
    // without modeling the picker explicitly. Picker-specific tests
    // override these.
    readKindooSessionMock.mockReturnValue({ ok: true, session: { token: 't', eid: 27994 } });
    resolveEidStakesMock.mockResolvedValue({
      candidates: [{ stakeId: 'csnorth', label: 'CSN', match: 'home' }],
      managedStakeCount: 1,
      partialFailure: false,
    });
    readEidStakeChoiceMock.mockResolvedValue(null);
    writeEidStakeChoiceMock.mockResolvedValue(undefined);
    clearEidStakeChoiceMock.mockResolvedValue(undefined);
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
    // App's resolveStake uses the default Kindoo session set in
    // beforeEach (eid 27994, one candidate). The wizard's internal
    // ConfigurePanel mounts and immediately calls readKindooSession a
    // second time; override here so the wizard's own probe surfaces
    // its no-token branch — but App still mounts ConfigurePanel.
    let sessionCalls = 0;
    readKindooSessionMock.mockImplementation(() => {
      sessionCalls += 1;
      // First call: App's stake resolver. Use a valid session.
      if (sessionCalls === 1) return { ok: true, session: { token: 't', eid: 27994 } };
      // Subsequent calls: wizard's own probe. The test asserts the
      // wizard rendered; its internal branching is covered in
      // ConfigurePanel.test.tsx.
      return { ok: false, error: 'no-token' };
    });

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
    // App's stake resolver needs a valid session; ConfigurePanel
    // inside the gear tab makes its own probe and is allowed to
    // surface no-token — its rendering happens regardless.
    let sessionCalls = 0;
    readKindooSessionMock.mockImplementation(() => {
      sessionCalls += 1;
      if (sessionCalls === 1) return { ok: true, session: { token: 't', eid: 27994 } };
      return { ok: false, error: 'no-token' };
    });

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

  it('renders the stake picker when the active EID resolves to ≥ 2 managed stakes with no stored choice', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    resolveEidStakesMock.mockResolvedValue({
      candidates: [
        { stakeId: 'csnorth', label: 'CSN', match: 'home' },
        {
          stakeId: 'east-co',
          label: 'East CO',
          match: 'foreign',
          siteLabel: 'Foothills Building',
        },
      ],
      managedStakeCount: 2,
      partialFailure: false,
    });
    readEidStakeChoiceMock.mockResolvedValue(null);

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-stake-picker')).toBeInTheDocument());
    expect(screen.getByTestId('sba-stake-picker-csnorth')).toBeInTheDocument();
    expect(screen.getByTestId('sba-stake-picker-east-co')).toBeInTheDocument();
    // The shell is gated behind the picker — no toolbar / tabs yet.
    expect(screen.queryByTestId('sba-tabbed-shell')).toBeNull();
  });

  it('skips the picker and resolves directly when a previously-stored choice is still a candidate', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    resolveEidStakesMock.mockResolvedValue({
      candidates: [
        { stakeId: 'csnorth', label: 'CSN', match: 'home' },
        { stakeId: 'east-co', label: 'East CO', match: 'foreign', siteLabel: 'Foothills' },
      ],
      managedStakeCount: 2,
      partialFailure: false,
    });
    readEidStakeChoiceMock.mockResolvedValue('east-co');
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-tabbed-shell')).toBeInTheDocument());
    expect(screen.queryByTestId('sba-stake-picker')).toBeNull();
    // Queue read carries the resolved stakeId.
    expect(getMyPendingRequestsMock).toHaveBeenCalledWith({ stakeId: 'east-co' });
  });

  it('clears a stale stored choice when it is no longer a candidate, then renders the picker', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    resolveEidStakesMock.mockResolvedValue({
      candidates: [
        { stakeId: 'csnorth', label: 'CSN', match: 'home' },
        { stakeId: 'east-co', label: 'East CO', match: 'foreign', siteLabel: 'Foothills' },
      ],
      managedStakeCount: 2,
      partialFailure: false,
    });
    // Stored choice points at a stake no longer in the candidate set
    // (operator's role got rotated away).
    readEidStakeChoiceMock.mockResolvedValue('south-co');

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-stake-picker')).toBeInTheDocument());
    expect(clearEidStakeChoiceMock).toHaveBeenCalledWith(27994);
  });

  it('renders the no-candidates recovery copy when the operator manages stakes but none has the EID configured', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    // Managed-stake count > 0 with empty candidates list = genuine
    // "EID isn't configured under any of my stakes" → reconfigure copy.
    resolveEidStakesMock.mockResolvedValue({
      candidates: [],
      managedStakeCount: 2,
      partialFailure: false,
    });

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-no-candidates')).toBeInTheDocument());
    expect(screen.getByTestId('sba-no-candidates-message')).toHaveTextContent('EID 27994');
    expect(screen.queryByTestId('sba-stake-picker')).toBeNull();
    expect(screen.queryByTestId('sba-tabbed-shell')).toBeNull();
  });

  it('renders NotAuthorized (not no-candidates) when the user holds no manager role anywhere', async () => {
    // Risk 3 fix: signed-in user with `stakes === {}` in claims should
    // land on NotAuthorized, not on the reconfigure-copy
    // no-candidates state. The old queue-callable permission-denied
    // route is preempted in App.tsx now that managerStakes is known
    // up front.
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    resolveEidStakesMock.mockResolvedValue({
      candidates: [],
      managedStakeCount: 0,
      partialFailure: false,
    });

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-not-authorized')).toBeInTheDocument());
    expect(screen.queryByTestId('sba-no-candidates')).toBeNull();
    expect(screen.queryByTestId('sba-tabbed-shell')).toBeNull();
  });

  it('renders the wire-error recovery copy (not no-candidates) when resolveEidStakes throws', async () => {
    // Risk 2 fix: a token-refresh blip or other SW failure should not
    // be misrepresented as "this EID isn't configured." Distinct copy,
    // distinct retry button.
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    resolveEidStakesMock.mockRejectedValue(new Error('SW asleep'));

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-wire-error')).toBeInTheDocument());
    expect(screen.getByTestId('sba-wire-error-message')).toHaveTextContent('reach SBA');
    expect(screen.queryByTestId('sba-no-candidates')).toBeNull();
    expect(screen.queryByTestId('sba-not-authorized')).toBeNull();
    expect(screen.queryByTestId('sba-tabbed-shell')).toBeNull();
  });

  it('renders the wire-error recovery copy when every per-stake read fails (Item 2)', async () => {
    // Item 2: a Firestore-wide outage surfaces as the resolver
    // returning empty candidates + partialFailure=true. The panel
    // must distinguish this from "EID not configured anywhere"
    // (which would tell the operator to reconfigure SBA — wrong).
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    resolveEidStakesMock.mockResolvedValue({
      candidates: [],
      managedStakeCount: 2,
      partialFailure: true,
    });

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-wire-error')).toBeInTheDocument());
    expect(screen.queryByTestId('sba-no-candidates')).toBeNull();
    expect(screen.queryByTestId('sba-not-authorized')).toBeNull();
    expect(screen.queryByTestId('sba-tabbed-shell')).toBeNull();
  });

  it('renders the no-kindoo recovery copy when the Kindoo session is missing', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    readKindooSessionMock.mockReturnValue({ ok: false, error: 'no-token' });

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-no-kindoo')).toBeInTheDocument());
    expect(screen.queryByTestId('sba-stake-picker')).toBeNull();
    expect(screen.queryByTestId('sba-tabbed-shell')).toBeNull();
  });

  it('persists the picker choice and re-renders the resolved tabbed shell', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    resolveEidStakesMock.mockResolvedValue({
      candidates: [
        { stakeId: 'csnorth', label: 'CSN', match: 'home' },
        { stakeId: 'east-co', label: 'East CO', match: 'foreign', siteLabel: 'Foothills' },
      ],
      managedStakeCount: 2,
      partialFailure: false,
    });
    readEidStakeChoiceMock.mockResolvedValue(null);
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });

    const user = userEvent.setup();
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-stake-picker')).toBeInTheDocument());
    await user.click(screen.getByTestId('sba-stake-picker-east-co'));

    await waitFor(() => expect(writeEidStakeChoiceMock).toHaveBeenCalledWith(27994, 'east-co'));
    await waitFor(() => expect(screen.getByTestId('sba-tabbed-shell')).toBeInTheDocument());
    expect(getMyPendingRequestsMock).toHaveBeenCalledWith({ stakeId: 'east-co' });
  });
});
