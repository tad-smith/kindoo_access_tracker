// Unit tests for the heartbeat + poll loop.
//
// The heartbeat-suppression cases are the ones that matter most. The
// phone decides whether to offer "Apply via extension" purely from the
// freshness of this heartbeat, so any tick that publishes presence
// while the desktop cannot actually drive Kindoo puts a button in front
// of the manager that fails every time they press it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_APPLY_HEARTBEAT_MS,
  REMOTE_APPLY_POLL_HIDDEN_MS,
  REMOTE_APPLY_POLL_VISIBLE_MS,
} from '@kindoo/shared';
import type {
  RemoteApplyJobRef,
  RemoteApplyRunningJobRef,
  StakeConfigBundle,
} from '../../lib/extensionApi';
import { REMOTE_APPLY_STRANDED_MS, startRemoteApplyLoop, type RemoteApplyLoopDeps } from './loop';

const STAKE_ID = 'csnorth';
const EXT_VERSION = '1.2.3';

function bundle(): StakeConfigBundle {
  return {
    stake: { stake_id: STAKE_ID, stake_name: 'CS North' } as unknown as StakeConfigBundle['stake'],
    buildings: [],
    wards: [],
    kindooSites: [],
  };
}

function job(overrides: Partial<RemoteApplyJobRef> = {}): RemoteApplyJobRef {
  return { jobId: 'j1', requestId: 'r1', stakeId: STAKE_ID, ...overrides };
}

function runningJob(
  claimedAtMs: number | null,
  overrides: Partial<RemoteApplyRunningJobRef> = {},
): RemoteApplyRunningJobRef {
  return { jobId: 'j1', requestId: 'r1', stakeId: STAKE_ID, claimedAtMs, ...overrides };
}

/** Every dep mocked; individual tests override what they exercise. */
function makeDeps(overrides: Partial<RemoteApplyLoopDeps> = {}) {
  let clock = 1_000_000;
  const base = {
    readSession: vi.fn(() => ({ ok: true as const, session: { token: 'tok', eid: 27994 } })),
    getEnvironments: vi.fn(async () => [
      { EID: 27994, Name: 'CS North', TimeZone: 'Mountain Standard Time' },
    ]),
    writeRemotePresence: vi.fn(async () => undefined),
    nextJob: vi.fn(async () => null),
    runningJobs: vi.fn(async () => [] as RemoteApplyRunningJobRef[]),
    claimJob: vi.fn(async () => true),
    finishJob: vi.fn<RemoteApplyLoopDeps['finishJob']>(async () => undefined),
    runJob: vi.fn(async () => ({
      status: 'applied' as const,
      outcome: { code: 'applied' as const, message: 'done' },
    })),
    now: vi.fn(() => clock),
    isHidden: vi.fn(() => false),
    isEnabled: vi.fn(() => true),
    // Instant, so the terminal write's backoff doesn't cost real time.
    sleep: vi.fn(async () => undefined),
    advance: (ms: number) => {
      clock += ms;
    },
  };
  return { ...base, ...overrides } as RemoteApplyLoopDeps & typeof base;
}

/** Start the loop, then immediately cancel its scheduler so the test
 * drives ticks explicitly instead of racing a timer. `tick()` stays
 * callable after `stop()` by design. */
function start(deps: RemoteApplyLoopDeps, args: Parameters<typeof startRemoteApplyLoop>[0]) {
  const handle = startRemoteApplyLoop(args, deps);
  handle.stop();
  return handle;
}

describe('startRemoteApplyLoop', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes presence with the active Kindoo site and EID', async () => {
    const deps = makeDeps();
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.writeRemotePresence).toHaveBeenCalledWith({
      stakeId: STAKE_ID,
      kindooEid: 27994,
      kindooSiteName: 'CS North',
      extVersion: EXT_VERSION,
      enabled: true,
    });
  });

  it('does NOT heartbeat when the Kindoo session is unreadable', async () => {
    // Absence of a heartbeat is the signal. Publishing here would show
    // the manager a button that can never work.
    const deps = makeDeps({
      readSession: vi.fn(() => ({ ok: false as const, error: 'no-token' as const })),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.writeRemotePresence).not.toHaveBeenCalled();
    expect(deps.nextJob).not.toHaveBeenCalled();
  });

  it('does NOT heartbeat when the active site cannot be identified', async () => {
    const deps = makeDeps({
      readSession: vi.fn(() => ({ ok: false as const, error: 'no-eid' as const })),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.writeRemotePresence).not.toHaveBeenCalled();
  });

  it('does NOT heartbeat or poll when the Kindoo token is present but dead', async () => {
    // `readKindooSession` can only prove a token string exists. An
    // expired token looks identical until the API rejects it, so a
    // failing `getEnvironments` has to stop the heartbeat too.
    const deps = makeDeps({
      getEnvironments: vi.fn(async () => {
        throw new Error('401 Unauthorized');
      }),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.writeRemotePresence).not.toHaveBeenCalled();
    expect(deps.nextJob).not.toHaveBeenCalled();
  });

  it('heartbeats at most once per heartbeat period', async () => {
    const deps = makeDeps();
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });

    await handle.tick();
    deps.advance(REMOTE_APPLY_HEARTBEAT_MS - 1);
    await handle.tick();
    expect(deps.writeRemotePresence).toHaveBeenCalledTimes(1);

    deps.advance(2);
    await handle.tick();
    handle.stop();
    expect(deps.writeRemotePresence).toHaveBeenCalledTimes(2);
    // Polling still runs on every tick — only the heartbeat is rate-limited.
    expect(deps.nextJob).toHaveBeenCalledTimes(3);
  });

  it('claims a queued job, runs it, and writes the terminal status', async () => {
    const onJobStart = vi.fn();
    const onJobEnd = vi.fn();
    const deps = makeDeps({ nextJob: vi.fn(async () => job()) });
    const handle = start(deps, {
      stakeId: STAKE_ID,
      bundle: bundle(),
      extVersion: EXT_VERSION,
      onJobStart,
      onJobEnd,
    });
    await handle.tick();
    handle.stop();

    expect(deps.claimJob).toHaveBeenCalledWith('j1', EXT_VERSION, 27994);
    expect(deps.runJob).toHaveBeenCalledTimes(1);
    expect(deps.finishJob).toHaveBeenCalledWith('j1', {
      status: 'applied',
      outcome: { code: 'applied', message: 'done' },
    });
    expect(onJobStart).toHaveBeenCalledWith(job());
    expect(onJobEnd).toHaveBeenCalledWith(job());
  });

  it('skips quietly when another Kindoo tab won the claim', async () => {
    // The rules-enforced CAS makes the loser's update permission-denied.
    // That is a healthy multi-tab outcome, not a fault: no job runs, no
    // terminal status is written, and the banner never appears.
    const onJobStart = vi.fn();
    const deps = makeDeps({
      nextJob: vi.fn(async () => job()),
      claimJob: vi.fn(async () => false),
    });
    const handle = start(deps, {
      stakeId: STAKE_ID,
      bundle: bundle(),
      extVersion: EXT_VERSION,
      onJobStart,
    });
    await handle.tick();
    handle.stop();

    expect(deps.runJob).not.toHaveBeenCalled();
    expect(deps.finishJob).not.toHaveBeenCalled();
    expect(onJobStart).not.toHaveBeenCalled();
  });

  it('leaves a job that targets a different stake for the tab that can run it', async () => {
    const deps = makeDeps({ nextJob: vi.fn(async () => job({ stakeId: 'other-stake' })) });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.claimJob).not.toHaveBeenCalled();
    expect(deps.runJob).not.toHaveBeenCalled();
  });

  it('clears the running flag even when finishing the job throws', async () => {
    const onJobEnd = vi.fn();
    const deps = makeDeps({
      nextJob: vi.fn(async () => job()),
      finishJob: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const handle = start(deps, {
      stakeId: STAKE_ID,
      bundle: bundle(),
      extVersion: EXT_VERSION,
      onJobEnd,
    });
    await expect(handle.tick()).rejects.toThrow('offline');
    handle.stop();

    expect(onJobEnd).toHaveBeenCalledTimes(1);
  });

  it('ticks on its own schedule until stopped', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const handle = startRemoteApplyLoop(
        { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION },
        deps,
      );
      // First tick is deferred to the next macrotask, not run inline.
      expect(deps.nextJob).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.nextJob).toHaveBeenCalledTimes(1);

      // Visible tab → 10s cadence.
      await vi.advanceTimersByTimeAsync(REMOTE_APPLY_POLL_VISIBLE_MS);
      expect(deps.nextJob).toHaveBeenCalledTimes(2);

      handle.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(deps.nextJob).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- Terminal write: retry, then the sweep as the backstop ---------

  it('retries the terminal write so one Firestore blip cannot strand a job', async () => {
    // Without this the job stays `running` forever: the poller only
    // queries `queued`, and the phone can only cancel a `queued` job.
    const finishJob = vi
      .fn<RemoteApplyLoopDeps['finishJob']>()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValue(undefined);
    const deps = makeDeps({ nextJob: vi.fn(async () => job()), finishJob });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });

    await handle.tick();
    handle.stop();

    expect(finishJob).toHaveBeenCalledTimes(2);
    expect(finishJob).toHaveBeenLastCalledWith('j1', {
      status: 'applied',
      outcome: { code: 'applied', message: 'done' },
    });
  });

  it('does not retry a terminal write the rules rejected', async () => {
    // `permission-denied` means the job is no longer `running`, so the
    // transition can never succeed — retrying only delays the failure.
    const finishJob = vi
      .fn<RemoteApplyLoopDeps['finishJob']>()
      .mockRejectedValue(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    const deps = makeDeps({ nextJob: vi.fn(async () => job()), finishJob });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });

    await expect(handle.tick()).rejects.toThrow('denied');
    handle.stop();
    expect(finishJob).toHaveBeenCalledTimes(1);
  });

  it('finalises a job left running past the stranded threshold', async () => {
    // The tab that claimed it is gone — closed, crashed, or out of
    // retries. Nothing else will ever move the job, and the phone shows
    // "Your desktop is applying this…" until something does.
    const deps = makeDeps({
      runningJobs: vi.fn(async () => [runningJob(1_000_000 - REMOTE_APPLY_STRANDED_MS - 1)]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.finishJob).toHaveBeenCalledTimes(1);
    const [jobId, payload] = deps.finishJob.mock.calls[0] ?? [];
    expect(jobId).toBe('j1');
    expect(payload?.status).toBe('failed');
    // Wording matters as much as the status: the provision may well have
    // reached Kindoo, so the message must send the manager to look rather
    // than assert it failed and invite a second, licence-burning apply.
    expect(payload?.outcome.message).toMatch(/may or may not have gone through in Kindoo/);
    expect(payload?.outcome.message).toMatch(/check this request on your desktop/);
  });

  it('sweeps a stranded job whatever stake it targets', async () => {
    // The tab that could have run it is by definition gone; requiring a
    // same-stake tab to clean up requires the thing that just failed.
    const deps = makeDeps({
      runningJobs: vi.fn(async () => [
        runningJob(1_000_000 - REMOTE_APPLY_STRANDED_MS - 1, { stakeId: 'other-stake' }),
      ]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.finishJob).toHaveBeenCalledTimes(1);
  });

  it('leaves a recently claimed running job alone', async () => {
    const deps = makeDeps({
      runningJobs: vi.fn(async () => [runningJob(1_000_000 - 5_000)]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.finishJob).not.toHaveBeenCalled();
  });

  it('leaves a running job with no readable claim time alone', async () => {
    // Age is the sweep's whole safety argument. Without one, don't.
    const deps = makeDeps({ runningJobs: vi.fn(async () => [runningJob(null)]) });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.finishJob).not.toHaveBeenCalled();
  });

  it('never sweeps the job this tab is running right now', async () => {
    // A slow provision must not be finalised out from under itself —
    // that would report "check your desktop" for work in progress.
    let release: (() => void) | undefined;
    const deps = makeDeps({
      nextJob: vi.fn<RemoteApplyLoopDeps['nextJob']>().mockResolvedValueOnce(job()),
      runJob: vi.fn(
        () =>
          new Promise<{ status: 'applied'; outcome: { code: 'applied'; message: string } }>(
            (resolve) => {
              release = () =>
                resolve({ status: 'applied', outcome: { code: 'applied', message: 'done' } });
            },
          ),
      ),
      // Nothing running at the first sweep; from the claim onward the
      // job is `running` and old enough to sweep, if the in-flight guard
      // weren't there.
      runningJobs: vi
        .fn<RemoteApplyLoopDeps['runningJobs']>()
        .mockResolvedValueOnce([])
        .mockResolvedValue([runningJob(1_000_000 - REMOTE_APPLY_STRANDED_MS - 1)]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });

    const firstTick = handle.tick();
    await vi.waitFor(() => expect(release).toBeDefined());
    // Second tick, a sweep interval later, while the job is still going.
    deps.advance(120_000);
    await handle.tick();
    expect(deps.finishJob).not.toHaveBeenCalled();

    release?.();
    await firstTick;
    handle.stop();

    // Only the runner's own terminal write.
    expect(deps.finishJob).toHaveBeenCalledTimes(1);
    expect(deps.finishJob).toHaveBeenCalledWith('j1', {
      status: 'applied',
      outcome: { code: 'applied', message: 'done' },
    });
  });

  // ---- Opt-out race ---------------------------------------------------

  it('does not republish presence when the opt-in clears mid-tick', async () => {
    // `stop()` cancels the scheduler but cannot abort a tick already
    // awaiting the network. If that tick's `enabled: true` lands after
    // the eager `enabled: false` write, last-write-wins leaves the phone
    // showing a desktop the manager just switched off — for a full
    // staleness window, which is exactly what the eager write exists to
    // avoid. Model the flip landing while `getEnvironments` is in flight.
    let enabled = true;
    const deps = makeDeps({
      getEnvironments: vi.fn(async () => {
        enabled = false;
        return [{ EID: 27994, Name: 'CS North', TimeZone: 'Mountain Standard Time' }];
      }),
      isEnabled: () => enabled,
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.writeRemotePresence).not.toHaveBeenCalled();
    // And no job is claimed after consent is withdrawn.
    expect(deps.claimJob).not.toHaveBeenCalled();
  });

  it('does no heartbeat or poll work at all while opted out', async () => {
    const deps = makeDeps({ isEnabled: () => false });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.writeRemotePresence).not.toHaveBeenCalled();
    expect(deps.nextJob).not.toHaveBeenCalled();
    // The sweep still runs: a job stranded before the opt-out still has
    // to reach a terminal status, and it needs no Kindoo session.
    expect(deps.runningJobs).toHaveBeenCalledTimes(1);
  });

  it('polls on the slow cadence while the tab is hidden', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ isHidden: vi.fn(() => true) });
      const handle = startRemoteApplyLoop(
        { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION },
        deps,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(REMOTE_APPLY_POLL_VISIBLE_MS);
      expect(deps.nextJob).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(REMOTE_APPLY_POLL_HIDDEN_MS - REMOTE_APPLY_POLL_VISIBLE_MS);
      expect(deps.nextJob).toHaveBeenCalledTimes(2);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
