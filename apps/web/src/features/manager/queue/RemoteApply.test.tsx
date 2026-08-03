// Component tests for the phone-facing remote-apply surface. The hooks
// are mocked; what's under test is what the manager actually reads on a
// phone — the presence sentence, the button's presence/absence, and the
// wording of every job status.
//
// The `partial` case gets its own assertions on purpose: it means the
// Kindoo write landed and only the SBA bookkeeping didn't. Wording that
// reads as "failed" would send a manager to redo a provision that has
// already consumed a licence.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RemoteApplyJob, RemoteApplyJobStatus, RemoteApplyOutcome } from '@kindoo/shared';

const queueMutateMock = vi.fn();
const useQueueRemoteApplyJobMock = vi.fn();
const useRemoteApplyJobMock = vi.fn();
const pickupTimeoutMock = vi.fn();

vi.mock('./hooks', () => ({
  useQueueRemoteApplyJob: () => useQueueRemoteApplyJobMock(),
  useRemoteApplyJob: (jobId: string | null) => useRemoteApplyJobMock(jobId),
  useRemoteApplyPickupTimeout: (...args: unknown[]) => pickupTimeoutMock(...args),
}));

import { RemoteApplyPresenceNote, RemoteApplyRow } from './RemoteApply';
import type { RemoteApplyPresenceResult } from './hooks';

function presence(
  state: RemoteApplyPresenceResult['state'],
  siteName: string | null = null,
): RemoteApplyPresenceResult {
  return { state, online: state === 'online', siteName, presence: undefined };
}

function job(status: RemoteApplyJobStatus, outcome?: RemoteApplyOutcome): RemoteApplyJob {
  return {
    request_id: 'req-1',
    stake_id: 'csnorth',
    status,
    created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(0), toMillis: () => 0 },
    created_by_device: 'device-1',
    lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
    ...(outcome ? { outcome } : {}),
  };
}

/** `useRemoteApplyJob` result for a card whose job doc has resolved. */
function jobResult(data: RemoteApplyJob | undefined) {
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

beforeEach(() => {
  vi.clearAllMocks();
  useQueueRemoteApplyJobMock.mockReturnValue({
    mutate: queueMutateMock,
    isPending: false,
    isError: false,
  });
  useRemoteApplyJobMock.mockReturnValue(jobResult(undefined));
});

describe('<RemoteApplyPresenceNote />', () => {
  it('names the Kindoo site the desktop is in when it is online', () => {
    render(<RemoteApplyPresenceNote presence={presence('online', 'Colorado Springs North')} />);
    expect(screen.getByTestId('remote-apply-presence')).toHaveTextContent(
      'Desktop online — Kindoo site: Colorado Springs North',
    );
  });

  it('tells the manager to open Kindoo on their computer when the desktop went quiet', () => {
    render(<RemoteApplyPresenceNote presence={presence('stale')} />);
    expect(screen.getByTestId('remote-apply-presence')).toHaveTextContent(
      /isn't online — open Kindoo in Chrome on your computer/i,
    );
  });

  it('points at the extension toggle when remote apply was never turned on', () => {
    render(<RemoteApplyPresenceNote presence={presence('off')} />);
    expect(screen.getByTestId('remote-apply-presence')).toHaveTextContent(
      /Allow requests from my phone/i,
    );
  });

  it('says the desktop is in a different stake rather than blaming the connection', () => {
    render(<RemoteApplyPresenceNote presence={presence('other-stake')} />);
    const note = screen.getByTestId('remote-apply-presence');
    expect(note).toHaveTextContent(/different stake open in Kindoo/i);
    expect(note).not.toHaveTextContent(/isn't online/i);
  });

  it('shows nothing until presence resolves, so no advice flashes at a working desktop', () => {
    render(<RemoteApplyPresenceNote presence={presence('loading')} />);
    expect(screen.queryByTestId('remote-apply-presence')).toBeNull();
  });
});

describe('<RemoteApplyRow />', () => {
  it('renders nothing at all when the desktop is offline and no job is in flight', () => {
    const { container } = render(<RemoteApplyRow requestId="req-1" online={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers Apply via extension when the desktop is online', () => {
    render(<RemoteApplyRow requestId="req-1" online />);
    expect(screen.getByTestId('remote-apply-button-req-1')).toHaveTextContent(
      'Apply via extension',
    );
  });

  it('queues a job for this request when the button is tapped', async () => {
    const user = userEvent.setup();
    render(<RemoteApplyRow requestId="req-1" online />);
    await user.click(screen.getByTestId('remote-apply-button-req-1'));
    expect(queueMutateMock).toHaveBeenCalledTimes(1);
    expect(queueMutateMock.mock.calls[0]?.[0]).toBe('req-1');
  });

  it('does not queue a second job for the same request after the first tap', async () => {
    // Phones double-tap for free, and two jobs would provision twice.
    queueMutateMock.mockImplementation(
      (_requestId: string, opts?: { onSuccess?: (id: string) => void }) => {
        opts?.onSuccess?.('job-1');
      },
    );
    useRemoteApplyJobMock.mockImplementation((jobId: string | null) =>
      jobResult(jobId ? job('queued') : undefined),
    );
    const user = userEvent.setup();
    render(<RemoteApplyRow requestId="req-1" online />);
    await user.click(screen.getByTestId('remote-apply-button-req-1'));

    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
    expect(queueMutateMock).toHaveBeenCalledTimes(1);
  });

  it('does not offer Apply while a job for this request is already running', () => {
    useRemoteApplyJobMock.mockReturnValue(jobResult(job('running')));
    render(<RemoteApplyRow requestId="req-1" online activeJobId="job-1" />);
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
  });

  it('shows the job status even after the desktop drops offline mid-apply', () => {
    useRemoteApplyJobMock.mockReturnValue(jobResult(job('running')));
    render(<RemoteApplyRow requestId="req-1" online={false} activeJobId="job-1" />);
    expect(screen.getByTestId('remote-apply-status-req-1')).toBeInTheDocument();
  });

  it('says the job is waiting for the desktop while it sits queued', () => {
    useRemoteApplyJobMock.mockReturnValue(jobResult(job('queued')));
    render(<RemoteApplyRow requestId="req-1" online activeJobId="job-1" />);
    const status = screen.getByTestId('remote-apply-status-req-1');
    expect(status).toHaveAttribute('data-status', 'queued');
    expect(status).toHaveTextContent(/waiting for it to start/i);
  });

  it('says the desktop is working on it while the job runs', () => {
    useRemoteApplyJobMock.mockReturnValue(jobResult(job('running')));
    render(<RemoteApplyRow requestId="req-1" online activeJobId="job-1" />);
    expect(screen.getByTestId('remote-apply-status-req-1')).toHaveTextContent(
      /your desktop is applying this/i,
    );
  });

  it('confirms the apply landed, and stops offering the button', () => {
    useRemoteApplyJobMock.mockReturnValue(jobResult(job('applied')));
    render(<RemoteApplyRow requestId="req-1" online activeJobId="job-1" />);
    expect(screen.getByTestId('remote-apply-status-req-1')).toHaveTextContent('Applied ✓');
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
  });

  it('tells the manager to finish on the desktop when the Kindoo write landed but SBA did not', () => {
    useRemoteApplyJobMock.mockReturnValue(
      jobResult(
        job('partial', {
          code: 'sba_incomplete',
          message: 'Kindoo was updated, but marking the request complete failed.',
        }),
      ),
    );
    render(<RemoteApplyRow requestId="req-1" online activeJobId="job-1" />);
    const status = screen.getByTestId('remote-apply-status-req-1');
    expect(status).toHaveAttribute('data-status', 'partial');
    expect(status).toHaveTextContent(/Applied in Kindoo, but this request is still open here/i);
    expect(status).toHaveTextContent(/marking the request complete failed/i);
    // Never offer a retry here — the seat already exists in Kindoo.
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
  });

  it("shows the desktop's own failure message, and offers another try", () => {
    useRemoteApplyJobMock.mockReturnValue(
      jobResult(
        job('failed', {
          code: 'site_mismatch',
          message: 'Your desktop is on Site A; this request needs Site B.',
        }),
      ),
    );
    render(<RemoteApplyRow requestId="req-1" online activeJobId="job-1" />);
    const status = screen.getByTestId('remote-apply-status-req-1');
    expect(status).toHaveAttribute('data-status', 'failed');
    expect(status).toHaveTextContent(/this request needs Site B/i);
    expect(screen.getByTestId('remote-apply-button-req-1')).toHaveTextContent('Try again');
  });

  it('explains a job the desktop never picked up, and offers another try', () => {
    useRemoteApplyJobMock.mockReturnValue(jobResult(job('cancelled')));
    render(<RemoteApplyRow requestId="req-1" online activeJobId="job-1" />);
    const status = screen.getByTestId('remote-apply-status-req-1');
    expect(status).toHaveAttribute('data-status', 'cancelled');
    expect(status).toHaveTextContent(/didn't pick this up/i);
    expect(screen.getByTestId('remote-apply-button-req-1')).toBeInTheDocument();
  });

  it('reports a job that could not be created at all', () => {
    useQueueRemoteApplyJobMock.mockReturnValue({
      mutate: queueMutateMock,
      isPending: false,
      isError: true,
    });
    render(<RemoteApplyRow requestId="req-1" online />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't send this to your desktop/i);
  });

  it('shows the write in progress instead of a tappable button while it lands', () => {
    useQueueRemoteApplyJobMock.mockReturnValue({
      mutate: queueMutateMock,
      isPending: true,
      isError: false,
    });
    render(<RemoteApplyRow requestId="req-1" online />);
    expect(screen.getByText(/Sending to your desktop/i)).toBeInTheDocument();
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
  });
});
