// Unit tests for the heartbeat + poll loop.
//
// Two families of case carry the weight.
//
// The heartbeat-suppression cases: the phone decides whether to offer
// "Apply via extension" purely from the freshness of a desktop doc, so
// any tick that publishes one while the desktop cannot actually drive
// Kindoo puts a button in front of the manager that fails every time
// they press it.
//
// The site-scoping cases: a manager with two Kindoo tabs on two sites of
// one stake runs two of these loops at once, and the foreground one
// polls six times as often. Nothing here may let it publish over, claim
// from, or sweep away the other tab's work.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_APPLY_HEARTBEAT_MS,
  REMOTE_APPLY_HOME_SITE_KEY,
  REMOTE_APPLY_POLL_HIDDEN_MS,
  REMOTE_APPLY_POLL_VISIBLE_MS,
} from '@kindoo/shared';
import type { KindooSite, Stake } from '@kindoo/shared';
import type {
  RemoteApplyJobRef,
  RemoteApplyRunningJobRef,
  StakeConfigBundle,
} from '../../lib/extensionApi';
import {
  REMOTE_APPLY_STRANDED_MS,
  REMOTE_APPLY_STRANDED_OTHER_SITE_MS,
  startRemoteApplyLoop,
  type RemoteApplyLoopDeps,
} from './loop';

const STAKE_ID = 'csnorth';
const EXT_VERSION = '1.2.3';
/** EID of the stake's home Kindoo site, as `kindoo_config.site_id`. */
const HOME_EID = 27994;
/** EID of a second, foreign Kindoo site the same stake manages. */
const EAST_EID = 31001;
const EAST_SITE_ID = 'east-stake';

/** Home site configured, plus one foreign site with a known EID — the
 * two-site shape every site-scoping test below needs. */
function bundle(): StakeConfigBundle {
  return {
    stake: {
      stake_id: STAKE_ID,
      stake_name: 'CS North',
      kindoo_config: { site_id: HOME_EID, site_name: 'CS North' },
    } as unknown as Stake,
    buildings: [],
    wards: [],
    kindooSites: [
      {
        id: EAST_SITE_ID,
        display_name: 'East Stake (Pine)',
        kindoo_expected_site_name: 'East Stake',
        kindoo_eid: EAST_EID,
      } as unknown as KindooSite,
    ],
  };
}

function job(overrides: Partial<RemoteApplyJobRef> = {}): RemoteApplyJobRef {
  return {
    jobId: 'j1',
    requestId: 'r1',
    stakeId: STAKE_ID,
    targetSiteKey: REMOTE_APPLY_HOME_SITE_KEY,
    ...overrides,
  };
}

function runningJob(
  claimedAtMs: number | null,
  overrides: Partial<RemoteApplyRunningJobRef> = {},
): RemoteApplyRunningJobRef {
  return { ...job(), claimedAtMs, ...overrides };
}

/** Every dep mocked; individual tests override what they exercise.
 * Defaults put the tab on the stake's HOME Kindoo site. */
function makeDeps(overrides: Partial<RemoteApplyLoopDeps> = {}) {
  let clock = 1_000_000;
  const base = {
    readSession: vi.fn(() => ({ ok: true as const, session: { token: 'tok', eid: HOME_EID } })),
    getEnvironments: vi.fn(async () => [
      { EID: HOME_EID, Name: 'CS North', TimeZone: 'Mountain Standard Time' },
      { EID: EAST_EID, Name: 'East Stake', TimeZone: 'Mountain Standard Time' },
    ]),
    writeRemotePresence: vi.fn(async () => undefined),
    queuedJobs: vi.fn(async () => [] as RemoteApplyJobRef[]),
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

  it('publishes a home-site desktop doc keyed by the reserved home key', async () => {
    const deps = makeDeps();
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.writeRemotePresence).toHaveBeenCalledWith({
      enabled: true,
      siteKey: REMOTE_APPLY_HOME_SITE_KEY,
      kindooSiteId: null,
      stakeId: STAKE_ID,
      kindooEid: HOME_EID,
      kindooSiteName: 'CS North',
      extVersion: EXT_VERSION,
    });
  });

  it('publishes a foreign-site desktop doc under that site’s own key', async () => {
    // The whole point of the per-site split: a second tab on a second
    // site writes a second doc instead of overwriting the first's EID.
    const deps = makeDeps({
      readSession: vi.fn(() => ({ ok: true as const, session: { token: 'tok', eid: EAST_EID } })),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.writeRemotePresence).toHaveBeenCalledWith({
      enabled: true,
      siteKey: EAST_SITE_ID,
      kindooSiteId: EAST_SITE_ID,
      stakeId: STAKE_ID,
      kindooEid: EAST_EID,
      kindooSiteName: 'East Stake',
      extVersion: EXT_VERSION,
    });
  });

  it('publishes nothing and claims nothing when the EID maps to no configured site', async () => {
    // The manager is inside a Kindoo site this stake doesn't manage.
    // Not an error — they legitimately visit other sites — but the tab
    // can neither name the site to the phone nor provision for it, so
    // it stays invisible rather than advertising a doomed button.
    const deps = makeDeps({
      readSession: vi.fn(() => ({ ok: true as const, session: { token: 'tok', eid: 99999 } })),
      getEnvironments: vi.fn(async () => [
        { EID: 99999, Name: 'Some Other Stake', TimeZone: 'Mountain Standard Time' },
      ]),
      queuedJobs: vi.fn(async () => [job()]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.writeRemotePresence).not.toHaveBeenCalled();
    expect(deps.queuedJobs).not.toHaveBeenCalled();
    expect(deps.claimJob).not.toHaveBeenCalled();
    // Silent-to-the-operator: info, not a console error.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('re-resolves its site when the operator switches Kindoo sites mid-period', async () => {
    // Kindoo is an SPA: the EID changes with no page load and no
    // remount. A resolution cached against the old EID would leave this
    // tab claiming the site it just left for up to a full heartbeat.
    let eid = HOME_EID;
    const deps = makeDeps({
      readSession: vi.fn(() => ({ ok: true as const, session: { token: 'tok', eid } })),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();

    eid = EAST_EID;
    deps.advance(1_000);
    await handle.tick();
    handle.stop();

    expect(deps.writeRemotePresence).toHaveBeenCalledTimes(2);
    expect(deps.writeRemotePresence).toHaveBeenLastCalledWith(
      expect.objectContaining({ siteKey: EAST_SITE_ID, kindooEid: EAST_EID }),
    );
  });

  it('reports each published site key so opt-out knows which doc to clear', async () => {
    const onSitePublished = vi.fn();
    const deps = makeDeps();
    const handle = start(deps, {
      stakeId: STAKE_ID,
      bundle: bundle(),
      extVersion: EXT_VERSION,
      onSitePublished,
    });
    await handle.tick();
    handle.stop();

    expect(onSitePublished).toHaveBeenCalledWith(REMOTE_APPLY_HOME_SITE_KEY);
  });

  it('does not report a site key when the presence write failed', async () => {
    // There is nothing to delete for a heartbeat that never landed.
    const onSitePublished = vi.fn();
    const deps = makeDeps({
      writeRemotePresence: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const handle = start(deps, {
      stakeId: STAKE_ID,
      bundle: bundle(),
      extVersion: EXT_VERSION,
      onSitePublished,
    });
    await expect(handle.tick()).rejects.toThrow('offline');
    handle.stop();

    expect(onSitePublished).not.toHaveBeenCalled();
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
    expect(deps.queuedJobs).not.toHaveBeenCalled();
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
    expect(deps.queuedJobs).not.toHaveBeenCalled();
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
    expect(deps.queuedJobs).toHaveBeenCalledTimes(3);
  });

  it('claims a queued job, runs it, and writes the terminal status', async () => {
    const onJobStart = vi.fn();
    const onJobEnd = vi.fn();
    const deps = makeDeps({ queuedJobs: vi.fn(async () => [job()]) });
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
      queuedJobs: vi.fn(async () => [job()]),
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
    const deps = makeDeps({ queuedJobs: vi.fn(async () => [job({ stakeId: 'other-stake' })]) });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.claimJob).not.toHaveBeenCalled();
    expect(deps.runJob).not.toHaveBeenCalled();
  });

  // ---- Site-scoped claiming: the two-tab regression ------------------

  it('claims only its own site’s job from a two-site queue, and leaves the other', async () => {
    // The operator's bug. Two tabs, two sites, one stake. The visible
    // tab polls every 10s and the hidden one every 60s, so without a
    // site filter the foreground tab takes essentially everything —
    // then fails the sibling's work with "switch Kindoo sites and try
    // again", which is nonsense advice when that site is open next door.
    const deps = makeDeps({
      queuedJobs: vi.fn(async () => [
        job({ jobId: 'east', requestId: 'r-east', targetSiteKey: EAST_SITE_ID }),
        job({ jobId: 'home', requestId: 'r-home', targetSiteKey: REMOTE_APPLY_HOME_SITE_KEY }),
      ]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    // The home tab looks PAST the east job rather than stalling on it —
    // a limit(1) poll would have taken the east job or blocked forever.
    expect(deps.claimJob).toHaveBeenCalledTimes(1);
    expect(deps.claimJob).toHaveBeenCalledWith('home', EXT_VERSION, HOME_EID);
  });

  it('claims the sibling site’s job from the tab that is actually on that site', async () => {
    const deps = makeDeps({
      readSession: vi.fn(() => ({ ok: true as const, session: { token: 'tok', eid: EAST_EID } })),
      queuedJobs: vi.fn(async () => [
        job({ jobId: 'home', requestId: 'r-home', targetSiteKey: REMOTE_APPLY_HOME_SITE_KEY }),
        job({ jobId: 'east', requestId: 'r-east', targetSiteKey: EAST_SITE_ID }),
      ]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.claimJob).toHaveBeenCalledTimes(1);
    expect(deps.claimJob).toHaveBeenCalledWith('east', EXT_VERSION, EAST_EID);
  });

  it('logs a skipped job at info, not warn', async () => {
    // Leaving a sibling tab's work alone is the feature working. A warn
    // here would cry wolf on every poll of a healthy two-tab setup.
    const deps = makeDeps({
      queuedJobs: vi.fn(async () => [job({ jobId: 'east', targetSiteKey: EAST_SITE_ID })]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.claimJob).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('leaving job east'));
  });

  it('clears the running flag even when finishing the job throws', async () => {
    const onJobEnd = vi.fn();
    const deps = makeDeps({
      queuedJobs: vi.fn(async () => [job()]),
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
      expect(deps.queuedJobs).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.queuedJobs).toHaveBeenCalledTimes(1);

      // Visible tab → 10s cadence.
      await vi.advanceTimersByTimeAsync(REMOTE_APPLY_POLL_VISIBLE_MS);
      expect(deps.queuedJobs).toHaveBeenCalledTimes(2);

      handle.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(deps.queuedJobs).toHaveBeenCalledTimes(2);
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
    const deps = makeDeps({ queuedJobs: vi.fn(async () => [job()]), finishJob });
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
    const deps = makeDeps({ queuedJobs: vi.fn(async () => [job()]), finishJob });
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
    // Two ticks, because the sweep runs ahead of site resolution on
    // purpose (it must survive a dead Kindoo session) — so the very
    // first sweep after a page load has no site yet and holds
    // everything to the longer threshold. The second, one sweep
    // interval later, has one.
    await handle.tick();
    deps.advance(120_000);
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

  it('does NOT sweep another site’s running job at the same-site threshold', async () => {
    // The regression. The sibling tab may be genuinely mid-provision;
    // finalising its job writes "check on your desktop" over work that
    // is completing, and blocks the sibling's own terminal write.
    const deps = makeDeps({
      runningJobs: vi.fn(async () => [
        runningJob(1_000_000 - REMOTE_APPLY_STRANDED_MS - 1, {
          jobId: 'east',
          targetSiteKey: EAST_SITE_ID,
        }),
      ]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.finishJob).not.toHaveBeenCalled();
  });

  it('eventually sweeps another site’s job, at the longer threshold', async () => {
    // A filter alone would be worse than no filter: the likeliest way a
    // job strands is that the manager CLOSED the tab on its site, so
    // requiring a tab on that site to clean up requires the thing that
    // just failed to happen — and the phone would spin forever.
    const deps = makeDeps({
      runningJobs: vi.fn(async () => [
        runningJob(1_000_000 - REMOTE_APPLY_STRANDED_OTHER_SITE_MS - 1, {
          jobId: 'east',
          targetSiteKey: EAST_SITE_ID,
        }),
      ]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.finishJob).toHaveBeenCalledTimes(1);
    expect(deps.finishJob.mock.calls[0]?.[0]).toBe('east');
  });

  it('sweeps a stranded job from another stake, at the longer threshold', async () => {
    const deps = makeDeps({
      runningJobs: vi.fn(async () => [
        runningJob(1_000_000 - REMOTE_APPLY_STRANDED_OTHER_SITE_MS - 1, { stakeId: 'other-stake' }),
      ]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.finishJob).toHaveBeenCalledTimes(1);
  });

  it('holds a tab that hasn’t resolved a site to the longer threshold', async () => {
    // No resolved site ⇒ this tab can serve nothing, so it has no
    // standing to claim the prompt sweep for anything.
    const deps = makeDeps({
      readSession: vi.fn(() => ({ ok: false as const, error: 'no-eid' as const })),
      runningJobs: vi
        .fn<RemoteApplyLoopDeps['runningJobs']>()
        .mockResolvedValueOnce([runningJob(1_000_000 - REMOTE_APPLY_STRANDED_MS - 1)])
        .mockResolvedValue([runningJob(1_000_000 - REMOTE_APPLY_STRANDED_OTHER_SITE_MS - 1)]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    expect(deps.finishJob).not.toHaveBeenCalled();

    deps.advance(120_000);
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
      queuedJobs: vi
        .fn<RemoteApplyLoopDeps['queuedJobs']>()
        .mockResolvedValueOnce([job()])
        .mockResolvedValue([]),
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
    expect(deps.queuedJobs).not.toHaveBeenCalled();
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
      expect(deps.queuedJobs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(REMOTE_APPLY_POLL_HIDDEN_MS - REMOTE_APPLY_POLL_VISIBLE_MS);
      expect(deps.queuedJobs).toHaveBeenCalledTimes(2);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
