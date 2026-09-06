// Rules tests for `syncHeartbeats/{stakeId}/sites/{siteKey}` — the
// "someone synced this Kindoo site" stamp the sync reminder reads.
//
// Top-level rather than a sub-collection of `stakes`, like
// `stakeSchedules`, so that a scan (frequent, and carrying nothing worth
// keeping) does not fan an audit row per write. That makes the
// cross-stake cases the load-bearing ones: the doc ID path segment is
// the only thing naming the stake, so `isManager(stakeId)` has to be
// resolved against it and not against the collection's position.
//
// The delete cases are the other half. A missing heartbeat reads as
// "never synced", which the reminder is deliberately silent about — so a
// delete would be a way to switch the reminder off permanently and
// invisibly. Rules deny it to everyone.
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
/** Home has no `kindooSites` doc, so it takes the reserved key. */
const HOME_PATH = `syncHeartbeats/${STAKE_ID}/sites/home`;
const FOREIGN_PATH = `syncHeartbeats/${STAKE_ID}/sites/east`;

/** A well-formed heartbeat written by the manager. */
function heartbeat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stake_id: STAKE_ID,
    kindoo_site_id: null,
    last_sync_at: new Date('2026-09-06T12:00:00Z'),
    ext_version: '1.4.0',
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

describe('firestore.rules — syncHeartbeats/{stakeId}/sites/{siteKey}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('sync-heartbeats');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  async function seed(): Promise<void> {
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(HOME_PATH).set(heartbeat());
    });
  }

  describe('read', () => {
    it('anonymous read is denied', async () => {
      await seed();
      await assertFails(unauthedContext(env).firestore().doc(HOME_PATH).get());
    });

    it('authed non-member is denied', async () => {
      await seed();
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(HOME_PATH).get());
    });

    it('manager can read', async () => {
      await seed();
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(HOME_PATH).get());
    });

    it('platform superadmin can read', async () => {
      await seed();
      await assertSucceeds(superadminContext(env).firestore().doc(HOME_PATH).get());
    });

    it('an ordinary stake member cannot read — no SPA surface needs it', async () => {
      await seed();
      await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(HOME_PATH).get());
      await assertFails(bishopricContext(env, STAKE_ID, ['ge']).firestore().doc(HOME_PATH).get());
    });

    it("a manager of another stake cannot read this stake's heartbeats", async () => {
      await seed();
      await assertFails(managerContext(env, OTHER_STAKE).firestore().doc(HOME_PATH).get());
    });
  });

  describe('write', () => {
    it('manager can create a home heartbeat', async () => {
      await assertSucceeds(
        managerContext(env, STAKE_ID).firestore().doc(HOME_PATH).set(heartbeat()),
      );
    });

    it('manager can create a foreign-site heartbeat carrying its site id', async () => {
      await assertSucceeds(
        managerContext(env, STAKE_ID)
          .firestore()
          .doc(FOREIGN_PATH)
          .set(heartbeat({ kindoo_site_id: 'east' })),
      );
    });

    it('manager can update an existing heartbeat — the whole point is re-stamping', async () => {
      await seed();
      await assertSucceeds(
        managerContext(env, STAKE_ID)
          .firestore()
          .doc(HOME_PATH)
          .set(heartbeat({ last_sync_at: new Date('2026-09-07T12:00:00Z') })),
      );
    });

    it('anonymous write is denied', async () => {
      await assertFails(unauthedContext(env).firestore().doc(HOME_PATH).set(heartbeat()));
    });

    it('non-manager members cannot write', async () => {
      await assertFails(
        stakeMemberContext(env, STAKE_ID)
          .firestore()
          .doc(HOME_PATH)
          .set(heartbeat({ lastActor: lastActorOf(personas.stakeMember) })),
      );
      await assertFails(
        bishopricContext(env, STAKE_ID, ['ge'])
          .firestore()
          .doc(HOME_PATH)
          .set(heartbeat({ lastActor: lastActorOf(personas.bishopric) })),
      );
    });

    it("a manager of another stake cannot write this stake's heartbeat", async () => {
      // The cross-stake risk of a top-level collection: the path segment
      // is the only thing naming the stake. A neighbour freshening our
      // heartbeat would silence a real reminder.
      const db = contextFor(env, personas.manager, OTHER_STAKE, { manager: true }).firestore();
      await assertFails(db.doc(HOME_PATH).set(heartbeat()));
    });

    it('a superadmin who is not a stake manager cannot write', async () => {
      await assertFails(superadminContext(env).firestore().doc(HOME_PATH).set(heartbeat()));
    });

    it('a mismatched lastActor is denied', async () => {
      await assertFails(
        managerContext(env, STAKE_ID)
          .firestore()
          .doc(HOME_PATH)
          .set(heartbeat({ lastActor: lastActorOf(personas.stakeMember) })),
      );
    });

    it('an extra key is denied', async () => {
      await assertFails(
        managerContext(env, STAKE_ID)
          .firestore()
          .doc(HOME_PATH)
          .set(heartbeat({ drift_rows: 5 })),
      );
    });

    it('a missing key is denied — the key set is exact in both directions', async () => {
      const doc = heartbeat();
      for (const key of Object.keys(doc)) {
        const partial = { ...doc };
        delete partial[key];
        await assertFails(managerContext(env, STAKE_ID).firestore().doc(HOME_PATH).set(partial));
      }
    });

    it('a mistyped field is denied', async () => {
      const manager = managerContext(env, STAKE_ID).firestore();
      await assertFails(manager.doc(HOME_PATH).set(heartbeat({ stake_id: 7 })));
      await assertFails(manager.doc(HOME_PATH).set(heartbeat({ kindoo_site_id: 7 })));
      // The reminder does date arithmetic on this: a string would read as
      // unparseable and silence the site rather than fail loudly.
      await assertFails(manager.doc(HOME_PATH).set(heartbeat({ last_sync_at: '2026-09-06' })));
      await assertFails(manager.doc(HOME_PATH).set(heartbeat({ ext_version: 140 })));
    });

    it('delete is denied even for a manager', async () => {
      // A deleted heartbeat reads as "never synced", which is silent
      // forever — the one state that switches the reminder off for good.
      await seed();
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(HOME_PATH).delete());
    });

    it('delete is denied for a superadmin too', async () => {
      await seed();
      await assertFails(superadminContext(env).firestore().doc(HOME_PATH).delete());
    });
  });
});
