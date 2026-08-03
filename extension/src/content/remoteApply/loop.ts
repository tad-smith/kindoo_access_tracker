// The heartbeat + poll loop that makes remote apply work.
//
// Both halves ride one tick because both need the same precondition:
// a live, usable Kindoo session. Kindoo writes require the page's
// session token and the DOM-scraped active-site EID, so a desktop that
// can't read them can't act — and must not advertise that it can.
//
// That is the whole point of gating the heartbeat on
// `readKindooSession()`. Absence of a fresh heartbeat is how the phone
// learns the desktop is unusable. A heartbeat that kept ticking after
// the operator signed out of Kindoo would leave the manager tapping a
// button that fails every time, with nothing on screen explaining why.
//
// Everything here is scoped to ONE Kindoo site — the one this tab is
// currently inside — because that is the only site this tab can
// provision for. A manager with two tabs on two sites of one stake runs
// two independent loops, and they must not tread on each other:
//
//   - each publishes its own `desktops/{siteKey}` doc, so the phone can
//     see both sites as covered rather than watching one tab overwrite
//     the other's EID every 60 seconds;
//   - each claims only jobs whose `target_site_key` it serves, so the
//     foreground tab (10s cadence) can't hoover up work belonging to the
//     backgrounded tab (60s cadence) and then fail it with "switch
//     Kindoo sites" — advice that is nonsense when the right site is
//     open in the next tab.
//
// A third job rides the same tick: a sweep that finalises jobs left
// `running` by a tab that died mid-flight. Nothing else can — the poller
// queries only `queued` and the phone's timeout only cancels `queued` —
// so without it a stranded job leaves the manager watching "Your desktop
// is applying this…" forever. See `sweepStrandedIfDue`.
//
// Cadence:
//   - heartbeat every REMOTE_APPLY_HEARTBEAT_MS (60s)
//   - poll every REMOTE_APPLY_POLL_VISIBLE_MS (10s) while the tab is
//     visible, REMOTE_APPLY_POLL_HIDDEN_MS (60s) when it is hidden
//   - stranded-job sweep every SWEEP_INTERVAL_MS (60s)
//
// Chained `setTimeout` rather than `setInterval`: ticks do network work
// and must never overlap, and the visible/hidden period switch falls
// out of rescheduling instead of needing an interval teardown.

import {
  REMOTE_APPLY_HEARTBEAT_MS,
  REMOTE_APPLY_POLL_HIDDEN_MS,
  REMOTE_APPLY_POLL_VISIBLE_MS,
  canClaimRemoteApplyJob,
} from '@kindoo/shared';
import {
  remoteApplyClaimJob,
  remoteApplyFinishJob,
  remoteApplyQueuedJobs,
  remoteApplyRunningJobs,
  writeRemotePresence,
  type RemoteApplyJobRef,
  type StakeConfigBundle,
} from '../../lib/extensionApi';
import { remoteApplyEnabledSnapshot } from '../../lib/remoteApplyPrefs';
import { readKindooSession, type KindooSession } from '../kindoo/auth';
import { getEnvironments } from '../kindoo/endpoints';
import { runRemoteApplyJob } from './runner';
import { activeKindooSiteName, resolveTabSite, type ResolvedTabSite } from './site';

/**
 * How long a job may sit `running` before a tab that CAN serve its site
 * treats it as stranded and writes it terminal.
 *
 * A real run is a handful of Kindoo calls plus two SBA round-trips —
 * seconds, tens at worst. Five minutes is far outside that, which is the
 * whole safety argument for the sweep: attribution can't distinguish a
 * sibling tab's live run from a dead tab's leftovers (`claimed_by`
 * carries only an ext version and an EID, neither tab-unique), so age is
 * what stands in for it. Wide enough to absorb clock skew between this
 * desktop and the server timestamps it compares against; short enough
 * that a manager watching their phone isn't stuck for long.
 */
export const REMOTE_APPLY_STRANDED_MS = 300_000;

/**
 * The same threshold for a job this tab CANNOT serve — another site, or
 * another stake, or a tab that hasn't resolved its own site yet.
 *
 * Two thresholds rather than a site filter, because a plain filter trades
 * one bug for a worse one. Filter absolutely and a job stranded on site B
 * is only ever cleaned up by a tab on site B — but the overwhelmingly
 * likely way a job strands is that the manager CLOSED the site-B tab, so
 * the cleanup would wait on the thing that just failed to happen, and the
 * phone would show "Your desktop is applying this…" forever. Don't filter
 * at all and the foreground site-A tab finalises site-B's genuinely
 * in-flight work out from under it.
 *
 * Splitting by threshold keeps both properties. The tab that could have
 * run the job sweeps promptly; any other tab still guarantees eventual
 * cleanup, but only after twice as long — by which point "a sibling is
 * still running it" is not a credible reading of a job whose real
 * duration is measured in seconds. The cost of waiting is a spinner on
 * the phone; the cost of sweeping too eagerly is telling a manager to go
 * check work that was in fact completing.
 */
export const REMOTE_APPLY_STRANDED_OTHER_SITE_MS = REMOTE_APPLY_STRANDED_MS * 2;

/** How often a tab looks for stranded jobs. One extra `getDocs` a
 * minute per open Kindoo tab, against a collection of a few docs. */
const SWEEP_INTERVAL_MS = 60_000;

/** Attempts for the terminal write, and the waits between them. A
 * single Firestore blip must not be what strands a job. */
const FINISH_ATTEMPTS = 3;
const FINISH_BACKOFF_MS = [1_000, 4_000];

/**
 * What the phone shows for a swept job. Deliberately does NOT say the
 * provision failed: the tab died somewhere between claiming the job and
 * reporting on it, so the Kindoo write may well have landed. The only
 * honest instruction is to go look at the desktop before re-applying —
 * re-applying blind is how a member burns a second Kindoo licence.
 */
const STRANDED_MESSAGE =
  'Your desktop stopped partway through this request, so it never reported back. ' +
  'It may or may not have gone through in Kindoo — check this request on your desktop ' +
  'before applying again.';

export interface RemoteApplyLoopArgs {
  stakeId: string;
  bundle: StakeConfigBundle;
  /** `chrome.runtime.getManifest().version`. */
  extVersion: string;
  /** Called when this tab claims a job, and again when it terminates.
   * Drives the desktop's "running" banner + post-run queue refresh. */
  onJobStart?: (job: RemoteApplyJobRef) => void;
  onJobEnd?: (job: RemoteApplyJobRef) => void;
  /**
   * Called with the site key each time this tab successfully publishes a
   * desktop doc. The React host remembers it so opting out can DELETE
   * that doc — the loop is stopped by then and can't clean up after
   * itself, and a lingering desktop doc keeps naming a site the manager
   * has just stopped serving.
   */
  onSitePublished?: (siteKey: string) => void;
}

/** Everything the loop touches that a test wants to control. */
export interface RemoteApplyLoopDeps {
  readSession: typeof readKindooSession;
  getEnvironments: typeof getEnvironments;
  writeRemotePresence: typeof writeRemotePresence;
  queuedJobs: typeof remoteApplyQueuedJobs;
  runningJobs: typeof remoteApplyRunningJobs;
  claimJob: typeof remoteApplyClaimJob;
  finishJob: typeof remoteApplyFinishJob;
  runJob: typeof runRemoteApplyJob;
  now: () => number;
  isHidden: () => boolean;
  /** Synchronous read of the opt-in. Synchronous on purpose: the check
   * has to sit immediately before the presence write with no await in
   * between, or it reopens the race it exists to close. */
  isEnabled: () => boolean;
  sleep: (ms: number) => Promise<void>;
}

function defaultDeps(): RemoteApplyLoopDeps {
  return {
    readSession: readKindooSession,
    getEnvironments,
    writeRemotePresence,
    queuedJobs: remoteApplyQueuedJobs,
    runningJobs: remoteApplyRunningJobs,
    claimJob: remoteApplyClaimJob,
    finishJob: remoteApplyFinishJob,
    runJob: runRemoteApplyJob,
    now: () => Date.now(),
    isHidden: () => document.visibilityState === 'hidden',
    isEnabled: remoteApplyEnabledSnapshot,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Rules rejections arrive as an `ExtensionApiError` carrying the
 * SW-side code. Narrow defensively — a plain `Error` has no `code`. */
function isPermissionDenied(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === 'permission-denied';
}

export interface RemoteApplyLoopHandle {
  /** Stop ticking. Safe to call more than once. */
  stop: () => void;
  /**
   * Run one tick now, awaiting it and propagating any error. Exposed
   * for tests, which start the loop, `stop()` it to cancel the timer,
   * and then drive ticks explicitly rather than racing a scheduler.
   */
  tick: () => Promise<void>;
}

/**
 * Start the loop. The caller decides WHEN to start and stop it; the loop
 * additionally re-reads the opt-in on every tick and immediately before
 * every presence write, because stopping cannot abort a tick already in
 * flight and that tick's `enabled: true` would otherwise overwrite the
 * eager disable write.
 */
export function startRemoteApplyLoop(
  args: RemoteApplyLoopArgs,
  overrides: Partial<RemoteApplyLoopDeps> = {},
): RemoteApplyLoopHandle {
  const deps: RemoteApplyLoopDeps = { ...defaultDeps(), ...overrides };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  /** Epoch ms of the last presence write. `0` forces one on the first
   * tick so the phone sees the desktop as soon as the toggle flips. */
  let lastHeartbeatAt = 0;
  /** Epoch ms of the last stranded-job sweep. `0` forces one on the
   * first tick — a job stranded by the previous page load is exactly
   * what a fresh loop should clean up. */
  let lastSweepAt = 0;
  /** Jobs this tab is executing right now. The sweep skips them: they
   * are the one set of `running` jobs it can positively attribute to a
   * live runner. */
  const inFlight = new Set<string>();
  /**
   * The SBA-side Kindoo site this tab is inside, resolved on the last
   * heartbeat. `null` means "not resolved" — no Kindoo session, or an
   * EID this stake hasn't configured — and in that state the tab claims
   * nothing, since `canClaimRemoteApplyJob` reads a null tab site as
   * "can serve no job at all".
   */
  let activeSite: ResolvedTabSite | null = null;

  /** Whether this tab could itself run `job`. The one place the claim
   * rule is consulted; the poller uses it to pick work and the sweep to
   * pick a threshold. */
  const canServe = (job: { stakeId: string; targetSiteKey: string }): boolean =>
    canClaimRemoteApplyJob(
      { stake_id: job.stakeId, target_site_key: job.targetSiteKey },
      args.stakeId,
      activeSite?.siteKey ?? null,
    );

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    if (stopped) return;
    clear();
    const delay = deps.isHidden() ? REMOTE_APPLY_POLL_HIDDEN_MS : REMOTE_APPLY_POLL_VISIBLE_MS;
    timer = setTimeout(() => void drive(), delay);
  };

  const drive = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      // A tick failure is transient by assumption (Kindoo hiccup,
      // Firestore blip). Log and keep the loop alive — stopping would
      // strand the manager with a button that silently never works.
      console.warn('[sba-ext] remote apply: tick failed', err);
    } finally {
      running = false;
      schedule();
    }
  };

  const tick = async () => {
    // Ahead of every gate below, including the Kindoo-session check: a
    // tab whose Kindoo session just died is a prime candidate for having
    // stranded a job, and finalising one is pure Firestore work that
    // needs no Kindoo session at all.
    await sweepStrandedIfDue();
    if (!deps.isEnabled()) return;
    const sessionResult = deps.readSession();
    if (!sessionResult.ok) {
      // Deliberately silent and deliberately no presence write. See the
      // module header.
      return;
    }
    const session = sessionResult.session;
    const heartbeatOk = await heartbeatIfDue(session);
    if (!heartbeatOk) return;
    await pollOnce(session);
  };

  /**
   * Drive long-`running` jobs to a terminal status.
   *
   * A job strands when the tab that claimed it goes away between the
   * `queued → running` claim and the terminal write — the browser quits,
   * the tab closes, the terminal write exhausts its retries. Nothing else
   * would ever move it: the poller queries only `queued`, and the phone's
   * timeout path is `queued → cancelled`. The manager would watch "Your
   * desktop is applying this…" forever with no way out.
   *
   * Attribution is as strong as it can be made, which is not very:
   *
   *   - The mailbox is keyed by the signed-in manager's canonical email
   *     and rules let nobody else write it, so every `running` job here
   *     was claimed by one of THIS manager's Kindoo tabs.
   *   - `claimed_by` carries `{ ext_version, kindoo_eid }` — neither is
   *     tab-unique, so it cannot tell a live sibling tab from a dead one.
   *     Filtering on it would only mean strands from another site or an
   *     older build never get cleaned up.
   *   - What is left is age plus `inFlight`, which rules out this tab's
   *     own work.
   *
   * The site this tab serves does NOT gate the sweep — it only picks
   * which age applies. A job this tab could have run is swept at
   * `REMOTE_APPLY_STRANDED_MS`; anything else waits
   * `REMOTE_APPLY_STRANDED_OTHER_SITE_MS`. See those constants for why
   * gating outright would be worse than not filtering at all.
   *
   * Note the interaction with tick ordering: this runs ahead of site
   * resolution, so the FIRST sweep after a page load has no site yet
   * and holds everything to the longer threshold. Deliberate — running
   * the sweep first is what keeps it working when Kindoo is unreachable,
   * and that is worth more than the one sweep interval of delay it costs
   * a freshly-loaded tab cleaning up its predecessor's strand.
   *
   * Worst case a sweep races a genuinely-live sibling: that tab's own
   * terminal write is then rejected (its `running` precondition no longer
   * holds) and the manager reads "check on your desktop" for work that
   * actually completed. That beats the alternative — the phone has no
   * other exit from `running`.
   */
  const sweepStrandedIfDue = async (): Promise<void> => {
    if (deps.now() - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = deps.now();
    try {
      const jobs = await deps.runningJobs();
      for (const job of jobs) {
        if (inFlight.has(job.jobId)) continue;
        // No usable claim age ⇒ nothing to justify the sweep on. Leave it;
        // the next pass will have a resolved server timestamp to read.
        if (job.claimedAtMs === null) continue;
        const servable = canServe(job);
        const threshold = servable ? REMOTE_APPLY_STRANDED_MS : REMOTE_APPLY_STRANDED_OTHER_SITE_MS;
        if (job.claimedAtMs > deps.now() - threshold) continue;
        console.warn(
          `[sba-ext] remote apply: job ${job.jobId} (site '${job.targetSiteKey}') has been ` +
            `running since ${new Date(job.claimedAtMs).toISOString()}; finalising as stranded`,
        );
        try {
          await deps.finishJob(job.jobId, {
            status: 'failed',
            outcome: { code: 'error', message: STRANDED_MESSAGE },
          });
        } catch (err) {
          // Next sweep retries. Nothing the operator can act on.
          console.warn(`[sba-ext] remote apply: could not finalise job ${job.jobId}`, err);
        }
      }
    } catch (err) {
      console.warn('[sba-ext] remote apply: stranded-job sweep failed', err);
    }
  };

  /**
   * Write the terminal status, retrying a few times before giving up.
   *
   * This write is what closes the job out; if it is lost the job strands
   * (see `sweepStrandedIfDue`). A transient Firestore error or a network
   * blip is exactly the kind of thing a couple of retries absorbs, and
   * absorbing it here means the manager sees the real outcome rather than
   * the sweep's "check your desktop".
   *
   * `permission-denied` is NOT retried: it means the job is no longer
   * `running`, so the transition can never succeed. Retrying would just
   * delay the failure.
   */
  const finishWithRetry = async (
    jobId: string,
    payload: Parameters<typeof remoteApplyFinishJob>[1],
  ): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await deps.finishJob(jobId, payload);
        return;
      } catch (err) {
        if (attempt >= FINISH_ATTEMPTS || isPermissionDenied(err)) throw err;
        console.warn(
          `[sba-ext] remote apply: terminal write for job ${jobId} failed ` +
            `(attempt ${attempt}/${FINISH_ATTEMPTS}); retrying`,
          err,
        );
        await deps.sleep(FINISH_BACKOFF_MS[attempt - 1] ?? 4_000);
      }
    }
  };

  /**
   * Resolve this tab's site and publish presence when due. Returns false
   * when the tab must not go on to poll.
   *
   * Two failure modes end the tick here, and both are deliberately
   * silent-to-the-phone:
   *
   *   - The Kindoo session turned out to be dead. `readKindooSession`
   *     only proves a token string exists in localStorage, and an
   *     expired token looks identical to a live one until something
   *     calls the API. `getEnvironments` is that call, and its failure
   *     is the earliest honest signal that this desktop cannot
   *     provision.
   *   - The active EID maps to no Kindoo site this stake has configured.
   *     Such a tab can't name its site to the phone and couldn't
   *     provision for it either, so it publishes nothing and claims
   *     nothing. Not an error — a manager legitimately visits Kindoo
   *     sites SBA doesn't manage.
   *
   * Re-resolution is NOT purely time-driven: Kindoo is an SPA, so the
   * operator can switch sites with no page load and no remount, and a
   * resolution cached against the previous EID would leave this tab
   * claiming the site it just left for up to a full heartbeat period.
   */
  const heartbeatIfDue = async (session: KindooSession): Promise<boolean> => {
    const due = deps.now() - lastHeartbeatAt >= REMOTE_APPLY_HEARTBEAT_MS;
    const resolvedForThisSite = activeSite !== null && activeSite.kindooEid === session.eid;
    if (!due && resolvedForThisSite) return true;
    let envs: Awaited<ReturnType<typeof getEnvironments>>;
    try {
      envs = await deps.getEnvironments(session);
    } catch (err) {
      activeSite = null;
      console.warn('[sba-ext] remote apply: Kindoo session unusable; skipping heartbeat', err);
      return false;
    }
    const site = resolveTabSite({ session, envs, bundle: args.bundle });
    if (!site) {
      activeSite = null;
      console.info(
        `[sba-ext] remote apply: Kindoo site ${session.eid} is not configured for stake ` +
          `'${args.stakeId}'; this tab publishes no presence and claims no jobs`,
      );
      return false;
    }
    activeSite = site;
    // Last gate before the write, and it has to be here rather than at
    // the top of the tick. Opting out stops the loop and then publishes
    // `enabled: false`, but stopping does not abort a tick already in
    // flight — this one may have been awaiting `getEnvironments` the
    // whole time. Both writes are `merge: true`, so an `enabled: true`
    // landing after the disable write wins, and the phone keeps offering
    // a button the manager just revoked for a full staleness window.
    if (!deps.isEnabled()) {
      console.info('[sba-ext] remote apply: opt-in cleared mid-tick; skipping presence write');
      return false;
    }
    await deps.writeRemotePresence({
      enabled: true,
      siteKey: site.siteKey,
      kindooSiteId: site.kindooSiteId,
      stakeId: args.stakeId,
      kindooEid: session.eid,
      kindooSiteName: activeKindooSiteName(envs, session),
      extVersion: args.extVersion,
    });
    lastHeartbeatAt = deps.now();
    // After the write, not before: the React host uses this to decide
    // which desktop doc to delete on opt-out, and there is nothing to
    // delete for a heartbeat that never landed.
    args.onSitePublished?.(site.siteKey);
    return true;
  };

  /**
   * Claim and run the first queued job this tab's site can serve.
   *
   * A page of jobs rather than the single oldest one, because with two
   * tabs on two sites the oldest queued job routinely belongs to the
   * other tab. Taking it would fail the run with "switch Kindoo sites"
   * while the right site sits open next door; refusing to look past it
   * would let one unservable job block every servable one behind it.
   * So: skip what this tab can't do, claim the first thing it can.
   */
  const pollOnce = async (session: KindooSession): Promise<void> => {
    const jobs = await deps.queuedJobs();
    const claimable: RemoteApplyJobRef[] = [];
    for (const candidate of jobs) {
      if (canServe(candidate)) {
        claimable.push(candidate);
        continue;
      }
      // Info, not warn: leaving a sibling tab's work alone is the
      // feature working, not a fault. It is logged at all so a manager
      // debugging "why didn't my phone tap do anything" can see which
      // site the job wanted and which site this tab is on.
      console.info(
        `[sba-ext] remote apply: leaving job ${candidate.jobId} for another tab — it needs ` +
          `stake '${candidate.stakeId}' site '${candidate.targetSiteKey}'; this tab serves ` +
          `stake '${args.stakeId}' site '${activeSite?.siteKey ?? 'none'}'`,
      );
    }
    const job = claimable[0];
    if (!job) return;
    const claimed = await deps.claimJob(job.jobId, args.extVersion, session.eid);
    if (!claimed) return;

    console.info(`[sba-ext] remote apply: claimed job ${job.jobId} for request ${job.requestId}`);
    inFlight.add(job.jobId);
    args.onJobStart?.(job);
    try {
      const result = await deps.runJob({ stakeId: args.stakeId, bundle: args.bundle, job });
      await finishWithRetry(job.jobId, { status: result.status, outcome: result.outcome });
      console.info(`[sba-ext] remote apply: job ${job.jobId} finished as ${result.status}`);
    } finally {
      inFlight.delete(job.jobId);
      args.onJobEnd?.(job);
    }
  };

  // Visibility changes shift the poll period. Reschedule so a tab that
  // just came forward doesn't sit out the remainder of a 60s hidden
  // delay while the manager watches their phone.
  const onVisibilityChange = () => {
    if (stopped || running) return;
    schedule();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  // First tick on the next macrotask rather than a poll period later:
  // the operator has just opted in (or the page just loaded) and the
  // phone should see the desktop promptly. Deferred by a zero-delay
  // timer, not called inline, so starting the loop stays synchronous
  // and cheap for the React effect that owns it — and so a caller that
  // stops immediately does no network work at all.
  timer = setTimeout(() => void drive(), 0);

  return {
    stop: () => {
      stopped = true;
      clear();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
    tick: async () => {
      await tick();
    },
  };
}
