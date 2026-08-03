// Remote apply — the phone-facing half of D27.
//
// The manager's desktop extension publishes presence; this surface
// turns that into (a) one plain-language line at the top of the queue
// saying whether the desktop can act, and (b) an **Apply via extension**
// button on each pending card while it can. Tapping writes a job doc;
// the desktop claims it, runs the same provisioning code path as its own
// button, and writes the outcome back, which the row renders live.
//
// Everything here is written for a phone first — a manager at the
// building on their phone is the entire reason the feature exists.
//
// Deliberately absent: any site-mismatch check. `checkRequestSite` runs
// on the desktop, which is the only place that knows which Kindoo site
// is actually open, and its message names both sites. We display it.

import { useEffect, useRef, useState } from 'react';
import { isRemoteApplyTerminal, type RemoteApplyJob } from '@kindoo/shared';
import { Button } from '../../../components/ui/Button';
import {
  useQueueRemoteApplyJob,
  useRemoteApplyPickupTimeout,
  type RemoteApplyJobWithId,
  type RemoteApplyPresenceResult,
} from './hooks';

/**
 * One line under the queue header: can the manager's own desktop act
 * right now, and if not, what should they go do about it. Renders
 * nothing until presence resolves so the page doesn't flash advice at
 * someone whose desktop is fine.
 */
export function RemoteApplyPresenceNote({ presence }: { presence: RemoteApplyPresenceResult }) {
  if (presence.state === 'loading') return null;
  return (
    <p
      className="kd-remote-apply-presence"
      data-testid="remote-apply-presence"
      data-state={presence.state}
      role="status"
    >
      <span className="kd-remote-apply-dot" aria-hidden="true" />
      {presenceCopy(presence)}
    </p>
  );
}

function presenceCopy(presence: RemoteApplyPresenceResult): string {
  switch (presence.state) {
    case 'online':
      return presence.siteName
        ? `Desktop online — Kindoo site: ${presence.siteName}`
        : 'Desktop online';
    case 'stale':
      return "Your desktop extension isn't online — open Kindoo in Chrome on your computer.";
    case 'other-stake':
      return 'Your desktop has a different stake open in Kindoo. Switch it to this stake to apply from your phone.';
    case 'off':
    case 'loading':
      return 'Turn on “Allow requests from my phone” in the extension on your desktop.';
  }
}

export interface RemoteApplyRowProps {
  requestId: string;
  /** Desktop is opted in, fresh, and in this stake. */
  online: boolean;
  /**
   * The job this request's card speaks for, resolved by
   * `pickRemoteApplyJob` from every job in the mailbox — from a reload
   * mid-apply, from a tap on the manager's other device, or from the tap
   * just made here.
   */
  job?: RemoteApplyJobWithId | undefined;
  /**
   * The jobs subscription hasn't resolved. Withholds the button: an
   * absent job isn't yet a fact, and offering Apply against an unknown
   * mailbox is how a request ends up with two jobs.
   */
  jobsLoading?: boolean | undefined;
}

/**
 * The per-card action + live job status. Renders nothing when the
 * desktop is unusable and there's no job to report, so a card looks
 * exactly as it did before this feature when remote apply is off.
 */
export function RemoteApplyRow({
  requestId,
  online,
  job,
  jobsLoading = false,
}: RemoteApplyRowProps) {
  // Local clock reading of the tap. `created_at` is an unresolved
  // `serverTimestamp()` in the first local snapshot, so the pickup
  // timeout needs something to count from until the server ack lands.
  const [queuedAtMs, setQueuedAtMs] = useState<number | null>(null);
  // The tap latch, held twice on purpose. The ref is the half that
  // works: it flips *before* `mutate` is called, so a second tap
  // arriving in the same task — a phone's synthesised click after a
  // touch, a double-tap — returns early instead of reading the pre-tap
  // render's state and queueing a second job. `queue.isPending` and the
  // job snapshot both land a microtask later and can't guard that
  // window. The state mirrors it so the row renders the same fact.
  const createStartedRef = useRef(false);
  const [createStarted, setCreateStarted] = useState(false);
  const queue = useQueueRemoteApplyJob();

  // Once a job for this request is visible, it owns the guard and the
  // latch stands down — including for a legitimate retry, where the
  // failed job is displaced by the new one.
  useEffect(() => {
    if (!job) return;
    createStartedRef.current = false;
    setCreateStarted(false);
  }, [job]);

  useRemoteApplyPickupTimeout(job?.job_id ?? null, job, queuedAtMs);

  const status = job?.status;
  const hasJob = job !== undefined;
  // Any non-terminal job blocks a second tap — this is the duplicate
  // guard. Two jobs for one request would provision twice in Kindoo,
  // and phones generate double-taps for free.
  const inFlight =
    queue.isPending || createStarted || (status !== undefined && !isRemoteApplyTerminal(status));

  const apply = () => {
    if (inFlight || createStartedRef.current) return;
    createStartedRef.current = true;
    setCreateStarted(true);
    const tappedAt = Date.now();
    queue.mutate(requestId, {
      onSuccess: () => {
        setQueuedAtMs(tappedAt);
      },
      onError: () => {
        // Nothing was written, so nothing is in flight — let them retry.
        createStartedRef.current = false;
        setCreateStarted(false);
      },
    });
  };

  const showButton = online && !inFlight && !jobsLoading && !isSettled(status);
  if (!showButton && !hasJob && !inFlight && !queue.isError) return null;

  return (
    <div className="kd-remote-apply" data-testid={`remote-apply-${requestId}`}>
      {hasJob ? <JobStatus job={job} requestId={requestId} /> : null}
      {!hasJob && inFlight ? (
        <div className="kd-remote-apply-state is-progress" role="status">
          <span className="kd-remote-apply-state-headline">Sending to your desktop…</span>
        </div>
      ) : null}
      {queue.isError ? (
        <div className="kd-remote-apply-state is-error" role="alert">
          Couldn&apos;t send this to your desktop. Try again.
        </div>
      ) : null}
      {showButton ? (
        <Button
          variant="secondary"
          className="kd-remote-apply-button"
          data-testid={`remote-apply-button-${requestId}`}
          onClick={apply}
        >
          {isRetryable(status) ? 'Try again' : 'Apply via extension'}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * States where the work is done (or done enough that re-running would
 * double-provision), so the button stays away. `failed` and `cancelled`
 * are NOT settled — those get the retry button back.
 */
function isSettled(status: RemoteApplyJob['status'] | undefined): boolean {
  return status === 'applied' || status === 'partial';
}

/** Terminal failures worth another go from the phone. */
function isRetryable(status: RemoteApplyJob['status'] | undefined): boolean {
  return status === 'failed' || status === 'cancelled';
}

function JobStatus({ job, requestId }: { job: RemoteApplyJob | undefined; requestId: string }) {
  if (!job) return null;
  const view = statusView(job);
  return (
    <div
      className={`kd-remote-apply-state is-${view.tone}`}
      data-testid={`remote-apply-status-${requestId}`}
      data-status={job.status}
      role={view.tone === 'error' ? 'alert' : 'status'}
    >
      <span className="kd-remote-apply-state-headline">{view.headline}</span>
      {view.detail ? <span className="kd-remote-apply-state-detail">{view.detail}</span> : null}
    </div>
  );
}

interface StatusView {
  tone: 'progress' | 'success' | 'warn' | 'error';
  headline: string;
  detail?: string | undefined;
}

function statusView(job: RemoteApplyJob): StatusView {
  const message = job.outcome?.message;
  switch (job.status) {
    case 'queued':
      return { tone: 'progress', headline: 'Sent to your desktop — waiting for it to start…' };
    case 'running':
      // Short enough to hold one line at 390px — the long form wrapped
      // right at the card edge and read as truncated.
      return { tone: 'progress', headline: 'Your desktop is applying this…' };
    case 'applied':
      return { tone: 'success', headline: 'Applied ✓' };
    case 'partial':
      // Kindoo took the change; SBA didn't get marked complete. Saying
      // "failed" here would send the manager to redo a provision that
      // already happened — the one wording mistake that costs a licence.
      return {
        tone: 'warn',
        headline: 'Applied in Kindoo, but this request is still open here.',
        detail: message ?? 'Finish it on your desktop to close it out.',
      };
    case 'failed':
      // Deliberately NOT "couldn't apply this". A job whose tab died
      // mid-run is finalised `failed` too, and the desktop's message for
      // that case explicitly refuses to say whether Kindoo took the
      // write. A headline that asserts it didn't would contradict the
      // line under it, and a manager reading only the headline would go
      // redo a provision that may already have consumed a licence — the
      // same mistake `partial` is worded around. "Didn't finish" is true
      // of every `failed` job without claiming anything about Kindoo;
      // the detail carries the specifics.
      return {
        tone: 'error',
        headline: "Your desktop didn't finish this.",
        detail: message,
      };
    case 'cancelled':
      return {
        tone: 'warn',
        headline: "Your desktop didn't pick this up.",
        detail: 'Open Kindoo in Chrome on your computer, then try again.',
      };
  }
}
