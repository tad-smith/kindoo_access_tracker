// Unit lane for the hourly dispatcher — fake Firestore, fake enqueuer,
// fixture registry, no emulator. The emulator-backed counterpart
// (`tests/dispatchScheduledTasks.test.ts`) proves the same seeding,
// selection and stamping against real Firestore.
//
// Neither lane proves Cloud Scheduler firing the function or real Cloud
// Tasks id deduplication; both are first exercised on staging.

import { describe, expect, it, vi } from 'vitest';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import type { ScheduledTask, StakeSchedule } from '@kindoo/shared';
import type { JobRegistry } from '../lib/taskRegistry.js';
import {
  DISPATCHER_ACTOR,
  DISPATCH_DONE_MESSAGE,
  dispatchDue,
  dispatchScheduledTasks,
  scheduledTaskId,
  type EnqueueTask,
  type ScheduledTaskPayload,
} from './dispatchScheduledTasks.js';

const NOW = new Date('2026-09-05T14:00:00.000Z');
const TZ = 'America/Denver';

/** A registry whose handlers are never called here — dispatch only enqueues. */
function registry(overrides: Partial<JobRegistry> = {}): JobRegistry {
  return {
    demo: {
      handler: async () => undefined,
      defaultSchedule: { type: 'daily', hour: 6 },
      defaultEnabled: false,
    },
    ...overrides,
  };
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    job: 'demo',
    enabled: true,
    schedule: { type: 'daily', hour: 6 },
    ...overrides,
  };
}

/** `next_trigger_time` value for an instant. */
const at = (iso: string): Timestamp => Timestamp.fromDate(new Date(iso));

type FakeDb = {
  db: Firestore;
  /** Every `set()` that landed, keyed by doc path. */
  writes: Record<string, StakeSchedule>;
  /** Ordered log of side effects, for proving enqueue-before-stamp. */
  events: string[];
  /** The live store, so a test can write to it mid-dispatch. */
  schedules: Record<string, StakeSchedule>;
};

/**
 * A fake Firestore that is *stateful*: a `set` lands back in the store
 * the next `get` reads, and `runTransaction` re-reads through it. That
 * is what lets a test simulate a manager writing between the
 * dispatcher's read and its commit — the whole point of the commit
 * being a transaction.
 */
function makeDb(
  stakes: { id: string; timezone?: string }[],
  schedules: Record<string, StakeSchedule> = {},
  failReadsFor: string[] = [],
): FakeDb {
  const writes: Record<string, StakeSchedule> = {};
  const events: string[] = [];
  const stakeIdOf = (path: string): string => path.replace('stakeSchedules/', '');
  const read = (path: string) => {
    const stakeId = stakeIdOf(path);
    if (failReadsFor.includes(stakeId)) throw new Error(`boom reading ${path}`);
    const data = schedules[stakeId];
    return { exists: data !== undefined, data: () => data };
  };
  const write = (path: string, value: StakeSchedule): void => {
    events.push(`set:${path}`);
    writes[path] = value;
    schedules[stakeIdOf(path)] = value;
  };
  const doc = (path: string) => ({
    path,
    get: async () => read(path),
    set: async (value: StakeSchedule) => write(path, value),
  });
  const db = {
    collection: (path: string) => {
      if (path !== 'stakes') throw new Error(`unexpected collection: ${path}`);
      return {
        get: async () => ({
          size: stakes.length,
          docs: stakes.map((s) => ({
            id: s.id,
            data: () => ({ timezone: s.timezone ?? TZ }),
          })),
        }),
      };
    },
    doc,
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: async (ref: { path: string }) => read(ref.path),
        set: (ref: { path: string }, value: StakeSchedule) => write(ref.path, value),
      }),
  } as unknown as Firestore;
  return { db, writes, events, schedules };
}

/** Enqueuer that records calls (and optionally throws) against the shared event log. */
function makeEnqueue(
  events: string[],
  behaviour: (payload: ScheduledTaskPayload) => void = () => {},
): { enqueue: EnqueueTask; calls: { payload: ScheduledTaskPayload; id: string }[] } {
  const calls: { payload: ScheduledTaskPayload; id: string }[] = [];
  const enqueue: EnqueueTask = async (payload, id) => {
    events.push(`enqueue:${payload.stakeId}/${payload.job}`);
    calls.push({ payload, id });
    behaviour(payload);
  };
  return { enqueue, calls };
}

describe('scheduledTaskId', () => {
  it('buckets by UTC hour so two runs in the same hour collide', () => {
    expect(scheduledTaskId('csnorth', 'syncReminder', new Date('2026-09-05T14:03:00.000Z'))).toBe(
      'csnorth--syncReminder--20260905T14',
    );
    expect(scheduledTaskId('csnorth', 'syncReminder', new Date('2026-09-05T14:59:59.000Z'))).toBe(
      'csnorth--syncReminder--20260905T14',
    );
    expect(scheduledTaskId('csnorth', 'syncReminder', new Date('2026-09-05T15:00:00.000Z'))).toBe(
      'csnorth--syncReminder--20260905T15',
    );
  });

  it('sanitises to the Cloud Tasks id charset', () => {
    expect(scheduledTaskId('stake.with/odd chars', 'a job', NOW)).toBe(
      'stake_with_odd_chars--a_job--20260905T14',
    );
  });
});

describe('dispatchDue — self-seeding', () => {
  it('creates the schedule doc with an entry per registry job', async () => {
    const { db, writes } = makeDb([{ id: 'csnorth' }]);
    const { enqueue, calls } = makeEnqueue([]);

    const summary = await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    expect(summary).toMatchObject({ stakes: 1, seeded: 1, enqueued: 0, failures: 0 });
    const doc = writes['stakeSchedules/csnorth'];
    expect(doc?.lastActor).toEqual(DISPATCHER_ACTOR);
    expect(doc?.tasks).toHaveLength(1);
    expect(doc?.tasks[0]).toMatchObject({ job: 'demo', enabled: false });
    // Seeded tasks get a slot immediately, so nothing relies on the
    // absent-reads-as-due fallback.
    expect(doc?.tasks[0]?.next_trigger_time?.toDate().toISOString()).toBe(
      '2026-09-06T12:00:00.000Z', // 06:00 Denver, the day after `now`
    );
    // Seeded disabled, so nothing fires on the seeding pass.
    expect(calls).toHaveLength(0);
  });

  it('seeds `enabled` from the registry rather than assuming on', async () => {
    const { db, writes } = makeDb([{ id: 'csnorth' }]);
    const { enqueue } = makeEnqueue([]);
    const optIn = registry({
      demo: {
        handler: async () => undefined,
        defaultSchedule: { type: 'hourly' },
        defaultEnabled: true,
      },
    });

    await dispatchDue(db, { registry: optIn, enqueue, now: NOW });

    expect(writes['stakeSchedules/csnorth']?.tasks[0]?.enabled).toBe(true);
  });

  it('never resurrects or rewrites an existing entry', async () => {
    const disabled = task({
      enabled: false,
      schedule: { type: 'weekly', weekday: 2, hour: 9 },
      next_trigger_time: at('2020-01-01T00:00:00.000Z'),
    });
    const { db, writes } = makeDb([{ id: 'csnorth' }], {
      csnorth: { tasks: [disabled], lastActor: DISPATCHER_ACTOR },
    });
    const { enqueue, calls } = makeEnqueue([]);

    const summary = await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    // Nothing seeded, nothing fired, so nothing written at all — a
    // manager's `enabled: false` survives every dispatch untouched.
    expect(summary).toMatchObject({ seeded: 0, enqueued: 0 });
    expect(writes).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('adds only the missing jobs when a stake already has some', async () => {
    const { db, writes } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        tasks: [task({ enabled: false, next_trigger_time: at('2026-09-06T12:00:00.000Z') })],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue } = makeEnqueue([]);
    const two = registry({
      other: {
        handler: async () => undefined,
        defaultSchedule: { type: 'hourly' },
        defaultEnabled: false,
      },
    });

    const summary = await dispatchDue(db, { registry: two, enqueue, now: NOW });

    expect(summary.seeded).toBe(1);
    expect(writes['stakeSchedules/csnorth']?.tasks.map((t) => t.job)).toEqual(['demo', 'other']);
  });
});

describe('dispatchDue — selection and stamping', () => {
  it('enqueues a due task and stamps both timestamps', async () => {
    const { db, writes } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        tasks: [task({ next_trigger_time: at('2026-09-05T12:00:00.000Z') })],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue, calls } = makeEnqueue([]);

    const summary = await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    expect(summary).toMatchObject({ enqueued: 1, deduped: 0, failures: 0 });
    expect(calls).toEqual([
      { payload: { stakeId: 'csnorth', job: 'demo' }, id: 'csnorth--demo--20260905T14' },
    ]);
    const stamped = writes['stakeSchedules/csnorth']?.tasks[0];
    expect(stamped?.last_trigger_time?.toDate().toISOString()).toBe(NOW.toISOString());
    // Advanced from the STORED slot, not from `now` — 06:00 Denver the
    // following day.
    expect(stamped?.next_trigger_time?.toDate().toISOString()).toBe('2026-09-06T12:00:00.000Z');
  });

  it('leaves a task alone when its slot is still ahead', async () => {
    const { db, writes } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        tasks: [task({ next_trigger_time: at('2026-09-06T12:00:00.000Z') })],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue, calls } = makeEnqueue([]);

    await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    expect(calls).toHaveLength(0);
    expect(writes).toEqual({});
  });

  it('skips a disabled task whose slot has passed', async () => {
    const { db } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        tasks: [task({ enabled: false, next_trigger_time: at('2026-09-01T12:00:00.000Z') })],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue, calls } = makeEnqueue([]);

    await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    expect(calls).toHaveLength(0);
  });

  it('enqueues before it stamps, so a crash between the two re-fires rather than skipping', async () => {
    const { db, events } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        tasks: [task({ next_trigger_time: at('2026-09-05T12:00:00.000Z') })],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue } = makeEnqueue(events);

    await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    expect(events).toEqual(['enqueue:csnorth/demo', 'set:stakeSchedules/csnorth']);
  });

  it('fires a task once after many missed windows instead of replaying them', async () => {
    const { db, writes } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        tasks: [
          task({
            schedule: { type: 'hourly' },
            next_trigger_time: at('2026-09-01T06:17:00.000Z'),
          }),
        ],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue, calls } = makeEnqueue([]);

    await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    expect(calls).toHaveLength(1);
    // The first slot after `now`, not the ~100 windows in between. The
    // stale value sat at :17; hourly slots snap to the top of the hour,
    // so catching up also re-anchors an off-phase stored value.
    expect(
      writes['stakeSchedules/csnorth']?.tasks[0]?.next_trigger_time?.toDate().toISOString(),
    ).toBe('2026-09-05T15:00:00.000Z');
  });
});

describe('dispatchDue — concurrent client writes', () => {
  // The seam every test here uses: `enqueue` runs after the dispatcher
  // has read the schedule doc and before it commits, so writing to the
  // store from inside it lands exactly in the window a manager's toggle
  // would land in. Against the old whole-array `set(..., {merge:true})`
  // every one of these was silently reverted.

  it("preserves a manager's `enabled: false` written mid-dispatch", async () => {
    const due = task({ next_trigger_time: at('2026-09-05T12:00:00.000Z') });
    const { db, writes, schedules } = makeDb([{ id: 'csnorth' }], {
      csnorth: { tasks: [due], lastActor: DISPATCHER_ACTOR },
    });
    const { enqueue, calls } = makeEnqueue([], () => {
      // The manager's toggle: a whole-array rewrite, which is all a
      // client can do to a Firestore list.
      schedules['csnorth'] = {
        tasks: [{ ...due, enabled: false }],
        lastActor: { email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' },
      };
    });

    await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    // The task was already enqueued — that is at-least-once and is not
    // what this test is about. What must survive is the toggle.
    expect(calls).toHaveLength(1);
    const written = writes['stakeSchedules/csnorth'];
    expect(written?.tasks[0]?.enabled).toBe(false);
    // ...and the stamp still lands, so the row doesn't stay due forever
    // if the manager turns it back on.
    expect(written?.tasks[0]?.last_trigger_time?.toDate().toISOString()).toBe(NOW.toISOString());
    expect(written?.tasks[0]?.next_trigger_time?.toDate().toISOString()).toBe(
      '2026-09-06T12:00:00.000Z',
    );
  });

  it('keeps a concurrently changed `schedule` rather than restoring the one it read', async () => {
    const due = task({ next_trigger_time: at('2026-09-05T12:00:00.000Z') });
    const { db, writes, schedules } = makeDb([{ id: 'csnorth' }], {
      csnorth: { tasks: [due], lastActor: DISPATCHER_ACTOR },
    });
    const { enqueue } = makeEnqueue([], () => {
      schedules['csnorth'] = {
        tasks: [{ ...due, schedule: { type: 'weekly', weekday: 2, hour: 9 } }],
        lastActor: DISPATCHER_ACTOR,
      };
    });

    await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    // The commit re-applies only the two timestamps it computed. The
    // new shape governs the run after this one — this pass's
    // `next_trigger_time` was already computed from the old one, which
    // re-bases itself an hour later at worst.
    expect(writes['stakeSchedules/csnorth']?.tasks[0]?.schedule).toEqual({
      type: 'weekly',
      weekday: 2,
      hour: 9,
    });
  });

  it('does not resurrect a row removed mid-dispatch just to carry its stamp', async () => {
    const due = task({ next_trigger_time: at('2026-09-05T12:00:00.000Z') });
    const { db, writes, schedules } = makeDb([{ id: 'csnorth' }], {
      csnorth: { tasks: [due], lastActor: DISPATCHER_ACTOR },
    });
    const { enqueue } = makeEnqueue([], () => {
      schedules['csnorth'] = { tasks: [], lastActor: DISPATCHER_ACTOR };
    });

    await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    // Its handler ran, but the row is gone. Re-adding it to hold a
    // timestamp would undo a deliberate removal; the next pass re-seeds
    // it disabled, which is the documented behaviour for a missing row.
    expect(writes['stakeSchedules/csnorth']?.tasks).toEqual([]);
  });

  it('does not double-seed a row another writer added mid-dispatch', async () => {
    const due = task({ next_trigger_time: at('2026-09-05T12:00:00.000Z') });
    const other = task({ job: 'other', enabled: false, schedule: { type: 'hourly' } });
    const { db, writes, schedules } = makeDb([{ id: 'csnorth' }], {
      csnorth: { tasks: [due], lastActor: DISPATCHER_ACTOR },
    });
    const { enqueue } = makeEnqueue([], () => {
      // An overlapping dispatch (or a manager) seeds `other` first.
      schedules['csnorth'] = { tasks: [due, other], lastActor: DISPATCHER_ACTOR };
    });
    const two = registry({
      other: {
        handler: async () => undefined,
        defaultSchedule: { type: 'daily', hour: 6 },
        defaultEnabled: false,
      },
    });

    await dispatchDue(db, { registry: two, enqueue, now: NOW });

    // Seeding is re-checked against the array as it stands at commit,
    // not the one it ran against.
    expect(writes['stakeSchedules/csnorth']?.tasks.map((t) => t.job)).toEqual(['demo', 'other']);
    expect(writes['stakeSchedules/csnorth']?.tasks[1]?.schedule).toEqual({ type: 'hourly' });
  });
});

describe('dispatchDue — failure handling', () => {
  it('skips an unparseable row without stranding its siblings', async () => {
    const { db, writes } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        tasks: [
          null as unknown as ScheduledTask,
          task({ next_trigger_time: at('2026-09-05T12:00:00.000Z') }),
        ],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue, calls } = makeEnqueue([]);

    const summary = await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    // Reading `.job` off the null row used to throw into the per-stake
    // handler, which skips the write — so the healthy sibling below it
    // enqueued and then lost its stamp, and re-fired every hour.
    expect(calls).toHaveLength(1);
    expect(summary).toMatchObject({ enqueued: 1, failures: 1 });
    expect(writes['stakeSchedules/csnorth']?.tasks[1]?.last_trigger_time).toBeDefined();
  });

  it('skips a due task whose schedule shape is unusable, without enqueuing it', async () => {
    const { db } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        tasks: [
          task({
            schedule: { type: 'yearly' } as unknown as ScheduledTask['schedule'],
            next_trigger_time: at('2026-09-05T12:00:00.000Z'),
          }),
        ],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue, calls } = makeEnqueue([]);

    const summary = await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    // Not enqueued at all — advancing it would throw after the handler
    // had already been queued, re-running it every hour.
    expect(calls).toHaveLength(0);
    expect(summary).toMatchObject({ enqueued: 0, failures: 1 });
  });

  it('does not let one unusable row strand its siblings’ stamps', async () => {
    const { db, writes } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        tasks: [
          task({
            schedule: { type: 'yearly' } as unknown as ScheduledTask['schedule'],
            next_trigger_time: at('2026-09-05T12:00:00.000Z'),
          }),
          task({ job: 'other', next_trigger_time: at('2026-09-05T12:00:00.000Z') }),
        ],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue, calls } = makeEnqueue([]);

    await dispatchDue(db, {
      registry: registry({
        other: {
          handler: async () => undefined,
          defaultSchedule: { type: 'daily', hour: 6 },
          defaultEnabled: false,
        },
      }),
      enqueue,
      now: NOW,
    });

    // The healthy sibling enqueued AND stamped. Before the per-task
    // guard the bad row threw into the per-stake handler, which skips
    // the write, so this stamp was lost and 'other' re-fired hourly.
    expect(calls).toHaveLength(1);
    expect(writes['stakeSchedules/csnorth']?.tasks[1]?.last_trigger_time).toBeDefined();
    expect(writes['stakeSchedules/csnorth']?.tasks[0]?.last_trigger_time).toBeUndefined();
  });

  it('treats `functions/task-already-exists` as a successful dedupe and still stamps', async () => {
    const { db, writes } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        tasks: [task({ next_trigger_time: at('2026-09-05T12:00:00.000Z') })],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue } = makeEnqueue([], () => {
      throw Object.assign(new Error('already there'), { code: 'functions/task-already-exists' });
    });

    const summary = await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    expect(summary).toMatchObject({ enqueued: 0, deduped: 1, failures: 0 });
    expect(writes['stakeSchedules/csnorth']?.tasks[0]?.last_trigger_time).toBeDefined();
  });

  it('leaves a task unstamped when the enqueue fails for any other reason', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const { db, writes } = makeDb([{ id: 'csnorth' }], {
        csnorth: {
          tasks: [task({ next_trigger_time: at('2026-09-05T12:00:00.000Z') })],
          lastActor: DISPATCHER_ACTOR,
        },
      });
      const { enqueue } = makeEnqueue([], () => {
        throw Object.assign(new Error('queue unavailable'), { code: 'functions/unavailable' });
      });

      const summary = await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

      // Unstamped means still due, so the next hourly run retries it.
      expect(summary).toMatchObject({ enqueued: 0, deduped: 0, failures: 1 });
      expect(writes).toEqual({});
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps going when one stake throws', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const due = {
        tasks: [task({ next_trigger_time: at('2026-09-05T12:00:00.000Z') })],
        lastActor: DISPATCHER_ACTOR,
      };
      const { db, writes } = makeDb(
        [{ id: 'broken' }, { id: 'healthy' }],
        { broken: due, healthy: due },
        ['broken'],
      );
      const { enqueue, calls } = makeEnqueue([]);

      const summary = await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

      expect(summary).toMatchObject({ stakes: 2, enqueued: 1, failures: 1 });
      expect(calls.map((c) => c.payload.stakeId)).toEqual(['healthy']);
      expect(writes['stakeSchedules/healthy']).toBeDefined();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('ignores a stored entry naming a job the registry does not carry', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const { db, writes } = makeDb([{ id: 'csnorth' }], {
        csnorth: {
          tasks: [task({ job: 'retired', next_trigger_time: at('2026-09-05T12:00:00.000Z') })],
          lastActor: DISPATCHER_ACTOR,
        },
      });
      const { enqueue, calls } = makeEnqueue([]);

      const summary = await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

      expect(calls).toHaveLength(0);
      // Seeded `demo` alongside it; the retired entry is kept as-is so
      // re-registering the job restores the manager's own choice.
      expect(summary.seeded).toBe(1);
      expect(writes['stakeSchedules/csnorth']?.tasks.map((t) => t.job)).toEqual([
        'retired',
        'demo',
      ]);
      expect(writes['stakeSchedules/csnorth']?.tasks[0]?.last_trigger_time).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('re-bases rather than throwing on an unreadable stored timestamp', async () => {
    const { db, writes } = makeDb([{ id: 'csnorth' }], {
      csnorth: {
        // A hand-edited doc: the field is there but holds a string.
        tasks: [{ ...task(), next_trigger_time: 'not-a-timestamp' } as unknown as ScheduledTask],
        lastActor: DISPATCHER_ACTOR,
      },
    });
    const { enqueue, calls } = makeEnqueue([]);

    await dispatchDue(db, { registry: registry(), enqueue, now: NOW });

    expect(calls).toHaveLength(1);
    expect(
      writes['stakeSchedules/csnorth']?.tasks[0]?.next_trigger_time?.toDate().toISOString(),
    ).toBe('2026-09-06T12:00:00.000Z');
  });
});

describe('dispatchScheduledTasks registration', () => {
  type Endpoint = { scheduleTrigger?: { schedule?: string; timeZone?: string } };

  it('runs on the hour in UTC', () => {
    const endpoint = (dispatchScheduledTasks as unknown as { __endpoint?: Endpoint }).__endpoint;
    // `every 1 hours` would fire relative to deploy time, detaching the
    // run from the hour bucket the dedupe id is built from.
    expect(endpoint?.scheduleTrigger?.schedule).toBe('0 * * * *');
    expect(endpoint?.scheduleTrigger?.timeZone).toBe('Etc/UTC');
  });

  it('keeps the completion message the monitoring metric matches', () => {
    // `infra/monitoring/scheduled-dispatch-completed.yaml` matches this
    // text and alerts on its ABSENCE. A reword makes the metric read
    // zero, which looks exactly like the outage it exists to detect —
    // and nothing else would fail. This assertion is the tripwire; when
    // it fires, update the metric, don't update the expectation.
    expect(DISPATCH_DONE_MESSAGE).toBe('dispatchScheduledTasks: done');
  });
});
