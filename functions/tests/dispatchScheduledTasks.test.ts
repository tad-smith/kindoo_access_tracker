// Integration lane for the hourly dispatcher: real Firestore, real
// `stakes` / `stakeSchedules` documents, real Timestamp round-tripping.
// Only the enqueuer is stubbed.
//
// The unit lane (`src/scheduled/dispatchScheduledTasks.test.ts`) covers
// the branch matrix; this file exists to prove the parts a fake db
// cannot: that the seeded document persists in the shape the rules and
// the schedule maths expect, and that a stored `Timestamp` read back out
// of Firestore still advances correctly.
//
// **Not proved here, or anywhere local:** Cloud Scheduler firing the
// function, real Cloud Tasks id deduplication, and the queue's OIDC auth
// on the callback into `runScheduledTask`. All three are first exercised
// on staging.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { StakeSchedule } from '@kindoo/shared';
import type { JobRegistry } from '../src/lib/taskRegistry.js';
import {
  DISPATCHER_ACTOR,
  dispatchDue,
  type EnqueueTask,
  type ScheduledTaskPayload,
} from '../src/scheduled/dispatchScheduledTasks.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'dispatch-suite';
const TZ = 'America/Denver';
const NOW = new Date('2026-09-05T14:00:00.000Z');

const REGISTRY: JobRegistry = {
  demo: {
    handler: async () => undefined,
    defaultSchedule: { type: 'daily', hour: 6 },
    defaultEnabled: false,
  },
};

/** Records what would have been enqueued; never touches Cloud Tasks. */
function recorder(): {
  enqueue: EnqueueTask;
  calls: { payload: ScheduledTaskPayload; id: string }[];
} {
  const calls: { payload: ScheduledTaskPayload; id: string }[] = [];
  const enqueue: EnqueueTask = async (payload, id) => {
    calls.push({ payload, id });
  };
  return { enqueue, calls };
}

async function seedStake(db: Firestore): Promise<void> {
  await db.doc(`stakes/${STAKE_ID}`).set({
    stake_name: 'Dispatch Suite Stake',
    timezone: TZ,
    setup_complete: true,
  });
}

async function readSchedule(db: Firestore): Promise<StakeSchedule | undefined> {
  const snap = await db.doc(`stakeSchedules/${STAKE_ID}`).get();
  return snap.exists ? (snap.data() as StakeSchedule) : undefined;
}

describe.skipIf(!hasEmulators())('dispatchDue against Firestore', () => {
  beforeEach(async () => {
    await clearEmulators();
    await seedStake(requireEmulators().db);
  });

  afterAll(async () => {
    await clearEmulators();
  });

  it('creates the schedule doc on first pass over a stake that has none', async () => {
    const { db } = requireEmulators();
    const { enqueue, calls } = recorder();

    const summary = await dispatchDue(db, { registry: REGISTRY, enqueue, now: NOW });

    expect(summary).toMatchObject({ stakes: 1, seeded: 1, enqueued: 0, failures: 0 });
    const doc = await readSchedule(db);
    expect(doc?.lastActor).toEqual({ ...DISPATCHER_ACTOR });
    expect(doc?.tasks).toHaveLength(1);
    expect(doc?.tasks[0]).toMatchObject({ job: 'demo', enabled: false });
    // 06:00 in the stake's own zone the day after `now`.
    expect(doc?.tasks[0]?.next_trigger_time?.toDate().toISOString()).toBe(
      '2026-09-06T12:00:00.000Z',
    );
    expect(calls).toHaveLength(0);
  });

  it('is a no-op on the second pass — seeding never rewrites what it already wrote', async () => {
    const { db } = requireEmulators();
    const { enqueue } = recorder();
    await dispatchDue(db, { registry: REGISTRY, enqueue, now: NOW });
    const first = await readSchedule(db);

    const summary = await dispatchDue(db, {
      registry: REGISTRY,
      enqueue,
      now: new Date('2026-09-05T15:00:00.000Z'),
    });

    expect(summary).toMatchObject({ seeded: 0, enqueued: 0 });
    expect(await readSchedule(db)).toEqual(first);
  });

  it('enqueues a due task and persists both stamps', async () => {
    const { db } = requireEmulators();
    await db.doc(`stakeSchedules/${STAKE_ID}`).set({
      tasks: [
        {
          job: 'demo',
          enabled: true,
          schedule: { type: 'daily', hour: 6 },
          next_trigger_time: Timestamp.fromDate(new Date('2026-09-05T12:00:00.000Z')),
        },
      ],
      lastActor: DISPATCHER_ACTOR,
    });
    const { enqueue, calls } = recorder();

    const summary = await dispatchDue(db, { registry: REGISTRY, enqueue, now: NOW });

    expect(summary).toMatchObject({ enqueued: 1, deduped: 0, failures: 0 });
    expect(calls).toEqual([
      {
        payload: { stakeId: STAKE_ID, job: 'demo' },
        id: `${STAKE_ID}--demo--20260905T14`,
      },
    ]);
    const stamped = (await readSchedule(db))?.tasks[0];
    expect(stamped?.last_trigger_time?.toDate().toISOString()).toBe(NOW.toISOString());
    expect(stamped?.next_trigger_time?.toDate().toISOString()).toBe('2026-09-06T12:00:00.000Z');
  });

  it('does not re-fire within the same window once stamped', async () => {
    const { db } = requireEmulators();
    await db.doc(`stakeSchedules/${STAKE_ID}`).set({
      tasks: [
        {
          job: 'demo',
          enabled: true,
          schedule: { type: 'hourly' },
          next_trigger_time: Timestamp.fromDate(new Date('2026-09-05T13:17:00.000Z')),
        },
      ],
      lastActor: DISPATCHER_ACTOR,
    });
    const { enqueue, calls } = recorder();

    await dispatchDue(db, { registry: REGISTRY, enqueue, now: NOW });
    // Same hour, a few minutes later — the stamp, not the queue, is what
    // makes this a no-op.
    await dispatchDue(db, {
      registry: REGISTRY,
      enqueue,
      now: new Date('2026-09-05T14:05:00.000Z'),
    });

    expect(calls).toHaveLength(1);
    // The next top of the hour, not the dispatch minute — an hourly slot
    // is anchored to the hour so it can't inherit a run's start second.
    expect((await readSchedule(db))?.tasks[0]?.next_trigger_time?.toDate().toISOString()).toBe(
      '2026-09-05T15:00:00.000Z',
    );
  });

  it("leaves a manager's disabled task untouched", async () => {
    const { db } = requireEmulators();
    const disabled = {
      tasks: [
        {
          job: 'demo',
          enabled: false,
          schedule: { type: 'daily', hour: 6 },
          next_trigger_time: Timestamp.fromDate(new Date('2026-01-01T12:00:00.000Z')),
        },
      ],
      lastActor: { email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' },
    };
    await db.doc(`stakeSchedules/${STAKE_ID}`).set(disabled);
    const { enqueue, calls } = recorder();

    await dispatchDue(db, { registry: REGISTRY, enqueue, now: NOW });

    expect(calls).toHaveLength(0);
    // Including the `lastActor` — nothing was written, so the manager
    // stays the last writer.
    expect(await readSchedule(db)).toEqual(disabled);
  });

  it('seeds every stake independently', async () => {
    const { db } = requireEmulators();
    await db.doc('stakes/other-stake').set({
      stake_name: 'Other Stake',
      timezone: 'Pacific/Honolulu',
      setup_complete: true,
    });
    const { enqueue } = recorder();

    const summary = await dispatchDue(db, { registry: REGISTRY, enqueue, now: NOW });

    expect(summary).toMatchObject({ stakes: 2, seeded: 2 });
    const other = (await db.doc('stakeSchedules/other-stake').get()).data() as StakeSchedule;
    // `now` is 08:00 in Denver (slot already gone, so tomorrow) but
    // 04:00 in Honolulu (slot still ahead, so today). The seeded slot
    // reads the stake's own zone, not the dispatcher's.
    expect(other.tasks[0]?.next_trigger_time?.toDate().toISOString()).toBe(
      '2026-09-05T16:00:00.000Z',
    );
  });
});
