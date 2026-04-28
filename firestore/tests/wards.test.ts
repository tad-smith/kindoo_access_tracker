// Rules tests for `stakes/{stakeId}/wards/{wardCode}` per
// `firebase-schema.md` §4.2.
//
// Read: any member of the stake.
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
const WARD_CODE = '01';
const PATH = `stakes/${STAKE_ID}/wards/${WARD_CODE}`;
const OTHER_PATH = `stakes/someother/wards/${WARD_CODE}`;

function freshWardDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ward_code: WARD_CODE,
    ward_name: '1st Ward',
    building_name: 'Cordera Building',
    seat_cap: 30,
    created_at: new Date(),
    last_modified_at: new Date(),
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

describe('firestore.rules — stakes/{sid}/wards/{wardCode}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('wards');
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
        await ctx.firestore().doc(PATH).set(freshWardDoc());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('stake member can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshWardDoc());
      });
      await assertSucceeds(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('bishopric (any ward) can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshWardDoc());
      });
      await assertSucceeds(
        bishopricContext(env, STAKE_ID, [WARD_CODE]).firestore().doc(PATH).get(),
      );
    });

    it('outsider is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshWardDoc());
      });
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('anonymous read is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshWardDoc());
      });
      await assertFails(unauthedContext(env).firestore().doc(PATH).get());
    });

    it('cross-stake: manager of stake A is denied reading stake B', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(OTHER_PATH).set(freshWardDoc());
      });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(OTHER_PATH).get());
    });
  });

  describe('write', () => {
    it('manager write with matching lastActor → ok', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).set(freshWardDoc()));
    });

    it('manager write with mismatched lastActor → denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db
          .doc(PATH)
          .set(
            freshWardDoc({ lastActor: { email: 'Wrong@gmail.com', canonical: 'mgr@gmail.com' } }),
          ),
      );
    });

    it('stake member cannot write', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(freshWardDoc({ lastActor: lastActorOf(personas.stakeMember) })),
      );
    });

    it('bishopric member cannot write', async () => {
      const db = bishopricContext(env, STAKE_ID, [WARD_CODE]).firestore();
      await assertFails(
        db.doc(PATH).set(freshWardDoc({ lastActor: lastActorOf(personas.bishopric) })),
      );
    });

    it('outsider cannot write', async () => {
      const db = outsiderContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(freshWardDoc({ lastActor: lastActorOf(personas.outsider) })),
      );
    });

    it('anonymous write is denied', async () => {
      const db = unauthedContext(env).firestore();
      await assertFails(db.doc(PATH).set(freshWardDoc()));
    });
  });
});
