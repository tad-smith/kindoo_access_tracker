// Rules tests for `stakeSchedules/{stakeId}` — the per-stake
// scheduled-task array read by the hourly dispatcher.
//
// Top-level rather than a sub-collection of `stakes` on purpose (see the
// block comment in firestore.rules), so `isAnyMember` / `isManager` are
// resolved from the token against the doc ID rather than from the path.
// That makes the cross-stake cases below the load-bearing ones: a
// manager of `other-stake` must not be able to write `csnorth`'s
// schedule just because the collection is top level.
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  bishopricContext,
  clearAll,
  contextFor,
  lastActorOf,
  managerContext,
  outsiderContext,
  personas,
  seedAsAdmin,
  setupTestEnv,
  stakeMemberContext,
  superadminContext,
  unauthedContext,
} from './lib/rules.js';

const STAKE_ID = 'csnorth';
const OTHER_STAKE = 'demo-other-stake';
const PATH = `stakeSchedules/${STAKE_ID}`;

/** A well-formed doc body written by `persona` (defaults to the manager). */
function scheduleDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tasks: [
      {
        job: 'syncReminder',
        enabled: true,
        schedule: { type: 'daily', hour: 6 },
        next_trigger_time: new Date('2026-09-06T12:00:00Z'),
      },
    ],
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

describe('firestore.rules — stakeSchedules/{stakeId}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('stake-schedules');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  async function seed(): Promise<void> {
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(PATH).set(scheduleDoc());
    });
  }

  describe('read', () => {
    it('anonymous read is denied', async () => {
      await seed();
      await assertFails(unauthedContext(env).firestore().doc(PATH).get());
    });

    it('authed non-member is denied', async () => {
      await seed();
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('manager can read', async () => {
      await seed();
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('stake-scope member can read', async () => {
      await seed();
      await assertSucceeds(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('bishopric member can read', async () => {
      await seed();
      await assertSucceeds(bishopricContext(env, STAKE_ID, ['ge']).firestore().doc(PATH).get());
    });

    it('platform superadmin can read', async () => {
      await seed();
      await assertSucceeds(superadminContext(env).firestore().doc(PATH).get());
    });

    it("a manager of another stake cannot read this stake's schedule", async () => {
      await seed();
      await assertFails(managerContext(env, OTHER_STAKE).firestore().doc(PATH).get());
    });
  });

  describe('write', () => {
    it('manager can create', async () => {
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).set(scheduleDoc()));
    });

    it('manager can update (toggling a task off)', async () => {
      await seed();
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PATH).set(
          scheduleDoc({
            tasks: [
              {
                job: 'syncReminder',
                enabled: false,
                schedule: { type: 'daily', hour: 6 },
                next_trigger_time: new Date('2026-09-06T12:00:00Z'),
              },
            ],
          }),
        ),
      );
    });

    it('non-manager members cannot write', async () => {
      await assertFails(
        stakeMemberContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(scheduleDoc({ lastActor: lastActorOf(personas.stakeMember) })),
      );
      await assertFails(
        bishopricContext(env, STAKE_ID, ['ge'])
          .firestore()
          .doc(PATH)
          .set(scheduleDoc({ lastActor: lastActorOf(personas.bishopric) })),
      );
    });

    it('anonymous write is denied', async () => {
      await assertFails(unauthedContext(env).firestore().doc(PATH).set(scheduleDoc()));
    });

    it("a manager of another stake cannot write this stake's schedule", async () => {
      // The whole cross-stake risk of a top-level collection: the doc ID
      // is the only thing naming the stake, so `isManager(stakeId)` has
      // to be read against it.
      const db = contextFor(env, personas.manager, OTHER_STAKE, { manager: true }).firestore();
      await assertFails(db.doc(PATH).set(scheduleDoc()));
    });

    it('a superadmin (who is not a stake manager) cannot write', async () => {
      await assertFails(superadminContext(env).firestore().doc(PATH).set(scheduleDoc()));
    });

    it('a mismatched lastActor is denied', async () => {
      await assertFails(
        managerContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(scheduleDoc({ lastActor: lastActorOf(personas.stakeMember) })),
      );
    });

    it('a missing lastActor is denied', async () => {
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(PATH).set({ tasks: [] }));
    });

    it('an extra top-level key is denied', async () => {
      await assertFails(
        managerContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(scheduleDoc({ stake_id: STAKE_ID })),
      );
    });

    it('a non-list `tasks` is denied', async () => {
      await assertFails(
        managerContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(scheduleDoc({ tasks: { syncReminder: true } })),
      );
    });

    it('an oversized `tasks` array is denied', async () => {
      const tasks = Array.from({ length: 51 }, (_, i) => ({
        job: `job-${i}`,
        enabled: false,
        schedule: { type: 'hourly' },
      }));
      await assertFails(
        managerContext(env, STAKE_ID).firestore().doc(PATH).set(scheduleDoc({ tasks })),
      );
    });

    it('an empty `tasks` array is allowed — a stake may have opted every job out', async () => {
      await assertSucceeds(
        managerContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(scheduleDoc({ tasks: [] })),
      );
    });

    it('delete is denied even for a manager', async () => {
      await seed();
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(PATH).delete());
    });
  });
});
