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
// Cadence:
//   - heartbeat every REMOTE_APPLY_HEARTBEAT_MS (60s)
//   - poll every REMOTE_APPLY_POLL_VISIBLE_MS (10s) while the tab is
//     visible, REMOTE_APPLY_POLL_HIDDEN_MS (60s) when it is hidden
//
// Chained `setTimeout` rather than `setInterval`: ticks do network work
// and must never overlap, and the visible/hidden period switch falls
// out of rescheduling instead of needing an interval teardown.

import {
  REMOTE_APPLY_HEARTBEAT_MS,
  REMOTE_APPLY_POLL_HIDDEN_MS,
  REMOTE_APPLY_POLL_VISIBLE_MS,
} from '@kindoo/shared';
import {
  remoteApplyClaimJob,
  remoteApplyFinishJob,
  remoteApplyNextJob,
  writeRemotePresence,
  type RemoteApplyJobRef,
  type StakeConfigBundle,
} from '../../lib/extensionApi';
import { readKindooSession, type KindooSession } from '../kindoo/auth';
import { getEnvironments } from '../kindoo/endpoints';
import { runRemoteApplyJob } from './runner';

export interface RemoteApplyLoopArgs {
  stakeId: string;
  bundle: StakeConfigBundle;
  /** `chrome.runtime.getManifest().version`. */
  extVersion: string;
  /** Called when this tab claims a job, and again when it terminates.
   * Drives the desktop's "running" banner + post-run queue refresh. */
  onJobStart?: (job: RemoteApplyJobRef) => void;
  onJobEnd?: (job: RemoteApplyJobRef) => void;
}

/** Everything the loop touches that a test wants to control. */
export interface RemoteApplyLoopDeps {
  readSession: typeof readKindooSession;
  getEnvironments: typeof getEnvironments;
  writeRemotePresence: typeof writeRemotePresence;
  nextJob: typeof remoteApplyNextJob;
  claimJob: typeof remoteApplyClaimJob;
  finishJob: typeof remoteApplyFinishJob;
  runJob: typeof runRemoteApplyJob;
  now: () => number;
  isHidden: () => boolean;
}

function defaultDeps(): RemoteApplyLoopDeps {
  return {
    readSession: readKindooSession,
    getEnvironments,
    writeRemotePresence,
    nextJob: remoteApplyNextJob,
    claimJob: remoteApplyClaimJob,
    finishJob: remoteApplyFinishJob,
    runJob: runRemoteApplyJob,
    now: () => Date.now(),
    isHidden: () => document.visibilityState === 'hidden',
  };
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
 * Start the loop. The caller is responsible for only starting it while
 * the operator has opted in — the loop itself does not read the toggle.
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
   * Publish presence when due. Returns false when the Kindoo session
   * turned out to be dead — `readKindooSession` only proves a token
   * string exists in localStorage, and an expired token looks identical
   * to a live one until something calls the API. `getEnvironments` is
   * that call: it is needed anyway to resolve the site name the phone
   * displays, and its failure is the earliest honest signal that this
   * desktop cannot provision. Both the heartbeat and the poll stop on
   * it, so the phone's button goes away instead of failing on tap.
   */
  const heartbeatIfDue = async (session: KindooSession): Promise<boolean> => {
    if (deps.now() - lastHeartbeatAt < REMOTE_APPLY_HEARTBEAT_MS) return true;
    let siteName: string | null = null;
    try {
      const envs = await deps.getEnvironments(session);
      siteName = envs.find((e) => e.EID === session.eid)?.Name ?? null;
    } catch (err) {
      console.warn('[sba-ext] remote apply: Kindoo session unusable; skipping heartbeat', err);
      return false;
    }
    await deps.writeRemotePresence({
      stakeId: args.stakeId,
      kindooEid: session.eid,
      kindooSiteName: siteName,
      extVersion: args.extVersion,
      enabled: true,
    });
    lastHeartbeatAt = deps.now();
    return true;
  };

  const pollOnce = async (session: KindooSession): Promise<void> => {
    const job = await deps.nextJob();
    if (!job) return;
    if (job.stakeId !== args.stakeId) {
      // Can't normally happen — the phone only offers the button when
      // the presence doc's stake matches the one it is looking at. If
      // it does, another Kindoo tab on the right stake is the one that
      // should claim it, so leave the job alone.
      console.warn(
        `[sba-ext] remote apply: job ${job.jobId} targets stake '${job.stakeId}'; this tab is on '${args.stakeId}'`,
      );
      return;
    }
    const claimed = await deps.claimJob(job.jobId, args.extVersion, session.eid);
    if (!claimed) return;

    console.info(`[sba-ext] remote apply: claimed job ${job.jobId} for request ${job.requestId}`);
    args.onJobStart?.(job);
    try {
      const result = await deps.runJob({ stakeId: args.stakeId, bundle: args.bundle, job });
      await deps.finishJob(job.jobId, { status: result.status, outcome: result.outcome });
      console.info(`[sba-ext] remote apply: job ${job.jobId} finished as ${result.status}`);
    } finally {
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
