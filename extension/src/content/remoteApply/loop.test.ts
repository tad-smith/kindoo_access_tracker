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
import type { RemoteApplyJobRef, StakeConfigBundle } from '../../lib/extensionApi';
import { startRemoteApplyLoop, type RemoteApplyLoopDeps } from './loop';

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
    claimJob: vi.fn(async () => true),
    finishJob: vi.fn(async () => undefined),
    runJob: vi.fn(async () => ({
      status: 'applied' as const,
      outcome: { code: 'applied' as const, message: 'done' },
    })),
    now: vi.fn(() => clock),
    isHidden: vi.fn(() => false),
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
