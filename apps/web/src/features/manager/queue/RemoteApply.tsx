// Remote apply — the phone-facing half of D27.
//
// The manager's desktop extension publishes one presence doc per Kindoo
// site it has a live tab on; this surface turns that into (a) one plain
// line at the top of the queue naming the sites that are covered, and
// (b) an **Apply via extension** button on each pending card whose site
// one of those tabs can actually serve. Tapping writes a job doc; the
// desktop claims it, runs the same provisioning code path as its own
// button, and writes the outcome back, which the row renders live.
//
// Everything here is written for a phone first — a manager at the
// building on their phone is the entire reason the feature exists.
//
// Coverage is per request, not per manager, because a Kindoo tab can
// only provision for the site it is inside. The card that can't be
// applied says which site to open rather than leaving a manager to
// discover it from a failed job — the old `site_mismatch` message told
// them to switch sites in Kindoo, advice that is actively wrong when
// they already have that site open in the next tab.

import { useEffect, useRef, useState } from 'react';
import {
  isRemoteApplyTerminal,
  type OverCapEntry,
  type RemoteApplyDesktopWithId,
  type RemoteApplyJob,
  type RemoteApplyJobStatus,
} from '@kindoo/shared';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import {
  useQueueRemoteApplyJob,
  useRemoteApplyPickupTimeout,
  type RemoteApplyJobWithId,
  type RemoteApplyPresenceResult,
} from './hooks';

/**
 * One line under the queue header: which Kindoo sites the manager can
 * apply for right now, or what to go do about it when the answer is
 * none. Renders nothing until presence resolves so the page doesn't
 * flash advice at someone whose desktop is fine.
 */
export function RemoteApplyPresenceNote({
  presence,
  siteNames,
}: {
  presence: RemoteApplyPresenceResult;
  /** Display names of the covered sites, in the order they should read. */
  siteNames: readonly string[];
}) {
  if (presence.state === 'loading') return null;
  return (
    <p
      className="kd-remote-apply-presence"
      data-testid="remote-apply-presence"
      data-state={presence.state}
      role="status"
    >
      <span className="kd-remote-apply-dot" aria-hidden="true" />
      {presenceCopy(presence.state, siteNames)}
    </p>
  );
}

/**
 * The queue-header sentence. Exported for direct unit tests — this copy
 * is the deliverable of the per-site change, and it has to read right
 * at zero, one, and several live tabs.
 */
export function presenceCopy(
  state: RemoteApplyPresenceResult['state'],
  siteNames: readonly string[],
): string {
  switch (state) {
    case 'live':
      // Naming every covered site is the point: with two tabs open,
      // naming one would read as a promise about the other.
      return siteNames.length > 0
        ? `You can apply requests for ${joinNames(siteNames)} from here.`
        : 'Kindoo is open on your computer — you can apply requests from here.';
    case 'stale':
      return 'Open Kindoo in Chrome on your computer to apply requests from here.';
    case 'other-stake':
      return 'Your computer has a different stake open in Kindoo. Switch it to this stake to apply requests from here.';
    case 'off':
    case 'loading':
      return 'Turn on “Allow requests from my phone” in the extension on your computer.';
  }
}

/**
 * `A`, `A and B`, `A, B and C`. Serial comma omitted deliberately — at
 * 390px the list is read at a glance, and the shorter form wraps less.
 */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface RemoteApplyRowProps {
  requestId: string;
  /**
   * The site key this request must be provisioned on, from
   * `remoteApplyTargetSiteKey`. `null` means the wards / buildings
   * catalogues haven't landed, so the derivation isn't trustworthy yet
   * — the row offers nothing rather than route a request to whichever
   * site an empty catalogue implies.
   */
  targetSiteKey: string | null;
  /**
   * The live tab that can run THIS request, or null when none can.
   * Resolved by `remoteApplyDesktopForRequest` against the request's own
   * site — a fresh tab on a different site cannot help here.
   */
  desktop: RemoteApplyDesktopWithId | null;
  /**
   * At least one tab is live in this stake. Gates the "open <site>"
   * line: with nothing live at all the header already says to open
   * Kindoo, and repeating that on every card is noise.
   */
  anyDesktopLive: boolean;
  /** Display name of the site this request needs, when it resolves. */
  requestSiteName?: string | null;
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
  /**
   * Scope → display label, for naming an over-cap pool in the result
   * dialog. Optional: without it the pool falls back to its stored
   * value (`'stake'` or a ward code), which is still readable.
   */
  labelForScope?: ((scope: string) => string) | undefined;
}

/**
 * The per-card action + live job status. Renders nothing when no tab can
 * serve this request and there's no job to report, so a card looks
 * exactly as it did before this feature when remote apply is off.
 */
export function RemoteApplyRow({
  requestId,
  targetSiteKey,
  desktop,
  anyDesktopLive,
  requestSiteName,
  job,
  jobsLoading = false,
  labelForScope,
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

  // The job whose outcome is still waiting to be acknowledged. Set only
  // on a terminal TRANSITION this device watched happen — never on
  // first sight of an already-terminal job, or every page load would
  // pop a modal for last week's work. A manager who taps Apply and
  // pockets the phone comes back to the dialog; one who reloads after
  // it finished gets the inline row, which is the correct
  // at-a-glance-only treatment for history.
  const [ackJobId, setAckJobId] = useState<string | null>(null);
  const lastSeenRef = useRef<{ jobId: string; status: RemoteApplyJobStatus } | null>(null);
  useEffect(() => {
    const prev = lastSeenRef.current;
    lastSeenRef.current = job ? { jobId: job.job_id, status: job.status } : null;
    if (!job || prev === null || prev.jobId !== job.job_id) return;
    if (prev.status === job.status) return;
    if (!isRemoteApplyTerminal(job.status)) return;
    setAckJobId(job.job_id);
  }, [job]);
  const ackJob = job && ackJobId === job.job_id ? job : undefined;

  const status = job?.status;
  const hasJob = job !== undefined;
  // Any non-terminal job blocks a second tap — this is the duplicate
  // guard. Two jobs for one request would provision twice in Kindoo,
  // and phones generate double-taps for free.
  const inFlight =
    queue.isPending || createStarted || (status !== undefined && !isRemoteApplyTerminal(status));

  const apply = () => {
    if (inFlight || createStartedRef.current || targetSiteKey === null) return;
    createStartedRef.current = true;
    setCreateStarted(true);
    const tappedAt = Date.now();
    queue.mutate(
      { requestId, targetSiteKey },
      {
        onSuccess: () => {
          setQueuedAtMs(tappedAt);
        },
        onError: () => {
          // Nothing was written, so nothing is in flight — let them retry.
          createStartedRef.current = false;
          setCreateStarted(false);
        },
      },
    );
  };

  const covered = desktop !== null;
  const showButton = covered && !inFlight && !jobsLoading && !isSettled(status);
  // The new not-covered state. Only worth saying while something IS
  // live — it is the difference between the sites they have open and
  // the one this request needs, and with nothing open there is no
  // difference to explain. Suppressed too when the target site didn't
  // resolve: there is no site to name and no claim we can honestly make
  // about whether a tab could serve it.
  const showNeedsSite =
    !covered && anyDesktopLive && targetSiteKey !== null && !inFlight && !isSettled(status);
  if (!showButton && !showNeedsSite && !hasJob && !inFlight && !queue.isError) return null;

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
      {showNeedsSite ? (
        <p
          className="kd-remote-apply-needs-site"
          data-testid={`remote-apply-needs-site-${requestId}`}
        >
          {needsSiteCopy(requestSiteName)}
        </p>
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
      {ackJob ? (
        <RemoteApplyResultDialog
          job={ackJob}
          requestId={requestId}
          labelForScope={labelForScope}
          onDismiss={() => setAckJobId(null)}
        />
      ) : null}
    </div>
  );
}

export interface RemoteApplyResultDialogProps {
  job: RemoteApplyJob;
  requestId: string;
  labelForScope?: ((scope: string) => string) | undefined;
  onDismiss: () => void;
}

/**
 * The acknowledgement for a finished remote apply, mirroring the
 * desktop's `ResultDialog`. The desktop ends every Provision & Complete
 * in a modal the manager has to dismiss; the phone showed only the
 * inline row, so a manager who pocketed their phone came back to a card
 * that had quietly changed colour. The row stays — it is the
 * at-a-glance state — and this is the acknowledgement.
 *
 * Not dismissable by Escape or a tap outside: the point is that it gets
 * clicked. Same as the desktop's, which offers only its buttons.
 *
 * The detail comes from {@link statusView}, the same function the
 * inline row renders from, so the two can't word an outcome
 * differently. What the dialog adds is what the row has no room for:
 * the desktop's provisioning note (what it actually did in Kindoo) and
 * the over-cap warning.
 *
 * **No retry button on `partial`.** The desktop's version has one, and
 * it is not an action this surface can reproduce. It replays the
 * captured `MarkRequestCompleteInput` — an SBA-only write, no Kindoo
 * call — and the job doc records only `provisioning_note` and
 * `kindoo_uid`, not that input; the completion note would have to be
 * guessed. The phone's own "Try again" is a different action again (a
 * fresh job, i.e. a full re-provision), which is why `partial` is
 * treated as settled and doesn't get it. The request is still
 * `pending`, so the desktop's own card can finish it with the tested
 * path — which is what the outcome message says to do.
 */
export function RemoteApplyResultDialog({
  job,
  requestId,
  labelForScope,
  onDismiss,
}: RemoteApplyResultDialogProps) {
  const view = statusView(job);
  // `applied` writes the same string to both fields; fall back so an
  // outcome from an extension that only set `message` still says what
  // the desktop did.
  const note =
    job.outcome?.provisioning_note ?? (job.status === 'applied' ? job.outcome?.message : undefined);
  // Only ever populated on `applied` (the `partial` path never landed
  // the SBA write, so the server had nothing to report) — rendered on
  // presence rather than on status so a missing field is simply a
  // dialog without the warning, which is what an older extension
  // writes.
  const overCaps = job.outcome?.over_caps ?? [];

  return (
    <Dialog
      open
      dismissable={false}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
      title={resultDialogTitle(job.status, view)}
    >
      <div
        className={`kd-remote-apply-result is-${view.tone}`}
        data-testid={`remote-apply-result-${requestId}`}
        data-status={job.status}
      >
        {note ? (
          <p
            className="kd-remote-apply-result-note"
            data-testid={`remote-apply-result-note-${requestId}`}
          >
            {note}
          </p>
        ) : null}
        {view.detail ? (
          <p
            className="kd-remote-apply-result-detail"
            data-testid={`remote-apply-result-detail-${requestId}`}
          >
            {view.detail}
          </p>
        ) : null}
        {overCaps.length > 0 ? (
          <div
            className="kd-remote-apply-result-overcap"
            data-testid={`remote-apply-result-overcap-${requestId}`}
          >
            <strong>Now over cap:</strong>
            <ul>
              {overCaps.map((entry) => (
                <li key={entry.pool}>{overCapLine(entry, labelForScope)}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <Dialog.Footer>
        <Dialog.CancelButton data-testid={`remote-apply-result-dismiss-${requestId}`}>
          Dismiss
        </Dialog.CancelButton>
      </Dialog.Footer>
    </Dialog>
  );
}

/**
 * The dialog's heading. It is the inline row's headline for every
 * status but `partial`, so the two surfaces can't say different things
 * about the same outcome.
 *
 * `partial` is the exception because its detail line — authored on the
 * desktop, deliberately, so both surfaces word failures identically —
 * opens with "Applied in Kindoo, but …", exactly as the row's headline
 * does. Stacked in one small modal the repetition reads as a stutter.
 * The short form here mirrors the desktop dialog's own title
 * ("Kindoo done — SBA still pending"), spelled without the acronym.
 */
export function resultDialogTitle(status: RemoteApplyJobStatus, view: StatusView): string {
  return status === 'partial' ? 'Kindoo done — still open here' : view.headline;
}

/**
 * One over-cap pool as a line. `pool` is `'stake'` or a ward_code; the
 * page's scope labeller turns both into what the rest of the card says
 * ("Stake", "Cottonwood"), so a manager doesn't have to translate a
 * ward code on a phone.
 */
export function overCapLine(
  entry: OverCapEntry,
  labelForScope?: ((scope: string) => string) | undefined,
): string {
  const pool = labelForScope ? labelForScope(entry.pool) : entry.pool;
  return `${pool}: ${entry.count} / ${entry.cap} (over by ${entry.over_by})`;
}

/**
 * What a card says when the manager's live tabs are on other sites.
 * Names the site so they can go open the right one — the whole reason
 * presence is keyed by site.
 */
export function needsSiteCopy(requestSiteName: string | null | undefined): string {
  return requestSiteName
    ? `Open ${requestSiteName} in Kindoo on your computer to apply this one.`
    : "Open this request's Kindoo site in Chrome on your computer to apply it.";
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

export interface StatusView {
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
