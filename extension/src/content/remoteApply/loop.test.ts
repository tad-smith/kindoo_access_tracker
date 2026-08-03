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
  REMOTE_APPLY_PICKUP_TIMEOUT_MS,
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
/** Where `makeDeps`'s mock clock starts. Job ages are expressed against
 * it so a test can put a job either side of the pickup window. */
const NOW = 1_000_000;
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
    // Queued just now, i.e. well inside the pickup window.
    createdAtMs: NOW,
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
  let clock = NOW;
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
    isContextAlive: vi.fn(() => true),
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
    // And the Kindoo call that feeds the heartbeat is rate-limited with
    // it. Asserting on the presence write alone would miss a loop that
    // re-resolved on every tick and merely declined to publish.
    expect(deps.getEnvironments).toHaveBeenCalledTimes(2);
  });

  // ---- Kindoo call budget while the site can't be resolved -----------
  //
  // `getEnvironments` is a POST to a third party's server. A tab that
  // cannot resolve its site is a resting state, not a transient one, so
  // "re-resolve while unresolved" is an unbounded retry loop at the poll
  // cadence — 10s apart on a visible tab, for as long as it stays open.

  it('calls getEnvironments at most once per heartbeat period when the Kindoo session is dead', async () => {
    // An expired Kindoo token still reads `ok` from `readKindooSession`
    // (it only proves a token string exists), so this tab keeps ticking
    // and keeps failing to resolve.
    const deps = makeDeps({
      getEnvironments: vi.fn(async () => {
        throw new Error('401 Unauthorized');
      }),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });

    await handle.tick();
    deps.advance(REMOTE_APPLY_POLL_VISIBLE_MS);
    await handle.tick();
    deps.advance(REMOTE_APPLY_POLL_VISIBLE_MS);
    await handle.tick();
    expect(deps.getEnvironments).toHaveBeenCalledTimes(1);

    deps.advance(REMOTE_APPLY_HEARTBEAT_MS);
    await handle.tick();
    handle.stop();
    expect(deps.getEnvironments).toHaveBeenCalledTimes(2);
  });

  it('calls getEnvironments at most once per heartbeat period when the EID maps to no site', async () => {
    // The manager clicked into a Kindoo site this stake doesn't manage.
    // Perfectly ordinary, and it persists for as long as they stay there.
    const deps = makeDeps({
      readSession: vi.fn(() => ({ ok: true as const, session: { token: 'tok', eid: 99999 } })),
      getEnvironments: vi.fn(async () => [
        { EID: 99999, Name: 'Some Other Stake', TimeZone: 'Mountain Standard Time' },
      ]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });

    await handle.tick();
    deps.advance(REMOTE_APPLY_POLL_VISIBLE_MS);
    await handle.tick();
    deps.advance(REMOTE_APPLY_POLL_VISIBLE_MS);
    await handle.tick();
    expect(deps.getEnvironments).toHaveBeenCalledTimes(1);

    deps.advance(REMOTE_APPLY_HEARTBEAT_MS);
    await handle.tick();
    handle.stop();
    expect(deps.getEnvironments).toHaveBeenCalledTimes(2);
  });

  it('re-resolves at once when the operator leaves a site that could not be resolved', async () => {
    // The retry window must not swallow a genuine change of site — that
    // is new information, not a retry, and waiting on it would leave the
    // phone unable to see a desktop that is now usable.
    let eid = 99999;
    const deps = makeDeps({
      readSession: vi.fn(() => ({ ok: true as const, session: { token: 'tok', eid } })),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });

    await handle.tick();
    expect(deps.writeRemotePresence).not.toHaveBeenCalled();

    eid = HOME_EID;
    deps.advance(1_000);
    await handle.tick();
    handle.stop();

    expect(deps.getEnvironments).toHaveBeenCalledTimes(2);
    expect(deps.writeRemotePresence).toHaveBeenCalledTimes(1);
  });

  it('recovers on its own once the Kindoo session comes back', async () => {
    // The flip side of the retry window: it is a cap, not a shutdown.
    const getEnvironments = vi
      .fn<RemoteApplyLoopDeps['getEnvironments']>()
      .mockRejectedValueOnce(new Error('401 Unauthorized'))
      .mockResolvedValue([{ EID: HOME_EID, Name: 'CS North', TimeZone: 'Mountain Standard Time' }]);
    const deps = makeDeps({ getEnvironments });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });

    await handle.tick();
    expect(deps.writeRemotePresence).not.toHaveBeenCalled();

    deps.advance(REMOTE_APPLY_HEARTBEAT_MS);
    await handle.tick();
    handle.stop();
    expect(deps.writeRemotePresence).toHaveBeenCalledTimes(1);
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

  // ---- Pickup expiry: the unattended-provision regression -------------
  //
  // The phone's 90s pickup timeout lives in a React effect in a browser
  // tab. On a phone that tab is suspended by a screen lock and killed by
  // a close, so it cannot be the only thing that expires a `queued` job.
  // Without a desktop-side backstop the manager taps Apply, pockets the
  // phone, and the poller provisions the request unattended whenever
  // Kindoo next opens — hours or a day later.

  it('cancels a job that sat queued past the pickup window instead of claiming it', async () => {
    const deps = makeDeps({
      queuedJobs: vi.fn(async () => [job({ createdAtMs: NOW - REMOTE_APPLY_PICKUP_TIMEOUT_MS })]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.claimJob).not.toHaveBeenCalled();
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(deps.finishJob).toHaveBeenCalledTimes(1);
    const [jobId, payload] = deps.finishJob.mock.calls[0] ?? [];
    expect(jobId).toBe('j1');
    expect(payload?.status).toBe('cancelled');
    // Unlike a stranded job, an expired one demonstrably never ran, so
    // the message may say so — and must, since that is what makes
    // re-applying safe rather than licence-burning.
    expect(payload?.outcome.message).toMatch(/Nothing was changed in Kindoo/);
  });

  it('still claims a job on the last tick before the pickup window closes', async () => {
    // The other half of the boundary. An over-eager expiry would cancel
    // work the manager is watching their phone for.
    const deps = makeDeps({
      queuedJobs: vi.fn(async () => [
        job({ createdAtMs: NOW - REMOTE_APPLY_PICKUP_TIMEOUT_MS + 1 }),
      ]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.claimJob).toHaveBeenCalledWith('j1', EXT_VERSION, HOME_EID);
    expect(deps.finishJob).toHaveBeenCalledWith('j1', {
      status: 'applied',
      outcome: { code: 'applied', message: 'done' },
    });
  });

  it('cancels an expired job for a site it cannot serve', async () => {
    // Staleness is a fact about the job, not about this tab. The tab
    // that could have served it is the one most likely to be closed —
    // that is HOW the job went stale — so a `canServe` gate here would
    // leave the commonest case to the tab that just failed to exist.
    const deps = makeDeps({
      queuedJobs: vi.fn(async () => [
        job({
          jobId: 'east',
          targetSiteKey: EAST_SITE_ID,
          createdAtMs: NOW - REMOTE_APPLY_PICKUP_TIMEOUT_MS - 1,
        }),
      ]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.claimJob).not.toHaveBeenCalled();
    expect(deps.finishJob.mock.calls[0]?.[0]).toBe('east');
    expect(deps.finishJob.mock.calls[0]?.[1].status).toBe('cancelled');
  });

  it('claims the fresh job behind an expired one in the same page', async () => {
    // Expiring must not consume the poll: a stale job is not a reason to
    // leave real work sitting for another 10 seconds.
    const deps = makeDeps({
      queuedJobs: vi.fn(async () => [
        job({
          jobId: 'stale',
          requestId: 'r-stale',
          createdAtMs: NOW - REMOTE_APPLY_PICKUP_TIMEOUT_MS - 1,
        }),
        job({ jobId: 'fresh', requestId: 'r-fresh' }),
      ]),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.finishJob.mock.calls[0]?.[0]).toBe('stale');
    expect(deps.claimJob).toHaveBeenCalledTimes(1);
    expect(deps.claimJob).toHaveBeenCalledWith('fresh', EXT_VERSION, HOME_EID);
  });

  it('leaves a queued job with no readable creation time claimable', async () => {
    // Opposite lean to the stranded sweep, and deliberately: a missing
    // age here would license cancelling work tapped seconds ago and
    // telling the manager their desktop ignored them.
    const deps = makeDeps({ queuedJobs: vi.fn(async () => [job({ createdAtMs: null })]) });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    expect(deps.claimJob).toHaveBeenCalledTimes(1);
    expect(deps.finishJob.mock.calls[0]?.[1].status).toBe('applied');
  });

  it('treats a lost cancel race as the system working, not a fault', async () => {
    // A sibling tab claimed it between the query and the write, so the
    // rules' before-status check rejects ours. Nothing is wrong.
    const deps = makeDeps({
      queuedJobs: vi.fn(async () => [
        job({ createdAtMs: NOW - REMOTE_APPLY_PICKUP_TIMEOUT_MS - 1 }),
      ]),
      finishJob: vi
        .fn<RemoteApplyLoopDeps['finishJob']>()
        .mockRejectedValue(Object.assign(new Error('denied'), { code: 'permission-denied' })),
    });
    const handle = start(deps, { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION });
    await handle.tick();
    handle.stop();

    // One attempt, no retry loop, and the tick survives.
    expect(deps.finishJob).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('moved on before'));
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

  // ---- Orphaned by an extension reload --------------------------------
  //
  // Reloading or updating the extension leaves the previous build's
  // content script running in every open Kindoo page with `chrome.runtime`
  // severed. Every message throws from then on, and nothing recovers
  // short of reloading the page. Read as an ordinary tick failure — which
  // is exactly what it looks like — the loop goes on ticking in the dead
  // page and logs a failure every 10 seconds until the tab is closed, in
  // every tab, after every extension update.

  /** Every dep that rides `chrome.runtime.sendMessage`, failing the way
   * Chrome fails them in an orphaned content script. */
  function orphanedDeps(overrides: Partial<RemoteApplyLoopDeps> = {}) {
    const severed = async (): Promise<never> => {
      throw new Error('Extension context invalidated.');
    };
    return makeDeps({
      // Track the fake clock, so the 60s sweep really does come round
      // again and the per-tick accumulation is the thing under test.
      now: () => Date.now(),
      writeRemotePresence: vi.fn(severed),
      queuedJobs: vi.fn(severed),
      runningJobs: vi.fn(severed),
      claimJob: vi.fn(severed),
      finishJob: vi.fn(severed),
      ...overrides,
    });
  }

  it('stops the loop and says so once when an extension reload orphans the page', async () => {
    vi.useFakeTimers();
    try {
      const deps = orphanedDeps({ isContextAlive: vi.fn(() => false) });
      const handle = startRemoteApplyLoop(
        { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION },
        deps,
      );
      await vi.advanceTimersByTimeAsync(0);
      // Five minutes of a tab the operator left open: 30 poll ticks and
      // five sweep intervals, every one of which used to log.
      await vi.advanceTimersByTimeAsync(300_000);
      handle.stop();

      // The symptom: one line for the whole episode, not one per tick.
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledTimes(1);
      expect(console.info).toHaveBeenCalledWith(expect.stringContaining('reload the page'));
      // `chrome.runtime.id` is read before anything is sent, so not one
      // doomed round-trip is attempted.
      expect(deps.runningJobs).not.toHaveBeenCalled();
      expect(deps.queuedJobs).not.toHaveBeenCalled();
      expect(deps.writeRemotePresence).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recognises the orphan from the thrown error when the runtime id still reads live', async () => {
    // The fallback half. The probe is the primary signal precisely
    // because it cannot be reworded by a Chrome release — but if it ever
    // reports a severed context as live, the message must still end the
    // loop rather than leaving it logging forever.
    vi.useFakeTimers();
    try {
      const deps = orphanedDeps({ isContextAlive: vi.fn(() => true) });
      const handle = startRemoteApplyLoop(
        { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION },
        deps,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(300_000);
      handle.stop();

      expect(console.warn).not.toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledTimes(1);
      expect(console.info).toHaveBeenCalledWith(expect.stringContaining('reload the page'));
      // One tick's worth of discovery — the sweep runs first, throws,
      // and the loop is over before the heartbeat or the poll.
      expect(deps.runningJobs).toHaveBeenCalledTimes(1);
      expect(deps.queuedJobs).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps ticking through an ordinary failure, warning each time', async () => {
    // The counterweight. Only a severed context ends the loop: a
    // Firestore blip or a rules rejection must leave it running, or one
    // bad minute takes the desktop off the phone's radar until the
    // manager happens to reload Kindoo.
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        queuedJobs: vi.fn(async (): Promise<never> => {
          throw new Error('Missing or insufficient permissions');
        }),
      });
      const handle = startRemoteApplyLoop(
        { stakeId: STAKE_ID, bundle: bundle(), extVersion: EXT_VERSION },
        deps,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(REMOTE_APPLY_POLL_VISIBLE_MS * 3);
      handle.stop();

      expect(deps.queuedJobs).toHaveBeenCalledTimes(4);
      expect(console.warn).toHaveBeenCalledTimes(4);
      expect(console.warn).toHaveBeenLastCalledWith(
        '[sba-ext] remote apply: tick failed',
        expect.any(Error),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
