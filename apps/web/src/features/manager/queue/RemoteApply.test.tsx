// Component tests for the phone-facing remote-apply surface. The hooks
// are mocked; what's under test is what the manager actually reads on a
// phone — the header sentence, the button's presence/absence per card,
// and the wording of every job status.
//
// Two clusters carry the weight of the per-site model:
//   - the header copy at zero / one / several live tabs, since naming
//     one site while two are covered is a lie about the other;
//   - the not-covered card, which has to name the site the request
//     needs. The old model could only say "your desktop is offline",
//     which was wrong the moment a second Kindoo site existed.
//
// The `partial` case gets its own assertions on purpose: it means the
// Kindoo write landed and only the SBA bookkeeping didn't. Wording that
// reads as "failed" would send a manager to redo a provision that has
// already consumed a licence.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  OverCapEntry,
  RemoteApplyDesktopWithId,
  RemoteApplyJobStatus,
  RemoteApplyOutcome,
  TimestampLike,
} from '@kindoo/shared';

const queueMutateMock = vi.fn();
const useQueueRemoteApplyJobMock = vi.fn();
const pickupTimeoutMock = vi.fn();

vi.mock('./hooks', async () => {
  const actual = await vi.importActual<typeof import('./hooks')>('./hooks');
  return {
    // `toMillis` is the real one: the selection's ordering is built on
    // it, and a stub would make the ordering tests prove nothing.
    toMillis: actual.toMillis,
    useQueueRemoteApplyJob: () => useQueueRemoteApplyJobMock(),
    useRemoteApplyPickupTimeout: (...args: unknown[]) => pickupTimeoutMock(...args),
  };
});

// The result dialog only raises for a job THIS device queued, matched on
// `created_by_device`. Pin the id so the fixture jobs below read as ours.
vi.mock('../../notifications/lib', () => ({ getDeviceId: () => 'device-1' }));

import {
  RemoteApplyPresenceNote,
  RemoteApplyResults,
  RemoteApplyRow,
  overCapLine,
  pickUnacknowledgedOutcome,
  presenceCopy,
} from './RemoteApply';
import { acknowledgeJob, clearAcknowledgedJobs } from './acknowledgedJobs';
import type { RemoteApplyJobWithId, RemoteApplyPresenceResult } from './hooks';

function desktop(siteKey: string, siteName: string | null = null): RemoteApplyDesktopWithId {
  return {
    site_key: siteKey,
    stake_id: 'csnorth',
    kindoo_site_id: siteKey === 'home' ? null : siteKey,
    last_seen_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(0), toMillis: () => 0 },
    kindoo_eid: 4242,
    kindoo_site_name: siteName,
    ext_version: '2.5.0',
    lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
  };
}

function presence(
  state: RemoteApplyPresenceResult['state'],
  desktops: RemoteApplyDesktopWithId[] = [],
): RemoteApplyPresenceResult {
  return {
    state,
    desktops,
    desktopForSite: (key) => desktops.find((d) => d.site_key === key) ?? null,
    presence: undefined,
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

function job(status: RemoteApplyJobStatus, outcome?: RemoteApplyOutcome): RemoteApplyJobWithId {
  return {
    job_id: 'job-1',
    request_id: 'req-1',
    stake_id: 'csnorth',
    target_site_key: 'home',
    status,
    created_at: ts(0),
    created_by_device: 'device-1',
    lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
    ...(outcome ? { outcome } : {}),
  };
}

/** A card the manager's live tab can serve. */
function covered(overrides: Partial<React.ComponentProps<typeof RemoteApplyRow>> = {}) {
  return {
    requestId: 'req-1',
    targetSiteKey: 'home',
    desktop: desktop('home', 'Colorado Springs North'),
    anyDesktopLive: true,
    ...overrides,
  } as React.ComponentProps<typeof RemoteApplyRow>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Acknowledgements persist in localStorage on purpose; jsdom keeps it
  // across tests in a file, so a dismissal in one would silence the next.
  clearAcknowledgedJobs();
  useQueueRemoteApplyJobMock.mockReturnValue({
    mutate: queueMutateMock,
    isPending: false,
    isError: false,
  });
});

describe('queue header copy', () => {
  it('names the one Kindoo site the manager can apply for', () => {
    expect(presenceCopy('live', ['Colorado Springs North'])).toBe(
      'You can apply requests for Colorado Springs North from here.',
    );
  });

  it('names both sites when two Kindoo tabs are live, rather than picking one', () => {
    expect(presenceCopy('live', ['Colorado Springs North', 'East Stake'])).toBe(
      'You can apply requests for Colorado Springs North and East Stake from here.',
    );
  });

  it('lists three live sites without dropping any', () => {
    expect(presenceCopy('live', ['Alpine', 'Maple', 'Pine Ridge'])).toBe(
      'You can apply requests for Alpine, Maple and Pine Ridge from here.',
    );
  });

  it('still says apply is available when a live tab reported no site name', () => {
    expect(presenceCopy('live', [])).toMatch(/you can apply requests from here/i);
  });

  it('tells the manager to open Kindoo when no tab is live', () => {
    expect(presenceCopy('stale', [])).toBe(
      'Open Kindoo in Chrome on your computer to apply requests from here.',
    );
  });
});

describe('<RemoteApplyPresenceNote />', () => {
  it('names every Kindoo site covered by a live tab', () => {
    render(
      <RemoteApplyPresenceNote
        presence={presence('live', [desktop('home'), desktop('east')])}
        siteNames={['Colorado Springs North', 'East Stake']}
      />,
    );
    expect(screen.getByTestId('remote-apply-presence')).toHaveTextContent(
      'You can apply requests for Colorado Springs North and East Stake from here.',
    );
  });

  it('tells the manager to open Kindoo on their computer when no tab is live', () => {
    render(<RemoteApplyPresenceNote presence={presence('stale')} siteNames={[]} />);
    expect(screen.getByTestId('remote-apply-presence')).toHaveTextContent(
      /Open Kindoo in Chrome on your computer/i,
    );
  });

  it('points at the extension toggle when remote apply was never turned on', () => {
    render(<RemoteApplyPresenceNote presence={presence('off')} siteNames={[]} />);
    expect(screen.getByTestId('remote-apply-presence')).toHaveTextContent(
      /Allow requests from my phone/i,
    );
  });

  it('says the computer is in a different stake rather than blaming the connection', () => {
    render(<RemoteApplyPresenceNote presence={presence('other-stake')} siteNames={[]} />);
    const note = screen.getByTestId('remote-apply-presence');
    expect(note).toHaveTextContent(/different stake open in Kindoo/i);
    expect(note).not.toHaveTextContent(/Open Kindoo in Chrome/i);
  });

  it('shows nothing until presence resolves, so no advice flashes at a working desktop', () => {
    render(<RemoteApplyPresenceNote presence={presence('loading')} siteNames={[]} />);
    expect(screen.queryByTestId('remote-apply-presence')).toBeNull();
  });
});

describe('<RemoteApplyRow /> — per-site gating', () => {
  it('offers Apply when a live tab is on the site this request needs', () => {
    render(<RemoteApplyRow {...covered()} />);
    expect(screen.getByTestId('remote-apply-button-req-1')).toHaveTextContent(
      'Apply via extension',
    );
    expect(screen.queryByTestId('remote-apply-needs-site-req-1')).toBeNull();
  });

  it('withholds Apply and names the site to open when the live tab is on a different one', () => {
    // The failure the per-site model exists to prevent: the manager's
    // Kindoo tab is open on the wrong site, and the old copy told them
    // their desktop was offline.
    render(
      <RemoteApplyRow
        requestId="req-1"
        targetSiteKey="east"
        desktop={null}
        anyDesktopLive
        requestSiteName="East Stake"
      />,
    );
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
    expect(screen.getByTestId('remote-apply-needs-site-req-1')).toHaveTextContent(
      'Open East Stake in Kindoo on your computer to apply this one.',
    );
  });

  it('gates each card on its own site when two Kindoo tabs are live', () => {
    const live = [desktop('home', 'Colorado Springs North'), desktop('east', 'East Stake')];
    const resolved = presence('live', live);
    render(
      <>
        <RemoteApplyRow
          requestId="req-home"
          targetSiteKey="home"
          desktop={resolved.desktopForSite('home')}
          anyDesktopLive
          requestSiteName="Colorado Springs North"
        />
        <RemoteApplyRow
          requestId="req-east"
          targetSiteKey="east"
          desktop={resolved.desktopForSite('east')}
          anyDesktopLive
          requestSiteName="East Stake"
        />
        <RemoteApplyRow
          requestId="req-pine"
          targetSiteKey="pine"
          desktop={resolved.desktopForSite('pine')}
          anyDesktopLive
          requestSiteName="Pine Ridge"
        />
      </>,
    );
    expect(screen.getByTestId('remote-apply-button-req-home')).toBeInTheDocument();
    expect(screen.getByTestId('remote-apply-button-req-east')).toBeInTheDocument();
    expect(screen.queryByTestId('remote-apply-button-req-pine')).toBeNull();
    expect(screen.getByTestId('remote-apply-needs-site-req-pine')).toHaveTextContent(
      /Open Pine Ridge in Kindoo/i,
    );
  });

  it('renders nothing at all when no tab is live and no job is in flight', () => {
    // With nothing open, the header already says to open Kindoo —
    // repeating it under every card would be noise.
    const { container } = render(
      <RemoteApplyRow
        requestId="req-1"
        targetSiteKey="east"
        desktop={null}
        anyDesktopLive={false}
        requestSiteName="East Stake"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('offers nothing until the catalogues the target site is derived from have landed', () => {
    // An empty wards catalogue derives every request to home, which
    // would offer a home button for a foreign-site request during the
    // first paint — and queue a job the desktop then refuses.
    const { container } = render(
      <RemoteApplyRow requestId="req-1" targetSiteKey={null} desktop={null} anyDesktopLive />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to generic wording when the site the request needs has no name', () => {
    render(
      <RemoteApplyRow requestId="req-1" targetSiteKey="ghost" desktop={null} anyDesktopLive />,
    );
    expect(screen.getByTestId('remote-apply-needs-site-req-1')).toHaveTextContent(
      /Open this request's Kindoo site in Chrome/i,
    );
  });
});

describe('<RemoteApplyRow />', () => {
  it('queues a job carrying the site the request must be applied on', async () => {
    const user = userEvent.setup();
    render(<RemoteApplyRow {...covered({ targetSiteKey: 'east' })} />);
    await user.click(screen.getByTestId('remote-apply-button-req-1'));
    expect(queueMutateMock).toHaveBeenCalledTimes(1);
    expect(queueMutateMock.mock.calls[0]?.[0]).toEqual({
      requestId: 'req-1',
      targetSiteKey: 'east',
    });
  });

  it('does not queue a second job for the same request after the first tap', async () => {
    // Phones double-tap for free, and two jobs would provision twice.
    const user = userEvent.setup();
    const { rerender } = render(<RemoteApplyRow {...covered()} />);
    await user.click(screen.getByTestId('remote-apply-button-req-1'));

    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
    // …and it stays gone once the job that tap wrote reaches the mailbox.
    rerender(<RemoteApplyRow {...covered({ job: job('queued') })} />);
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
    expect(queueMutateMock).toHaveBeenCalledTimes(1);
  });

  it('queues exactly one job when two taps land in the same task', () => {
    // The guard has to hold before React commits anything: `isPending`
    // and the job snapshot both arrive a microtask after `mutate`, so a
    // second tap in the same task reads the pre-tap render. The second
    // job it used to write became an orphan — claimed after the first
    // had already applied, refused as `request_not_pending`, and
    // reported to the manager as a failure on work that succeeded.
    render(<RemoteApplyRow {...covered()} />);
    const button = screen.getByTestId('remote-apply-button-req-1');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(queueMutateMock).toHaveBeenCalledTimes(1);
  });

  it('withholds Apply until the mailbox subscription has resolved', () => {
    // "No job for this request" isn't a fact yet — a job queued from the
    // manager's other device may be about to arrive.
    render(<RemoteApplyRow {...covered({ jobsLoading: true })} />);
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
  });

  it('offers Apply again after a failed job, and queues the retry', async () => {
    const user = userEvent.setup();
    render(
      <RemoteApplyRow
        {...covered({ job: job('failed', { code: 'error', message: 'Kindoo said no.' }) })}
      />,
    );
    await user.click(screen.getByTestId('remote-apply-button-req-1'));
    expect(queueMutateMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
  });

  it('does not offer Apply while a job for this request is already running', () => {
    render(<RemoteApplyRow {...covered({ job: job('running') })} />);
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
  });

  it('shows the job status even after the desktop drops offline mid-apply', () => {
    render(
      <RemoteApplyRow
        requestId="req-1"
        targetSiteKey="home"
        desktop={null}
        anyDesktopLive={false}
        job={job('running')}
      />,
    );
    expect(screen.getByTestId('remote-apply-status-req-1')).toBeInTheDocument();
  });

  it('says the job is waiting for the desktop while it sits queued', () => {
    render(<RemoteApplyRow {...covered({ job: job('queued') })} />);
    const status = screen.getByTestId('remote-apply-status-req-1');
    expect(status).toHaveAttribute('data-status', 'queued');
    expect(status).toHaveTextContent(/waiting for it to start/i);
  });

  it('says the desktop is working on it while the job runs', () => {
    render(<RemoteApplyRow {...covered({ job: job('running') })} />);
    expect(screen.getByTestId('remote-apply-status-req-1')).toHaveTextContent(
      /your desktop is applying this/i,
    );
  });

  it('confirms the apply landed, and stops offering the button', () => {
    render(<RemoteApplyRow {...covered({ job: job('applied') })} />);
    expect(screen.getByTestId('remote-apply-status-req-1')).toHaveTextContent('Applied ✓');
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
  });

  it('does not nag about opening another site once the request has been applied', () => {
    render(
      <RemoteApplyRow
        requestId="req-1"
        targetSiteKey="east"
        desktop={null}
        anyDesktopLive
        requestSiteName="East Stake"
        job={job('applied')}
      />,
    );
    expect(screen.queryByTestId('remote-apply-needs-site-req-1')).toBeNull();
  });

  it('tells the manager to finish on the desktop when the Kindoo write landed but SBA did not', () => {
    render(
      <RemoteApplyRow
        {...covered({
          job: job('partial', {
            code: 'sba_incomplete',
            message: 'Kindoo was updated, but marking the request complete failed.',
          }),
        })}
      />,
    );
    const status = screen.getByTestId('remote-apply-status-req-1');
    expect(status).toHaveAttribute('data-status', 'partial');
    expect(status).toHaveTextContent(/Applied in Kindoo, but this request is still open here/i);
    expect(status).toHaveTextContent(/marking the request complete failed/i);
    // Never offer a retry here — the seat already exists in Kindoo.
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
  });

  it("shows the desktop's own failure message, and offers another try", () => {
    render(
      <RemoteApplyRow
        {...covered({
          job: job('failed', {
            code: 'site_mismatch',
            message: 'Your desktop is on Site A; this request needs Site B.',
          }),
        })}
      />,
    );
    const status = screen.getByTestId('remote-apply-status-req-1');
    expect(status).toHaveAttribute('data-status', 'failed');
    expect(status).toHaveTextContent(/this request needs Site B/i);
    expect(screen.getByTestId('remote-apply-button-req-1')).toHaveTextContent('Try again');
  });

  it('does not claim the Kindoo write never happened when the desktop was stranded mid-run', () => {
    // The extension finalises a job whose tab died as `failed`, with a
    // message that refuses to say whether Kindoo took the write. The
    // headline has to leave that open too — a manager who reads only the
    // headline would go redo a provision that may already be done.
    render(
      <RemoteApplyRow
        {...covered({
          job: job('failed', {
            code: 'error',
            message:
              'Your desktop stopped partway through this request, so it never reported back. ' +
              'It may or may not have gone through in Kindoo — check this request on your ' +
              'desktop before applying again.',
          }),
        })}
      />,
    );
    const status = screen.getByTestId('remote-apply-status-req-1');
    expect(status).toHaveTextContent(/didn't finish this/i);
    expect(status).not.toHaveTextContent(/couldn't apply/i);
    expect(status).toHaveTextContent(/may or may not have gone through in Kindoo/i);
    // Retry stays available — `applyRequest` is lookup-first idempotent.
    expect(screen.getByTestId('remote-apply-button-req-1')).toHaveTextContent('Try again');
  });

  it('explains a job the desktop never picked up, and offers another try', () => {
    render(<RemoteApplyRow {...covered({ job: job('cancelled') })} />);
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
    render(<RemoteApplyRow {...covered()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't send this to your desktop/i);
  });

  it('shows the write in progress instead of a tappable button while it lands', () => {
    useQueueRemoteApplyJobMock.mockReturnValue({
      mutate: queueMutateMock,
      isPending: true,
      isError: false,
    });
    render(<RemoteApplyRow {...covered()} />);
    expect(screen.getByText(/Sending to your desktop/i)).toBeInTheDocument();
    expect(screen.queryByTestId('remote-apply-button-req-1')).toBeNull();
  });
});

// The acknowledgement half of the outcome. The desktop's own flow ends
// in a modal you have to dismiss; the phone showed only the inline row,
// so a manager who tapped Apply and pocketed the phone came back to a
// card that had quietly changed colour and no confirmation that anything
// had been read.
//
// This surface is mounted by the page, not by a card, and takes the
// mailbox rather than one card's job. `RemoteApplyResults.test.tsx`
// covers why (a card cannot outlive the apply that completes its
// request); what's asserted here is the wording and the mechanics.
describe('<RemoteApplyResults />', () => {
  const applied = (over_caps?: OverCapEntry[]) =>
    job('applied', {
      code: 'applied',
      message: 'Added Jane Doe to Maple Building.',
      provisioning_note: 'Added Jane Doe to Maple Building.',
      ...(over_caps ? { over_caps } : {}),
    });

  const label = (scope: string) => (scope === 'stake' ? 'Stake' : 'Cottonwood');

  it('raises a dialog when the desktop finishes a job this device queued', () => {
    const { rerender } = render(<RemoteApplyResults jobs={[job('running')]} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<RemoteApplyResults jobs={[applied()]} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('remote-apply-result-req-1')).toHaveAttribute(
      'data-status',
      'applied',
    );
    expect(screen.getByTestId('remote-apply-result-note-req-1')).toHaveTextContent(
      'Added Jane Doe to Maple Building.',
    );
  });

  it('raises for a job that had already finished before the page mounted', () => {
    // The flow this feature is actually for: tap Apply, turn to the
    // desktop to watch, phone locks. On wake the page has re-mounted and
    // the job is terminal on first sight. Requiring a witnessed
    // transition suppressed the dialog in exactly that case.
    render(<RemoteApplyResults jobs={[applied()]} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('remote-apply-result-note-req-1')).toHaveTextContent(
      'Added Jane Doe to Maple Building.',
    );
  });

  it('keys its test ids off the job, not off a card that may be gone', () => {
    // The dialog outlives the request's card by design, so everything it
    // renders has to come off the job doc it was handed.
    render(<RemoteApplyResults jobs={[{ ...applied(), request_id: 'req-elsewhere' }]} />);
    expect(screen.getByTestId('remote-apply-result-req-elsewhere')).toBeInTheDocument();
  });

  it('stays silent for a terminal job another device queued', () => {
    // The manager's other phone owns that outcome's screen.
    render(<RemoteApplyResults jobs={[{ ...applied(), created_by_device: 'some-other-phone' }]} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays silent for a job still in flight', () => {
    render(<RemoteApplyResults jobs={[job('queued'), job('running')]} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not raise again after a remount once the outcome was dismissed', async () => {
    // A locked phone guarantees the reload, so the acknowledgement has
    // to outlive the component — otherwise the dialog re-pops every time
    // the queue mounts.
    const user = userEvent.setup();
    const { unmount } = render(<RemoteApplyResults jobs={[applied()]} />);
    await user.click(screen.getByTestId('remote-apply-result-dismiss-req-1'));
    unmount();

    render(<RemoteApplyResults jobs={[applied()]} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still raises for a different job on the same request after one was dismissed', async () => {
    // A retry writes a new job; acknowledging the failure that prompted
    // it must not swallow the retry's own outcome.
    const user = userEvent.setup();
    const { unmount } = render(
      <RemoteApplyResults jobs={[job('failed', { code: 'error', message: 'Kindoo said no.' })]} />,
    );
    await user.click(screen.getByTestId('remote-apply-result-dismiss-req-1'));
    unmount();

    render(<RemoteApplyResults jobs={[{ ...applied(), job_id: 'job-2' }]} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not close on Escape — the point is that it gets acknowledged', () => {
    const { rerender } = render(<RemoteApplyResults jobs={[job('running')]} />);
    rerender(<RemoteApplyResults jobs={[applied()]} />);
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes once the manager taps Dismiss', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<RemoteApplyResults jobs={[job('running')]} />);
    rerender(<RemoteApplyResults jobs={[applied()]} />);
    await user.click(screen.getByTestId('remote-apply-result-dismiss-req-1'));
    expect(screen.queryByRole('dialog')).toBeNull();
    // …and stays closed while the same terminal job keeps arriving.
    rerender(<RemoteApplyResults jobs={[applied()]} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers Dismiss and nothing else — a retry here would misfire on every failure shape', async () => {
    // `partial`: the desktop's retry replays a captured
    // `MarkRequestCompleteInput` this surface does not hold. `failed`:
    // the shapes worth retrying leave the request pending, so its card
    // still carries Try again; the shapes that don't (`request_not_pending`,
    // a stranded tab) must not be retried at all.
    const user = userEvent.setup();
    render(
      <RemoteApplyResults
        jobs={[
          job('partial', {
            code: 'sba_incomplete',
            message: 'Applied in Kindoo, but SBA could not be marked complete.',
          }),
        ]}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(/Try again/i)).toBeNull();
    expect(screen.queryByText(/Mark Complete/i)).toBeNull();
    await user.click(screen.getByTestId('remote-apply-result-dismiss-req-1'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names every pool the completion pushed over cap', () => {
    // Dropped entirely on the remote path before the outcome carried
    // them — a manager applying from their phone never learned a cap
    // had been breached.
    const { rerender } = render(
      <RemoteApplyResults jobs={[job('running')]} labelForScope={label} />,
    );
    rerender(
      <RemoteApplyResults
        jobs={[
          applied([
            { pool: 'stake', count: 12, cap: 10, over_by: 2 },
            { pool: 'CO', count: 5, cap: 4, over_by: 1 },
          ]),
        ]}
        labelForScope={label}
      />,
    );
    const overcap = screen.getByTestId('remote-apply-result-overcap-req-1');
    expect(overcap).toHaveTextContent('Stake: 12 / 10 (over by 2)');
    expect(overcap).toHaveTextContent('Cottonwood: 5 / 4 (over by 1)');
  });

  it('shows no over-cap block when the outcome carries none', () => {
    const { rerender } = render(<RemoteApplyResults jobs={[job('running')]} />);
    rerender(<RemoteApplyResults jobs={[applied()]} />);
    expect(screen.queryByTestId('remote-apply-result-overcap-req-1')).toBeNull();
  });

  it('sends a partial outcome to the desktop instead of offering a retry that would misfire', () => {
    const { rerender } = render(<RemoteApplyResults jobs={[job('running')]} />);
    rerender(
      <RemoteApplyResults
        jobs={[
          job('partial', {
            code: 'sba_incomplete',
            message:
              'Applied in Kindoo, but Stake Building Access could not be marked complete: ' +
              'network error. Finish it on your desktop.',
            provisioning_note: 'Added Jane Doe to Maple Building.',
          }),
        ]}
      />,
    );
    const body = screen.getByTestId('remote-apply-result-req-1');
    expect(body).toHaveAttribute('data-status', 'partial');
    // Short title here, not the row's headline: the desktop-authored
    // detail below opens with the same clause, and stacked in one modal
    // the repetition reads as a stutter.
    expect(screen.getByRole('dialog')).toHaveTextContent('Kindoo done — still open here');
    expect(screen.getByTestId('remote-apply-result-note-req-1')).toHaveTextContent(
      'Added Jane Doe to Maple Building.',
    );
    expect(screen.getByTestId('remote-apply-result-detail-req-1')).toHaveTextContent(
      /Finish it on your desktop/i,
    );
  });

  it('raises the dialog on a failure too, wording it exactly as the row does', () => {
    const { rerender } = render(<RemoteApplyResults jobs={[job('running')]} />);
    rerender(
      <RemoteApplyResults
        jobs={[
          job('failed', {
            code: 'site_mismatch',
            message: 'Your desktop is on Site A; this request needs Site B.',
          }),
        ]}
      />,
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(/didn't finish this/i);
    expect(screen.getByTestId('remote-apply-result-detail-req-1')).toHaveTextContent(
      'Your desktop is on Site A; this request needs Site B.',
    );
  });
});

// The selection is the whole behaviour of the page-level dialog, so it
// is pinned directly rather than only through the rendered component.
describe('pickUnacknowledgedOutcome', () => {
  const terminal = (jobId: string, requestId: string, finishedAtMs: number) => ({
    ...job('applied', { code: 'applied', message: 'ok' }),
    job_id: jobId,
    request_id: requestId,
    finished_at: ts(finishedAtMs),
  });

  it('picks the outcome that finished first, so the newest cannot bury the rest', () => {
    const picked = pickUnacknowledgedOutcome(
      [terminal('job-late', 'req-b', 9_000), terminal('job-early', 'req-a', 3_000)],
      'device-1',
      new Set(),
    );
    expect(picked?.job_id).toBe('job-early');
  });

  it('moves on to the next outcome once the earlier one is dismissed', () => {
    const jobs = [terminal('job-late', 'req-b', 9_000), terminal('job-early', 'req-a', 3_000)];
    expect(pickUnacknowledgedOutcome(jobs, 'device-1', new Set(['job-early']))?.job_id).toBe(
      'job-late',
    );
    expect(
      pickUnacknowledgedOutcome(jobs, 'device-1', new Set(['job-early', 'job-late'])),
    ).toBeUndefined();
  });

  it('falls back to created_at when the terminal write has not resolved yet', () => {
    // The phone's own `queued → cancelled` write: `finished_at` is an
    // unresolved `serverTimestamp()` in the snapshot that follows it.
    const cancelled = { ...job('cancelled'), job_id: 'job-cancelled', created_at: ts(1_000) };
    const picked = pickUnacknowledgedOutcome(
      [terminal('job-later', 'req-b', 5_000), cancelled],
      'device-1',
      new Set(),
    );
    expect(picked?.job_id).toBe('job-cancelled');
  });

  it('orders a job with no readable timestamps last — it was written a moment ago', () => {
    // Both fields unresolved `serverTimestamp()`s, which read locally as
    // a bare `{seconds, nanoseconds}` with no `toMillis`.
    const justNow = {
      ...job('applied', { code: 'applied', message: 'ok' }),
      job_id: 'job-now',
      created_at: { seconds: 0, nanoseconds: 0 } as unknown as TimestampLike,
    };
    const picked = pickUnacknowledgedOutcome(
      [justNow, terminal('job-older', 'req-b', 5_000)],
      'device-1',
      new Set(),
    );
    expect(picked?.job_id).toBe('job-older');
  });

  it('breaks a tie on job id rather than on snapshot arrival order', () => {
    // The mailbox query is unordered; the selection must not be.
    const a = terminal('job-a', 'req-a', 4_000);
    const b = terminal('job-b', 'req-b', 4_000);
    expect(pickUnacknowledgedOutcome([a, b], 'device-1', new Set())?.job_id).toBe('job-a');
    expect(pickUnacknowledgedOutcome([b, a], 'device-1', new Set())?.job_id).toBe('job-a');
  });

  it('skips jobs another device queued and jobs still in flight', () => {
    expect(
      pickUnacknowledgedOutcome(
        [
          { ...terminal('job-theirs', 'req-a', 1_000), created_by_device: 'other-phone' },
          job('running'),
        ],
        'device-1',
        new Set(),
      ),
    ).toBeUndefined();
  });

  it('raises nothing at all when this device has no readable id', () => {
    // Storage locked down: we cannot attribute anything, so we interrupt
    // for nothing rather than for everything.
    expect(
      pickUnacknowledgedOutcome([terminal('job-1', 'req-a', 1_000)], null, new Set()),
    ).toBeUndefined();
  });

  it('skips an outcome already acknowledged on this device', () => {
    acknowledgeJob('job-1');
    expect(
      pickUnacknowledgedOutcome([terminal('job-1', 'req-a', 1_000)], 'device-1', new Set()),
    ).toBeUndefined();
  });
});

describe('overCapLine', () => {
  it('names the pool the way the rest of the card does', () => {
    expect(
      overCapLine({ pool: 'CO', count: 5, cap: 4, over_by: 1 }, (s) =>
        s === 'CO' ? 'Cottonwood' : s,
      ),
    ).toBe('Cottonwood: 5 / 4 (over by 1)');
  });

  it('falls back to the stored pool value when no labeller is available', () => {
    expect(overCapLine({ pool: 'stake', count: 12, cap: 10, over_by: 2 })).toBe(
      'stake: 12 / 10 (over by 2)',
    );
  });
});
