// TabbedShell owns the two subsystems that have to outlive a tab
// switch — the lifted queue fetch (`usePendingRequests`) and the
// remote-apply loop (`useRemoteApply`) — plus the seam between them.
// These tests cover that seam, which neither component's own suite can
// see:
//   - a phone-initiated job finishing refetches the queue even with the
//     Queue tab unmounted, and the handle's badge follows
//   - a queue refetch does not restart the remote-apply loop
//
// Queue rendering lives in QueuePanel.test.tsx; the loop's own
// behaviour lives in loop.test.ts / useRemoteApply.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getMyPendingRequestsMock = vi.fn();
const getSeatByEmailMock = vi.fn();
const writeRemotePresenceMock = vi.fn(async () => undefined);
const startRemoteApplyLoopMock = vi.fn();

vi.mock('../lib/extensionApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/extensionApi')>('../lib/extensionApi');
  return {
    ...actual,
    getMyPendingRequests: (...args: unknown[]) => getMyPendingRequestsMock(...args),
    getSeatByEmail: (...args: unknown[]) => getSeatByEmailMock(...args),
    writeRemotePresence: (...args: unknown[]) => writeRemotePresenceMock(),
  };
});

vi.mock('../content/remoteApply/loop', () => ({
  startRemoteApplyLoop: (args: unknown) => startRemoteApplyLoopMock(args),
}));

// Opted in, so the loop actually starts — the whole point of the seam.
vi.mock('../lib/remoteApplyPrefs', () => ({
  useRemoteApplyEnabled: () => ({ enabled: true, loaded: true, setEnabled: vi.fn() }),
}));

vi.mock('./RequestCard', () => ({
  RequestCard: (props: { request: { request_id: string } }) => (
    <div data-testid={`card-${props.request.request_id}`} />
  ),
}));

vi.mock('./SyncPanel', () => ({
  SyncPanel: () => <div data-testid="sba-sync" />,
}));

vi.mock('./ConfigurePanel', () => ({
  ConfigurePanel: () => <div data-testid="sba-configure" />,
}));

import type { AccessRequest } from '@kindoo/shared';
import type { StakeConfigBundle } from '../lib/extensionApi';
import type { RemoteApplyLoopArgs, RemoteApplyLoopHandle } from '../content/remoteApply/loop';

const BUNDLE: StakeConfigBundle = {
  stake: { stake_id: 'csnorth', stake_name: 'CS North' } as unknown as StakeConfigBundle['stake'],
  buildings: [],
  wards: [],
  kindooSites: [],
};

function req(requestId: string): AccessRequest {
  return {
    request_id: requestId,
    type: 'add_manual',
    scope: 'CO',
    status: 'pending',
    member_canonical: `${requestId}@example.com`,
    member_email: `${requestId}@example.com`,
    member_name: 'Member',
    requested_at: { _seconds: 1735689600, _nanoseconds: 0 },
  } as unknown as AccessRequest;
}

/** The loop handle the mocked `startRemoteApplyLoop` hands back, plus
 * the callbacks it was constructed with so a test can fire a job end. */
function loopHandle(): RemoteApplyLoopHandle {
  return { stop: vi.fn(), tick: vi.fn(async () => undefined) };
}

function loopArgs(callIndex = 0): RemoteApplyLoopArgs {
  return startRemoteApplyLoopMock.mock.calls[callIndex]?.[0] as RemoteApplyLoopArgs;
}

async function renderShell(onPendingCountChange?: (count: number | null) => void) {
  const { TabbedShell } = await import('./TabbedShell');
  return render(
    <TabbedShell
      stakeId="csnorth"
      stakeLabel="Colorado Springs North Stake"
      email="mgr@example.com"
      bundle={BUNDLE}
      onPermissionDenied={vi.fn()}
      onConfigComplete={vi.fn()}
      onPendingCountChange={onPendingCountChange}
    />,
  );
}

describe('TabbedShell', () => {
  beforeEach(() => {
    getMyPendingRequestsMock.mockReset();
    getSeatByEmailMock.mockReset();
    getSeatByEmailMock.mockResolvedValue(null);
    writeRemotePresenceMock.mockReset();
    startRemoteApplyLoopMock.mockReset();
    startRemoteApplyLoopMock.mockImplementation(() => loopHandle());
  });
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('renders the active stake name between the toolbar and the tab strip', async () => {
    // A manager of more than one stake otherwise has nothing in the
    // panel telling them which queue they are working.
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    await renderShell();

    const label = screen.getByTestId('sba-stake-label');
    expect(label).toHaveTextContent('Colorado Springs North Stake');
    // Untruncated name stays reachable — the CSS ellipsis hides it on a
    // narrow slide-over.
    expect(label).toHaveAttribute('title', 'Colorado Springs North Stake');

    const children = Array.from(screen.getByTestId('sba-tabbed-shell').children);
    expect(children.indexOf(label)).toBeGreaterThan(
      children.indexOf(screen.getByTestId('sba-toolbar')),
    );
    expect(children.indexOf(label)).toBeLessThan(children.indexOf(screen.getByRole('tablist')));
  });

  it('refetches the queue when a phone-initiated job finishes on another tab', async () => {
    // The normal case for phone-initiated work is the manager not
    // looking at the Queue tab at all. Watching `finishedCount` inside
    // QueuePanel would miss every one of those, leaving the desktop —
    // and the handle's badge — counting a request the phone completed.
    getMyPendingRequestsMock
      .mockResolvedValueOnce({ requests: [req('r1'), req('r2')] })
      .mockResolvedValue({ requests: [req('r2')] });

    const onPendingCountChange = vi.fn();
    const user = userEvent.setup();
    await renderShell(onPendingCountChange);
    await waitFor(() => expect(onPendingCountChange).toHaveBeenCalledWith(2));

    await user.click(screen.getByTestId('sba-tab-sync'));
    expect(screen.queryByTestId('sba-queue')).toBeNull();

    await waitFor(() => expect(startRemoteApplyLoopMock).toHaveBeenCalled());
    loopArgs().onJobEnd?.({
      jobId: 'j1',
      requestId: 'r1',
      stakeId: 'csnorth',
      targetSiteKey: 'home',
      createdAtMs: 1_000,
    });

    await waitFor(() => expect(getMyPendingRequestsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onPendingCountChange).toHaveBeenCalledWith(1));
  });

  it('does not restart the remote-apply loop when the queue refetches', async () => {
    // The loop and the queue share a host, so every refetch re-renders
    // the component that starts the loop. A restart per refetch would
    // reset the heartbeat clock and — with restarts landing faster than
    // the loop's first tick — silently stop the phone ever seeing this
    // desktop.
    getMyPendingRequestsMock.mockResolvedValue({ requests: [req('r1')] });
    const user = userEvent.setup();
    await renderShell();

    await waitFor(() => expect(startRemoteApplyLoopMock).toHaveBeenCalledTimes(1));
    const handle = startRemoteApplyLoopMock.mock.results[0]?.value as RemoteApplyLoopHandle;

    await user.click(screen.getByTestId('sba-refresh'));
    await waitFor(() => expect(getMyPendingRequestsMock).toHaveBeenCalledTimes(2));

    expect(startRemoteApplyLoopMock).toHaveBeenCalledTimes(1);
    expect(handle.stop).not.toHaveBeenCalled();
  });

  it('keeps the loop running across a tab switch', async () => {
    // QueuePanel unmounts on every tab switch. A manager parked on Sync
    // has to stay reachable from their phone.
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    const user = userEvent.setup();
    await renderShell();
    await waitFor(() => expect(startRemoteApplyLoopMock).toHaveBeenCalledTimes(1));
    const handle = startRemoteApplyLoopMock.mock.results[0]?.value as RemoteApplyLoopHandle;

    await user.click(screen.getByTestId('sba-tab-sync'));
    expect(screen.getByTestId('sba-sync')).toBeInTheDocument();

    expect(handle.stop).not.toHaveBeenCalled();
    expect(startRemoteApplyLoopMock).toHaveBeenCalledTimes(1);
  });
});
