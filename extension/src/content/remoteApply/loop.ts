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
// The poll carries the matching backstop for the OTHER non-terminal
// status. A `queued` job is meant to be cancelled by the phone's pickup
// timeout, but that timeout is a `setTimeout` in a React effect in a
// phone browser tab: a screen lock suspends it and closing the tab kills
// it, which is how a phone session normally ends. Left to itself the
// poller would then claim and provision a job of any age, hours after
// the manager walked away from it. So it expires anything past
// REMOTE_APPLY_PICKUP_TIMEOUT_MS instead of claiming it — see
// `expireQueued`.
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
//
// One failure mode ends the loop instead of being retried: reloading or
// updating the extension orphans the copy of this content script already
// running in every open Kindoo page, severing `chrome.runtime` for good.
// Nothing here can work again until the page is reloaded, so the loop
// says so once and stops. Treating it as a transient tick failure — the
// obvious reading, since it arrives as a thrown error like any other —
// is what made every extension update leave a warning ticking away in
// each open tab for as long as it stayed open. See
// `haltForInvalidatedContext`.

import {
  REMOTE_APPLY_HEARTBEAT_MS,
  REMOTE_APPLY_PICKUP_TIMEOUT_MS,
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

/**
 * What an expired `queued` job records.
 *
 * The opposite wording problem to `STRANDED_MESSAGE`, and the easier
 * one: an expired job never left `queued`, so no tab ever ran it and
 * "nothing was changed in Kindoo" is a fact rather than a guess. Saying
 * so is what makes re-applying safe, which is the whole point of
 * finalising rather than skipping.
 *
 * The phone renders its own fixed copy for `cancelled` and never shows
 * this string; it is here for the job trail an operator reads when a
 * manager asks why their tap did nothing. It also distinguishes a
 * desktop-side expiry from the phone's own timeout, which writes no
 * outcome at all.
 */
const EXPIRED_MESSAGE =
  'Your desktop did not pick this up within the time your phone waits for it, so it was ' +
  'cancelled. Nothing was changed in Kindoo. Open Kindoo on your computer and apply it again.';

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
  /**
   * Whether this content script can still reach the extension.
   *
   * Reloading or updating the extension orphans the copy already running
   * in every open Kindoo page: the `chrome.runtime` connection is
   * severed and every message throws. Chrome clears `chrome.runtime.id`
   * at the same moment, which makes it the cheapest signal and — unlike
   * the exception's wording — not something a Chrome release can change
   * out from under us.
   */
  isContextAlive: () => boolean;
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
    isContextAlive: () => {
      // Total by construction: `drive` probes before entering its try,
      // so a throw here would surface as an unhandled rejection — a new
      // console error in place of the one being fixed. `chrome.runtime`
      // is the part Chrome severs; whether reading through it can throw
      // rather than read `undefined` is not worth betting on.
      try {
        return Boolean(chrome.runtime?.id);
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Rules rejections arrive as an `ExtensionApiError` carrying the
 * SW-side code. Narrow defensively — a plain `Error` has no `code`. */
function isPermissionDenied(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === 'permission-denied';
}

/**
 * Whether an error is Chrome's orphaned-content-script exception.
 *
 * The fallback signal, not the primary one — `deps.isContextAlive` is,
 * because matching message text breaks the day Chrome rewords it. Kept
 * anyway because a missed detection reinstates exactly the bug this
 * exists to fix: a severed loop logging a failure every tick, in every
 * open Kindoo tab, for as long as the operator leaves them open.
 *
 * Note this arrives as a bare `Error`, not an `ExtensionApiError`:
 * `chrome.runtime.sendMessage` throws it synchronously, so it never
 * reaches the `lastError` branch that wraps wire failures.
 */
function isInvalidatedContextError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('Extension context invalidated');
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
  /** Set the first time the loop finds itself orphaned by an extension
   * reload, so the halt announces itself exactly once. */
  let contextInvalidated = false;
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
  /**
   * Epoch ms of the last `getEnvironments` ATTEMPT, and the EID it was
   * made for — recorded whether or not it produced a site.
   *
   * These exist because `activeSite === null` is not a usable "re-resolve
   * me" signal on its own. It is the resting state of two ordinary
   * situations that persist indefinitely — a Kindoo session that expired
   * while the tab stayed open, and an EID this stake hasn't configured —
   * and deriving the question from it alone put a Kindoo API POST on
   * every 10s poll tick, forever, against a third party's server.
   *
   * Gating on the attempt instead holds an unresolvable tab to the same
   * one-call-per-heartbeat budget a healthy one keeps. The EID is stored
   * alongside so the operator navigating to a different Kindoo site
   * still re-resolves immediately: that is new information, not a retry.
   */
  let lastResolveAt = 0;
  let lastResolveEid: number | null = null;

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

  const teardown = () => {
    stopped = true;
    clear();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };

  /**
   * Whether this page's copy of the extension has been orphaned.
   *
   * Takes an optional error so a tick that discovers it by throwing gets
   * the same answer as one that discovers it by probing.
   */
  const contextLost = (err?: unknown): boolean =>
    !deps.isContextAlive() || isInvalidatedContextError(err);

  /**
   * End the loop for good, because there is no extension left to talk to.
   *
   * Reloading or updating the extension leaves the previous build's
   * content script running in every open Kindoo page with its
   * `chrome.runtime` connection severed. That is normal and expected —
   * reloading the tab picks up the new build — but the loop would
   * otherwise go on ticking in the dead page, failing every message and
   * logging it, indefinitely.
   *
   * So: one line, at info because a refresh is the whole remedy, and
   * then silence. `stopped` guarantees the timer never fires again;
   * `contextInvalidated` guarantees the line is not repeated by a tick
   * already in flight when the first one discovered it.
   */
  const haltForInvalidatedContext = () => {
    if (contextInvalidated) return;
    contextInvalidated = true;
    console.info(
      '[sba-ext] remote apply: this page still holds the copy of the extension that was ' +
        'replaced when it reloaded or updated, so it can no longer reach it. Remote apply is ' +
        'stopped on this tab — reload the page to restore it.',
    );
    teardown();
  };

  const schedule = () => {
    if (stopped) return;
    clear();
    const delay = deps.isHidden() ? REMOTE_APPLY_POLL_HIDDEN_MS : REMOTE_APPLY_POLL_VISIBLE_MS;
    timer = setTimeout(() => void drive(), delay);
  };

  const drive = async () => {
    if (stopped || running) return;
    // Ahead of any message, because an orphaned content script can do
    // nothing but throw. Probing costs a property read and saves the
    // doomed round-trip that would otherwise be how we found out.
    if (contextLost()) {
      haltForInvalidatedContext();
      return;
    }
    running = true;
    try {
      await tick();
    } catch (err) {
      // Not a tick failure — the extension went away underneath this
      // page, and nothing this loop does can work again. Ends the loop
      // rather than logging the same thing every 10 seconds forever.
      if (contextLost(err)) {
        haltForInvalidatedContext();
      } else {
        // A tick failure is transient by assumption (Kindoo hiccup,
        // Firestore blip). Log and keep the loop alive — stopping would
        // strand the manager with a button that silently never works.
        console.warn('[sba-ext] remote apply: tick failed', err);
      }
    } finally {
      running = false;
      // No-op once halted: `teardown` has already set `stopped`.
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
          if (contextLost(err)) throw err;
          // Next sweep retries. Nothing the operator can act on.
          console.warn(`[sba-ext] remote apply: could not finalise job ${job.jobId}`, err);
        }
      }
    } catch (err) {
      // Hand an orphaned context up to `drive` instead of swallowing it.
      // This catch is what turned an extension reload into a warning
      // every 60s in every open Kindoo tab: the sweep runs before every
      // other gate, so it is the first thing to fail and — logging
      // rather than propagating — it was also the only thing that ever
      // reported the failure.
      if (contextLost(err)) throw err;
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
        // A severed context is as unretryable as a rules rejection, and
        // burning the backoff against it only delays the halt.
        if (attempt >= FINISH_ATTEMPTS || isPermissionDenied(err) || contextLost(err)) throw err;
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
   *
   * Nor is it driven by `activeSite === null`. Both failure modes above
   * LEAVE it null, and neither clears on its own, so re-resolving
   * whenever it is null means a Kindoo API POST every poll tick for as
   * long as the tab stays open — 10 seconds apart on a visible tab,
   * indefinitely, against someone else's server. `lastResolveAt` /
   * `lastResolveEid` cap that at the heartbeat period, which is the
   * documented budget of one Kindoo call per 60s per open tab, while
   * still re-resolving the instant the EID changes. The periodic retry
   * is what lets a tab recover on its own once the operator signs back
   * into Kindoo, or configures the site the tab is sitting in.
   */
  const heartbeatIfDue = async (session: KindooSession): Promise<boolean> => {
    const resolvedForThisSite = activeSite !== null && activeSite.kindooEid === session.eid;
    if (resolvedForThisSite) {
      if (deps.now() - lastHeartbeatAt < REMOTE_APPLY_HEARTBEAT_MS) return true;
    } else if (
      session.eid === lastResolveEid &&
      deps.now() - lastResolveAt < REMOTE_APPLY_HEARTBEAT_MS
    ) {
      // Same EID that just failed to resolve, and the retry window
      // hasn't elapsed. Silent: the attempt that set these already said
      // why, and repeating it every 10s would bury everything else.
      return false;
    }
    lastResolveAt = deps.now();
    lastResolveEid = session.eid;
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
    // whole time. Both writes REPLACE the presence doc whole (never
    // `{ merge: true }` — the rules match an exact key set against the
    // merged result and would deny it), so an `enabled: true` landing
    // after the disable write overwrites it outright, and the phone
    // keeps offering a button the manager just revoked for a full
    // staleness window.
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
   * Whether a `queued` job is already past the window the phone waits
   * for a desktop to pick it up.
   *
   * An unreadable `created_at` reads as NOT expired, so an unaged job
   * stays claimable. Deliberately the opposite lean to the stranded
   * sweep, and for a different question: there the missing age would
   * license writing a job terminal, here it would license cancelling
   * work the manager may have tapped seconds ago — and the phone would
   * tell them their desktop ignored them while it was in fact running.
   * The state is unreachable anyway from a server read, since the create
   * rule requires `created_at is timestamp`.
   */
  const isPastPickup = (job: RemoteApplyJobRef): boolean =>
    job.createdAtMs !== null && deps.now() - job.createdAtMs >= REMOTE_APPLY_PICKUP_TIMEOUT_MS;

  /**
   * Finalise a job nobody picked up in time — `queued → cancelled`, the
   * same transition and the same terminal status the phone's own pickup
   * timeout writes.
   *
   * Cancelling rather than merely skipping, because skipping leaves the
   * job `queued` and a `queued` job is not inert on the phone: its row
   * reads "Sent to your desktop — waiting for it to start…" and counts
   * as in-flight, so the manager cannot tap Apply for that request
   * again. Skipping would trade an unattended provision for a request
   * the manager is silently locked out of, with nothing anywhere saying
   * why. Cancelling shows them "Your desktop didn't pick this up" and
   * gives the button back.
   *
   * Site-independent, unlike the claim: staleness is a fact about the
   * job, not about this tab. The tab that could have served it is the
   * one most likely to be closed — that is HOW the job went stale — so
   * gating on `canServe` would leave the commonest case to the tab that
   * just failed to exist.
   *
   * This can race a sibling tab's claim by up to one poll period. It
   * loses harmlessly: the job has left `queued`, the rules' before-status
   * check rejects this write, and the sibling's own terminal write is
   * untouched. The reverse race is impossible for a hidden tab, which
   * polls at 60s against a 90s pickup window and therefore always sees a
   * claimable job while it is still fresh.
   */
  const expireQueued = async (job: RemoteApplyJobRef): Promise<void> => {
    console.warn(
      `[sba-ext] remote apply: job ${job.jobId} (request ${job.requestId}) has been queued ` +
        `since ${new Date(job.createdAtMs ?? 0).toISOString()}, past the phone's pickup ` +
        `window; cancelling rather than provisioning it unattended`,
    );
    try {
      await deps.finishJob(job.jobId, {
        status: 'cancelled',
        outcome: { code: 'error', message: EXPIRED_MESSAGE },
      });
    } catch (err) {
      if (isPermissionDenied(err)) {
        // It left `queued` between the query and this write — another
        // tab claimed it, or the phone's own timeout got there first.
        // Both are the system working.
        console.info(
          `[sba-ext] remote apply: job ${job.jobId} moved on before it could be cancelled`,
        );
        return;
      }
      if (contextLost(err)) throw err;
      // Next poll retries; the job is still `queued` and still stale.
      console.warn(`[sba-ext] remote apply: could not cancel job ${job.jobId}`, err);
    }
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
   *
   * The age check comes before the site check, and before any claim.
   * `expireQueued` explains why an expired job is finalised here rather
   * than left for the phone; the ordering is what makes it a gate on
   * provisioning rather than a report about it.
   */
  const pollOnce = async (session: KindooSession): Promise<void> => {
    const jobs = await deps.queuedJobs();
    const claimable: RemoteApplyJobRef[] = [];
    for (const candidate of jobs) {
      if (isPastPickup(candidate)) {
        await expireQueued(candidate);
        continue;
      }
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
    stop: teardown,
    tick: async () => {
      await tick();
    },
  };
}
