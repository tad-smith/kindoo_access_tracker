// Panel state-machine tests. Exercises the four UI states by driving
// the mocked extensionApi hooks. Renders the `App` root rather than
// the inner panels so the wiring (which panel for which state,
// including the permission-denied → flip) is what is under test.

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
  });

  it('renders SignedOutPanel when no user is signed in', async () => {
    useAuthStateMock.mockReturnValue({ status: 'signed-out' });
    await renderApp();
    expect(screen.getByTestId('sba-signed-out')).toBeInTheDocument();
    expect(screen.getByTestId('sba-sign-in')).toBeInTheDocument();
  });

  it('renders NotAuthorizedPanel when the callable returns permission-denied', async () => {
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
  });

  it('renders the empty state when the manager has no pending requests', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('sba-queue-empty')).toBeInTheDocument());
  });

  it('renders the pending-request list with member details', async () => {
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

  it('opens the completion dialog and calls markRequestComplete on confirm', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getMyPendingRequestsMock.mockResolvedValue({ requests: [fakeRequest()] });
    markRequestCompleteMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    await renderApp();
    await waitFor(() => expect(screen.getByTestId('sba-request-r1')).toBeInTheDocument());

    await user.click(screen.getByTestId('sba-complete-r1'));
    expect(screen.getByTestId('sba-complete-dialog')).toBeInTheDocument();

    await user.type(screen.getByTestId('sba-complete-note'), 'Added in Kindoo.');
    await user.click(screen.getByTestId('sba-complete-confirm'));

    await waitFor(() =>
      expect(markRequestCompleteMock).toHaveBeenCalledWith({
        stakeId: 'csnorth',
        requestId: 'r1',
        completionNote: 'Added in Kindoo.',
      }),
    );
  });

  it('omits the completionNote field when the textarea is empty', async () => {
    useAuthStateMock.mockReturnValue({
      status: 'signed-in',
      email: 'mgr@example.com',
      displayName: null,
    });
    getMyPendingRequestsMock.mockResolvedValue({ requests: [fakeRequest()] });
    markRequestCompleteMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    await renderApp();
    await waitFor(() => expect(screen.getByTestId('sba-request-r1')).toBeInTheDocument());

    await user.click(screen.getByTestId('sba-complete-r1'));
    await user.click(screen.getByTestId('sba-complete-confirm'));

    await waitFor(() =>
      expect(markRequestCompleteMock).toHaveBeenCalledWith({
        stakeId: 'csnorth',
        requestId: 'r1',
      }),
    );
  });
});
