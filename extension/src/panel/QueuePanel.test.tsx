// Component tests for QueuePanel's section layout + seat-existence
// overlay. Mocks the extensionApi callable wrappers and stubs
// RequestCard so the assertions stay on what QueuePanel owns:
//   - three ordered sections (Urgent → Outstanding → Future) with open
//     counts, empty sections hidden
//   - cards within a section in comparison-date order
//   - overall empty-state + Refresh
//   - three-state seat-existence map threaded into each card's
//     `memberHasSeat` (present) + `memberSeatAbsent` (absent), with a
//     failed lookup omitted from the map → both flags false ("unknown")
//
// The provision / reject behaviour itself lives in RequestCard.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getMyPendingRequestsMock = vi.fn();
const getSeatByEmailMock = vi.fn();

vi.mock('../lib/extensionApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/extensionApi')>('../lib/extensionApi');
  return {
    ...actual,
    getMyPendingRequests: (...args: unknown[]) => getMyPendingRequestsMock(...args),
    getSeatByEmail: (...args: unknown[]) => getSeatByEmailMock(...args),
  };
});

// Stub RequestCard — render its id + the seat-existence / stake-grant
// flags as test markers so QueuePanel's wiring is observable without
// exercising the provision machinery. `data-has-seat` reflects
// `memberHasSeat` (present); `data-seat-absent` reflects
// `memberSeatAbsent` (positively absent); `data-has-stake-grant`
// reflects `memberHasStakeGrant`. Existence flags both false = "unknown".
vi.mock('./RequestCard', () => ({
  RequestCard: (props: {
    request: { request_id: string };
    memberHasSeat: boolean;
    memberSeatAbsent: boolean;
    memberHasStakeGrant: boolean;
    remoteApplyBusy?: 'elsewhere' | 'this-tab';
  }) => (
    <div
      data-testid={`card-${props.request.request_id}`}
      data-has-seat={props.memberHasSeat ? 'true' : 'false'}
      data-seat-absent={props.memberSeatAbsent ? 'true' : 'false'}
      data-has-stake-grant={props.memberHasStakeGrant ? 'true' : 'false'}
      data-remote-busy={props.remoteApplyBusy ?? 'none'}
    />
  ),
}));

import type { AccessRequest } from '@kindoo/shared';
import type { StakeConfigBundle } from '../lib/extensionApi';
import type { RemoteApplyState } from '../content/remoteApply/useRemoteApply';

function bundle(): StakeConfigBundle {
  return {
    stake: { stake_id: 'csnorth', stake_name: 'CS North' } as unknown as StakeConfigBundle['stake'],
    buildings: [],
    wards: [],
    kindooSites: [],
  };
}

/** A `RemoteApplyState` with everything the test isn't asserting on
 * left at its resting value. */
function remoteState(overrides: Partial<RemoteApplyState> = {}): RemoteApplyState {
  return { running: null, busyRequestIds: [], finishedCount: 0, ...overrides };
}

function wireTs(iso: string): AccessRequest['requested_at'] {
  const ms = new Date(iso).getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: 0,
  } as unknown as AccessRequest['requested_at'];
}

function req(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'r',
    type: 'add_manual',
    scope: 'stake',
    member_email: 'm@example.com',
    member_canonical: 'm@example.com',
    member_name: 'Member',
    reason: '',
    comment: '',
    building_names: [],
    status: 'pending',
    requester_email: 'req@example.com',
    requester_canonical: 'req@example.com',
    requested_at: wireTs('2026-06-01T08:00:00Z'),
    lastActor: { email: 'a@x', canonical: 'a@x' },
    ...overrides,
  } as AccessRequest;
}

// QueuePanel owns neither the queue fetch nor the remote-apply loop —
// TabbedShell hosts both (`usePendingRequests` / `useRemoteApply`) so
// they survive tab switches. Mirror that wiring here so the fetch-driven
// assertions below keep exercising the real hook rather than a
// hand-rolled stub, and so `remoteApply` arrives the way it does in
// production: as a prop that changes without disturbing the queue.
async function renderPanel(onPermissionDenied = vi.fn()) {
  const { QueuePanel } = await import('./QueuePanel');
  const { usePendingRequests } = await import('./usePendingRequests');
  const stableBundle = bundle();
  function Harness({ remoteApply }: { remoteApply?: RemoteApplyState }) {
    const pending = usePendingRequests('csnorth', onPermissionDenied);
    return (
      <QueuePanel
        stakeId="csnorth"
        bundle={stableBundle}
        pending={pending}
        remoteApply={remoteApply}
      />
    );
  }
  const view = render(<Harness />);
  return {
    ...view,
    /** Push a new remote-apply snapshot without remounting — the queue
     * keeps its state and does not refetch, exactly as in TabbedShell. */
    setRemoteApply: (remoteApply: RemoteApplyState) =>
      view.rerender(<Harness remoteApply={remoteApply} />),
  };
}

describe('QueuePanel', () => {
  beforeEach(() => {
    getMyPendingRequestsMock.mockReset();
    getSeatByEmailMock.mockReset();
    getSeatByEmailMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('shows the empty-state when there are no pending requests', async () => {
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('sba-queue-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('sba-queue-sections')).not.toBeInTheDocument();
  });

  it('renders only non-empty sections, each with its open count', async () => {
    // Pin "now" so the outstanding/future boundary is deterministic.
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0)); // 2026-06-01 noon local
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [
        req({ request_id: 'urg', urgent: true }),
        req({ request_id: 'out', requested_at: wireTs('2026-06-02T08:00:00Z') }),
        // No future request → Future section must be absent.
      ],
    });
    await renderPanel();

    await waitFor(() => expect(screen.getByTestId('sba-queue-section-urgent')).toBeInTheDocument());
    expect(screen.getByTestId('sba-queue-section-urgent')).toHaveTextContent(
      'Emergency Requests (1)',
    );
    expect(screen.getByTestId('sba-queue-section-outstanding')).toHaveTextContent(
      'Outstanding Requests (1)',
    );
    expect(screen.queryByTestId('sba-queue-section-future')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('orders cards within a section by comparison date ascending', async () => {
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0));
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [
        req({ request_id: 'late', requested_at: wireTs('2026-06-03T08:00:00Z') }),
        req({ request_id: 'early', requested_at: wireTs('2026-06-01T08:00:00Z') }),
        req({ request_id: 'mid', requested_at: wireTs('2026-06-02T08:00:00Z') }),
      ],
    });
    await renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('sba-queue-section-outstanding')).toBeInTheDocument(),
    );
    const section = screen.getByTestId('sba-queue-section-outstanding');
    const ids = within(section)
      .getAllByTestId(/^card-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['card-early', 'card-mid', 'card-late']);
    vi.useRealTimers();
  });

  it('threads three-state seat-existence into add cards and omits failed lookups', async () => {
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [
        req({ request_id: 'has-seat', member_canonical: 'a@x' }),
        req({ request_id: 'no-seat', member_canonical: 'b@x' }),
        req({ request_id: 'errored', member_canonical: 'c@x' }),
      ],
    });
    getSeatByEmailMock.mockImplementation((_stakeId: string, canonical: string) => {
      if (canonical === 'a@x') return Promise.resolve({ member_canonical: 'a@x' });
      if (canonical === 'b@x') return Promise.resolve(null);
      return Promise.reject(new Error('read failed'));
    });
    await renderPanel();

    // Cards render as soon as the queue resolves; the seat-existence
    // overlay lands a tick later, so wait on the overlay itself.
    await waitFor(() =>
      expect(screen.getByTestId('card-has-seat')).toHaveAttribute('data-has-seat', 'true'),
    );
    // Present → has-seat true, absent false.
    expect(screen.getByTestId('card-has-seat')).toHaveAttribute('data-seat-absent', 'false');
    // Positively absent → has-seat false, absent true.
    expect(screen.getByTestId('card-no-seat')).toHaveAttribute('data-has-seat', 'false');
    expect(screen.getByTestId('card-no-seat')).toHaveAttribute('data-seat-absent', 'true');
    // Failed lookup is omitted from the map → both flags false ("unknown").
    expect(screen.getByTestId('card-errored')).toHaveAttribute('data-has-seat', 'false');
    expect(screen.getByTestId('card-errored')).toHaveAttribute('data-seat-absent', 'false');
  });

  it('derives memberHasStakeGrant from the seat (primary stake / duplicate stake / neither)', async () => {
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [
        req({ request_id: 'primary-stake', member_canonical: 'a@x' }),
        req({ request_id: 'dup-stake', member_canonical: 'b@x' }),
        req({ request_id: 'ward-only', member_canonical: 'c@x' }),
        req({ request_id: 'no-seat', member_canonical: 'd@x' }),
      ],
    });
    getSeatByEmailMock.mockImplementation((_stakeId: string, canonical: string) => {
      if (canonical === 'a@x') {
        return Promise.resolve({ member_canonical: 'a@x', scope: 'stake', duplicate_grants: [] });
      }
      if (canonical === 'b@x') {
        return Promise.resolve({
          member_canonical: 'b@x',
          scope: 'CO',
          duplicate_grants: [{ scope: 'stake' }],
        });
      }
      if (canonical === 'c@x') {
        return Promise.resolve({
          member_canonical: 'c@x',
          scope: 'CO',
          duplicate_grants: [{ scope: 'DT' }],
        });
      }
      return Promise.resolve(null);
    });
    await renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('card-primary-stake')).toHaveAttribute(
        'data-has-stake-grant',
        'true',
      ),
    );
    // Ward primary + stake duplicate → has stake grant.
    expect(screen.getByTestId('card-dup-stake')).toHaveAttribute('data-has-stake-grant', 'true');
    // Ward primary + non-stake duplicate → no stake grant (the applyable case).
    expect(screen.getByTestId('card-ward-only')).toHaveAttribute('data-has-stake-grant', 'false');
    // No seat at all → no stake grant.
    expect(screen.getByTestId('card-no-seat')).toHaveAttribute('data-has-stake-grant', 'false');
  });

  it('threads three-state seat-existence into edit cards (absent → seat-absent flag)', async () => {
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [
        req({ request_id: 'edit-has', type: 'edit_manual', member_canonical: 'a@x' }),
        req({ request_id: 'edit-missing', type: 'edit_auto', member_canonical: 'b@x' }),
        req({ request_id: 'edit-errored', type: 'edit_temp', member_canonical: 'c@x' }),
      ],
    });
    getSeatByEmailMock.mockImplementation((_stakeId: string, canonical: string) => {
      if (canonical === 'a@x') return Promise.resolve({ member_canonical: 'a@x' });
      if (canonical === 'b@x') return Promise.resolve(null);
      return Promise.reject(new Error('read failed'));
    });
    await renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('card-edit-has')).toHaveAttribute('data-has-seat', 'true'),
    );
    // Edit with a present seat → not absent (provision button stays).
    expect(screen.getByTestId('card-edit-has')).toHaveAttribute('data-seat-absent', 'false');
    // Edit with no seat → seat-absent flag set (edit gate fires).
    expect(screen.getByTestId('card-edit-missing')).toHaveAttribute('data-seat-absent', 'true');
    expect(screen.getByTestId('card-edit-missing')).toHaveAttribute('data-has-seat', 'false');
    // Failed lookup omitted → unknown → not blocked (fail-safe).
    expect(screen.getByTestId('card-edit-errored')).toHaveAttribute('data-seat-absent', 'false');
    expect(screen.getByTestId('card-edit-errored')).toHaveAttribute('data-has-seat', 'false');
  });

  it('runs the seat lookup for edit types as well as adds', async () => {
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [req({ request_id: 'ed', type: 'edit_manual', member_canonical: 'e@x' })],
    });
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('card-ed')).toBeInTheDocument());
    expect(getSeatByEmailMock).toHaveBeenCalledWith('csnorth', 'e@x');
  });

  it('does not run seat lookups for remove request types', async () => {
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [req({ request_id: 'rm', type: 'remove' })],
    });
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('card-rm')).toBeInTheDocument());
    expect(getSeatByEmailMock).not.toHaveBeenCalled();
  });

  it('routes permission-denied to onPermissionDenied', async () => {
    getMyPendingRequestsMock.mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'permission-denied' }),
    );
    const onPermissionDenied = vi.fn();
    await renderPanel(onPermissionDenied);
    await waitFor(() => expect(onPermissionDenied).toHaveBeenCalledTimes(1));
  });

  it('surfaces a non-permission error inline', async () => {
    getMyPendingRequestsMock.mockRejectedValue(new Error('network down'));
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId('sba-queue-error')).toHaveTextContent('network down'),
    );
  });

  it('refetches on Refresh', async () => {
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('sba-queue-empty')).toBeInTheDocument());
    expect(getMyPendingRequestsMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('sba-refresh'));
    await waitFor(() => expect(getMyPendingRequestsMock).toHaveBeenCalledTimes(2));
  });

  // ---- Remote apply --------------------------------------------------

  it('renders the remote-apply opt-in above the queue, off by default', async () => {
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('sba-queue-empty')).toBeInTheDocument());
    const toggle = screen.getByTestId('sba-remote-apply-toggle');
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId('sba-remote-apply-row')).toHaveTextContent(
      'Allow requests from my phone',
    );
  });

  it('persists the opt-in to chrome.storage.local when switched on', async () => {
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('sba-remote-apply-toggle')).toBeEnabled());

    await user.click(screen.getByTestId('sba-remote-apply-toggle'));

    await waitFor(() =>
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ 'sba.remoteApplyEnabled': true }),
    );
    expect(screen.getByTestId('sba-remote-apply-toggle')).toBeChecked();
  });

  it('shows a banner only while a phone-initiated job is running', async () => {
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    const { setRemoteApply } = await renderPanel();
    await waitFor(() => expect(screen.getByTestId('sba-queue-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('sba-remote-apply-running')).not.toBeInTheDocument();

    setRemoteApply(remoteState({ running: { jobId: 'j1', requestId: 'r1' } }));
    expect(screen.getByTestId('sba-remote-apply-running')).toBeInTheDocument();
  });

  it('shows the handling banner while a job is in another hand', async () => {
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    const { setRemoteApply } = await renderPanel();
    await waitFor(() => expect(screen.getByTestId('sba-queue-empty')).toBeInTheDocument());

    setRemoteApply(remoteState({ busyRequestIds: ['r1'] }));
    expect(screen.getByTestId('sba-remote-apply-queued')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-remote-apply-running')).not.toBeInTheDocument();

    // The claim replaces it rather than stacking a second banner — the
    // two overlap for a poll period around the claim.
    setRemoteApply(remoteState({ running: { jobId: 'j1', requestId: 'r1' } }));
    expect(screen.getByTestId('sba-remote-apply-running')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-remote-apply-queued')).not.toBeInTheDocument();
  });

  it('flags only the card whose request a phone-initiated job is applying', async () => {
    // The banner alone is informational — the card's own provision
    // button has to be gated too, or the manager can tap Apply on their
    // phone and click the desktop button on the same request and get two
    // concurrent `applyRequest` runs. Two `inviteUser` writes to Kindoo
    // costs a licence, and no amount of SBA-side settling undoes it.
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [
        req({ request_id: 'r1', requested_at: wireTs('2026-01-01T00:00:00Z') }),
        req({ request_id: 'r2', requested_at: wireTs('2026-01-02T00:00:00Z') }),
      ],
    });
    const { setRemoteApply } = await renderPanel();
    await waitFor(() => expect(screen.getByTestId('card-r1')).toBeInTheDocument());
    expect(screen.getByTestId('card-r1')).toHaveAttribute('data-remote-busy', 'none');

    setRemoteApply(remoteState({ running: { jobId: 'j1', requestId: 'r1' } }));
    expect(screen.getByTestId('card-r1')).toHaveAttribute('data-remote-busy', 'this-tab');
    expect(screen.getByTestId('card-r2')).toHaveAttribute('data-remote-busy', 'none');
  });

  // ---- Jobs this tab is not running -----------------------------------
  //
  // `running` is this tab's own claim and nothing else. Everything the
  // manager's other tabs and the mailbox itself are holding arrives as
  // `busyRequestIds`, and gating on `running` alone left the desktop
  // button fully live for a job queued behind another tab's, one this
  // tab cannot serve at all, and one a sibling tab is mid-run on.

  it('flags a card whose job is in the mailbox or in a sibling tab', async () => {
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [
        req({ request_id: 'r1', requested_at: wireTs('2026-01-01T00:00:00Z') }),
        req({ request_id: 'r2', requested_at: wireTs('2026-01-02T00:00:00Z') }),
      ],
    });
    const { setRemoteApply } = await renderPanel();
    await waitFor(() => expect(screen.getByTestId('card-r1')).toBeInTheDocument());

    // No `running` — this tab isn't the one on it. That covers the whole
    // pickup window and any sibling tab's run after it.
    setRemoteApply(remoteState({ busyRequestIds: ['r1'] }));
    expect(screen.getByTestId('card-r1')).toHaveAttribute('data-remote-busy', 'elsewhere');
    expect(screen.getByTestId('card-r2')).toHaveAttribute('data-remote-busy', 'none');
  });

  it('keeps the gate closed across the elsewhere → this-tab handover', async () => {
    // The two states overlap by design: the loop drops a job from the
    // busy set as it claims it and `running` picks it up in the same
    // breath. Neither transition may leave a frame with the button live.
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [req({ request_id: 'r1', requested_at: wireTs('2026-01-01T00:00:00Z') })],
    });
    const { setRemoteApply } = await renderPanel();
    await waitFor(() => expect(screen.getByTestId('card-r1')).toBeInTheDocument());

    setRemoteApply(remoteState({ busyRequestIds: ['r1'] }));
    expect(screen.getByTestId('card-r1')).toHaveAttribute('data-remote-busy', 'elsewhere');

    setRemoteApply(
      remoteState({ busyRequestIds: ['r1'], running: { jobId: 'j1', requestId: 'r1' } }),
    );
    expect(screen.getByTestId('card-r1')).toHaveAttribute('data-remote-busy', 'this-tab');

    setRemoteApply(remoteState({ running: { jobId: 'j1', requestId: 'r1' } }));
    expect(screen.getByTestId('card-r1')).toHaveAttribute('data-remote-busy', 'this-tab');
  });

  it('gives the button back once no job anywhere holds the request', async () => {
    // A job that terminates between polls must not leave the card gated
    // on the last poll's snapshot: a failed run leaves the request
    // pending, and the manager's next move is the desktop button.
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [req({ request_id: 'r1', requested_at: wireTs('2026-01-01T00:00:00Z') })],
    });
    const { setRemoteApply } = await renderPanel();
    await waitFor(() => expect(screen.getByTestId('card-r1')).toBeInTheDocument());

    setRemoteApply(remoteState({ running: { jobId: 'j1', requestId: 'r1' } }));
    expect(screen.getByTestId('card-r1')).toHaveAttribute('data-remote-busy', 'this-tab');

    setRemoteApply(remoteState({ finishedCount: 1 }));
    expect(screen.getByTestId('card-r1')).toHaveAttribute('data-remote-busy', 'none');
  });

  // The post-job refetch itself is TabbedShell's — it has to fire with
  // this component unmounted. See TabbedShell.test.tsx. What QueuePanel
  // owes is the negative: a finished job must not trigger a second fetch
  // from here as well, or every phone-initiated completion costs two
  // reads and the two refetches race to set the list.
  it('does not refetch on its own when a phone-initiated job finishes', async () => {
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    const { setRemoteApply } = await renderPanel();
    await waitFor(() => expect(getMyPendingRequestsMock).toHaveBeenCalledTimes(1));

    setRemoteApply(remoteState({ finishedCount: 1 }));
    await waitFor(() =>
      expect(screen.queryByTestId('sba-remote-apply-running')).not.toBeInTheDocument(),
    );
    expect(getMyPendingRequestsMock).toHaveBeenCalledTimes(1);
  });
});
