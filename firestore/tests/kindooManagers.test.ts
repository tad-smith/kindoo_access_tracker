// Rules tests for `stakes/{stakeId}/kindooManagers/{memberCanonical}`
// per `firebase-schema.md` §4.4.
//
// Read: managers only (non-managers cannot enumerate the manager list).
// Write: managers only, with `lastActor` integrity check.
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  bishopricContext,
  clearAll,
  lastActorOf,
  managerContext,
  outsiderContext,
  personas,
  seedAsAdmin,
  setupTestEnv,
  stakeMemberContext,
  unauthedContext,
} from './lib/rules.js';

const STAKE_ID = 'csnorth';
const TARGET_CANONICAL = 'newmanager@gmail.com';
const PATH = `stakes/${STAKE_ID}/kindooManagers/${TARGET_CANONICAL}`;

function freshDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    member_canonical: TARGET_CANONICAL,
    member_email: 'NewManager@gmail.com',
    name: 'New Manager',
    active: true,
    added_at: new Date(),
    added_by: lastActorOf(personas.manager),
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

describe('firestore.rules — stakes/{sid}/kindooManagers/{canonical}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('kindoo-managers');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  describe('read', () => {
    it('manager can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshDoc());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('stake member is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshDoc());
      });
      await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('bishopric member is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshDoc());
      });
      await assertFails(bishopricContext(env, STAKE_ID, ['01']).firestore().doc(PATH).get());
    });

    it('outsider is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshDoc());
      });
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('anonymous read is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshDoc());
      });
      await assertFails(unauthedContext(env).firestore().doc(PATH).get());
    });

    it('cross-stake: manager of stake A is denied reading stake B', async () => {
      const otherPath = `stakes/someother/kindooManagers/${TARGET_CANONICAL}`;
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(otherPath).set(freshDoc());
      });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(otherPath).get());
    });
  });

  describe('write', () => {
    it('manager create with matching lastActor → ok', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).set(freshDoc()));
    });

    it('manager update toggling active → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).set(freshDoc({ active: false })));
    });

    it('manager write with bad lastActor → denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(freshDoc({ lastActor: { email: 'X@x.com', canonical: 'y@x.com' } })),
      );
    });

    it('non-manager write is denied', async () => {
      await assertFails(
        stakeMemberContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(freshDoc({ lastActor: lastActorOf(personas.stakeMember) })),
      );
      await assertFails(
        bishopricContext(env, STAKE_ID, ['01'])
          .firestore()
          .doc(PATH)
          .set(freshDoc({ lastActor: lastActorOf(personas.bishopric) })),
      );
      await assertFails(
        outsiderContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(freshDoc({ lastActor: lastActorOf(personas.outsider) })),
      );
    });
  });
});
