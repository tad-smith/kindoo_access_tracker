// The result dialog's lifetime, tested through the whole page.
//
// This file exists because the dialog was, for two releases, mounted
// inside the pending request's own card — a component whose lifetime
// ends precisely when the event the dialog announces occurs. A
// successful remote apply ends in `markRequestComplete`, the request
// stops being `pending`, the card unmounts, and the dialog goes with
// it. On a phone that reads as a flash: two snapshots landing in order,
// the terminal job first (dialog paints) and the request-status change
// a beat later (card gone).
//
// The per-card tests could not see it. They transitioned the job and
// left the request in the list, which is the one sequence the bug does
// not occur in. So the assertions here always change BOTH facts in a
// single update, and several of them leave no cards on the page at all.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AccessRequest,
  RemoteApplyJobStatus,
  RemoteApplyOutcome,
  TimestampLike,
} from '@kindoo/shared';
import { makeRequest } from '../../../../test/fixtures';

const usePendingMock = vi.fn();
const useRemoteApplyJobsMock = vi.fn();

vi.mock('./hooks', async () => {
  const actual = await vi.importActual<typeof import('./hooks')>('./hooks');
  return {
    // The two reductions under test are the real ones — `byRequest` is
    // what the page selects an outcome across, and it must keep a job
    // whose request has left the queue.
    pickRemoteApplyJob: actual.pickRemoteApplyJob,
    toMillis: actual.toMillis,
    usePendingRequests: () => usePendingMock(),
    useRemoteApplyJobsByRequest: () => useRemoteApplyJobsMock(),
    useRemoteApplyPresence: () => ({
      state: 'off' as const,
      desktops: [],
      desktopForSite: () => null,
      presence: undefined,
    }),
    useKindooSites: () => ({ data: [], isLoading: false }),
    useQueueWards: () => ({ data: [], isLoading: false }),
    useQueueBuildings: () => ({ data: [], isLoading: false }),
    useQueueStakeDoc: () => ({ data: undefined, isLoading: false }),
    useQueueRemoteApplyJob: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
    useRemoteApplyPickupTimeout: () => {},
  };
});

// Attribution is by device: the dialog is this phone's acknowledgement,
// not a broadcast. Pin the id so the fixtures read as ours.
vi.mock('../../notifications/lib', () => ({ getDeviceId: () => 'device-1' }));

vi.mock('../../requests/hooks', () => ({
  useSeatForMember: () => docResult(undefined),
  useAccessForMember: () => docResult(undefined),
  useKindooManagerForMember: () => docResult(undefined),
}));

vi.mock('../../../lib/scopeLabel', () => ({
  useScopeLabel: () => (scope: string) => (scope === 'stake' ? 'Stake' : scope),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn().mockResolvedValue(undefined),
}));

import { ManagerQueuePage } from './QueuePage';
import { clearAcknowledgedJobs } from './acknowledgedJobs';
import { pickRemoteApplyJob, type RemoteApplyJobWithId } from './hooks';

function docResult<T>(data: T | undefined) {
  return {
    data,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

function listResult<T>(data: T[] | undefined, isLoading = false) {
  return {
    data,
    error: null,
    status: isLoading ? 'pending' : 'success',
    isPending: isLoading,
    isLoading,
    isSuccess: !isLoading,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

function ts(ms: number): TimestampLike {
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: 0,
    toDate: () => new Date(ms),
    toMillis: () => ms,
  };
}

interface JobSpec {
  jobId?: string;
  requestId?: string;
  status: RemoteApplyJobStatus;
  outcome?: RemoteApplyOutcome;
  createdAtMs?: number;
  finishedAtMs?: number;
  device?: string;
}

function job(spec: JobSpec): RemoteApplyJobWithId {
  return {
    job_id: spec.jobId ?? 'job-1',
    request_id: spec.requestId ?? 'req-1',
    stake_id: 'csnorth',
    target_site_key: 'home',
    status: spec.status,
    created_at: ts(spec.createdAtMs ?? 1_000),
    created_by_device: spec.device ?? 'device-1',
    lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
    ...(spec.outcome ? { outcome: spec.outcome } : {}),
    ...(spec.finishedAtMs !== undefined ? { finished_at: ts(spec.finishedAtMs) } : {}),
  };
}

const appliedOutcome: RemoteApplyOutcome = {
  code: 'applied',
  message: 'Added Jane Doe to Maple Building.',
  provisioning_note: 'Added Jane Doe to Maple Building.',
};

/** The mailbox, reduced exactly as `useRemoteApplyJobsByRequest` reduces it. */
function mailbox(jobs: RemoteApplyJobWithId[], isLoading = false) {
  const grouped = new Map<string, RemoteApplyJobWithId[]>();
  for (const j of jobs) {
    const forRequest = grouped.get(j.request_id);
    if (forRequest) forRequest.push(j);
    else grouped.set(j.request_id, [j]);
  }
  const byRequest = new Map<string, RemoteApplyJobWithId>();
  for (const [requestId, forRequest] of grouped) {
    const best = pickRemoteApplyJob(forRequest);
    if (best) byRequest.set(requestId, best);
  }
  return { byRequest, resolved: [...byRequest.values()], isLoading };
}

function pendingRequest(requestId: string): AccessRequest {
  return makeRequest({ request_id: requestId, type: 'add_manual', scope: 'stake' });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Acknowledgements are persisted on purpose; jsdom keeps localStorage
  // across tests in a file, so a dismissal in one would silence the next.
  clearAcknowledgedJobs();
  usePendingMock.mockReturnValue(listResult([pendingRequest('req-1')]));
  useRemoteApplyJobsMock.mockReturnValue(mailbox([]));
});

describe('remote apply result dialog — lifetime', () => {
  it('stays up when the applied request leaves the pending queue in the same update', () => {
    // The bug, exactly. One update carries both snapshots' effects: the
    // job goes terminal AND the request stops being pending, because
    // `markRequestComplete` is what ends a successful apply.
    usePendingMock.mockReturnValue(listResult([pendingRequest('req-1')]));
    useRemoteApplyJobsMock.mockReturnValue(mailbox([job({ status: 'running' })]));
    const { rerender } = render(<ManagerQueuePage />);
    expect(screen.queryByRole('dialog')).toBeNull();

    usePendingMock.mockReturnValue(listResult([] as AccessRequest[]));
    useRemoteApplyJobsMock.mockReturnValue(
      mailbox([job({ status: 'applied', outcome: appliedOutcome, finishedAtMs: 2_000 })]),
    );
    rerender(<ManagerQueuePage />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('remote-apply-result-req-1')).toHaveAttribute(
      'data-status',
      'applied',
    );
    expect(screen.getByTestId('remote-apply-result-note-req-1')).toHaveTextContent(
      'Added Jane Doe to Maple Building.',
    );
  });

  it('raises with an empty queue behind it — the apply cleared the last request', () => {
    // The state the manager actually lands in when they apply the only
    // thing in the queue. No card exists to have hosted the dialog.
    usePendingMock.mockReturnValue(listResult([] as AccessRequest[]));
    useRemoteApplyJobsMock.mockReturnValue(
      mailbox([job({ status: 'applied', outcome: appliedOutcome, finishedAtMs: 2_000 })]),
    );
    render(<ManagerQueuePage />);

    expect(screen.getByText(/no pending requests/i)).toBeInTheDocument();
    expect(screen.queryByTestId('queue-cards')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('raises while the pending-requests subscription is still loading', () => {
    // A phone waking to a re-mounted page resolves the two subscriptions
    // in whatever order the network gives it. The outcome must not wait
    // on the request list it no longer has anything to do with.
    usePendingMock.mockReturnValue(listResult(undefined, true));
    useRemoteApplyJobsMock.mockReturnValue(
      mailbox([job({ status: 'applied', outcome: appliedOutcome, finishedAtMs: 2_000 })]),
    );
    render(<ManagerQueuePage />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('survives a request leaving the queue for every terminal status', () => {
    const cases: { status: RemoteApplyJobStatus; outcome?: RemoteApplyOutcome }[] = [
      { status: 'applied', outcome: appliedOutcome },
      {
        status: 'partial',
        outcome: { code: 'sba_incomplete', message: 'Finish it on your desktop.' },
      },
      { status: 'failed', outcome: { code: 'error', message: 'Kindoo said no.' } },
      { status: 'cancelled' },
    ];
    for (const [index, spec] of cases.entries()) {
      clearAcknowledgedJobs();
      usePendingMock.mockReturnValue(listResult([] as AccessRequest[]));
      useRemoteApplyJobsMock.mockReturnValue(
        mailbox([
          job({
            jobId: `job-${index}`,
            status: spec.status,
            ...(spec.outcome ? { outcome: spec.outcome } : {}),
            finishedAtMs: 2_000,
          }),
        ]),
      );
      const { unmount } = render(<ManagerQueuePage />);
      expect(screen.getByTestId('remote-apply-result-req-1')).toHaveAttribute(
        'data-status',
        spec.status,
      );
      unmount();
    }
  });

  it('stays silent for a terminal job another device queued, queue empty or not', () => {
    usePendingMock.mockReturnValue(listResult([] as AccessRequest[]));
    useRemoteApplyJobsMock.mockReturnValue(
      mailbox([job({ status: 'applied', outcome: appliedOutcome, device: 'some-other-phone' })]),
    );
    render(<ManagerQueuePage />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not re-raise a dismissed outcome after the page re-mounts', async () => {
    const user = userEvent.setup();
    usePendingMock.mockReturnValue(listResult([] as AccessRequest[]));
    useRemoteApplyJobsMock.mockReturnValue(
      mailbox([job({ status: 'applied', outcome: appliedOutcome, finishedAtMs: 2_000 })]),
    );
    const { unmount } = render(<ManagerQueuePage />);
    await user.click(screen.getByTestId('remote-apply-result-dismiss-req-1'));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    render(<ManagerQueuePage />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows outcomes one at a time, oldest first, when several land together', async () => {
    // Each outcome is its own acknowledgement — a failure must not be
    // buried under a success that finished after it. Completion order,
    // not recency, so the currently-open dialog can never be swapped out
    // from under a tap already travelling toward Dismiss.
    const user = userEvent.setup();
    usePendingMock.mockReturnValue(listResult([] as AccessRequest[]));
    useRemoteApplyJobsMock.mockReturnValue(
      mailbox([
        job({
          jobId: 'job-late',
          requestId: 'req-late',
          status: 'applied',
          outcome: appliedOutcome,
          finishedAtMs: 9_000,
        }),
        job({
          jobId: 'job-early',
          requestId: 'req-early',
          status: 'failed',
          outcome: { code: 'error', message: 'Kindoo said no.' },
          finishedAtMs: 3_000,
        }),
      ]),
    );
    render(<ManagerQueuePage />);

    expect(screen.getByTestId('remote-apply-result-req-early')).toBeInTheDocument();
    expect(screen.queryByTestId('remote-apply-result-req-late')).toBeNull();

    await user.click(screen.getByTestId('remote-apply-result-dismiss-req-early'));
    expect(screen.getByTestId('remote-apply-result-req-late')).toBeInTheDocument();

    await user.click(screen.getByTestId('remote-apply-result-dismiss-req-late'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not swap the open dialog when a newer outcome lands behind it', async () => {
    // A dialog replaced mid-read is a dialog dismissed unread: the tap
    // is already in flight when the content changes.
    const user = userEvent.setup();
    usePendingMock.mockReturnValue(listResult([] as AccessRequest[]));
    useRemoteApplyJobsMock.mockReturnValue(
      mailbox([
        job({
          jobId: 'job-early',
          requestId: 'req-early',
          status: 'failed',
          outcome: { code: 'error', message: 'Kindoo said no.' },
          finishedAtMs: 3_000,
        }),
      ]),
    );
    const { rerender } = render(<ManagerQueuePage />);
    expect(screen.getByTestId('remote-apply-result-req-early')).toBeInTheDocument();

    useRemoteApplyJobsMock.mockReturnValue(
      mailbox([
        job({
          jobId: 'job-early',
          requestId: 'req-early',
          status: 'failed',
          outcome: { code: 'error', message: 'Kindoo said no.' },
          finishedAtMs: 3_000,
        }),
        job({
          jobId: 'job-late',
          requestId: 'req-late',
          status: 'applied',
          outcome: appliedOutcome,
          finishedAtMs: 9_000,
        }),
      ]),
    );
    rerender(<ManagerQueuePage />);
    expect(screen.getByTestId('remote-apply-result-req-early')).toBeInTheDocument();

    await user.click(screen.getByTestId('remote-apply-result-dismiss-req-early'));
    expect(screen.getByTestId('remote-apply-result-req-late')).toBeInTheDocument();
  });

  it('keeps the inline card status for a request that is still pending', () => {
    // The per-card row is unchanged: it is the at-a-glance state, and it
    // vanishing with the card is correct.
    usePendingMock.mockReturnValue(listResult([pendingRequest('req-1')]));
    useRemoteApplyJobsMock.mockReturnValue(
      mailbox([
        job({
          status: 'partial',
          outcome: { code: 'sba_incomplete', message: 'Finish it on your desktop.' },
          finishedAtMs: 2_000,
        }),
      ]),
    );
    render(<ManagerQueuePage />);
    expect(screen.getByTestId('remote-apply-status-req-1')).toHaveAttribute(
      'data-status',
      'partial',
    );
    expect(screen.getByTestId('remote-apply-result-req-1')).toBeInTheDocument();
  });
});
