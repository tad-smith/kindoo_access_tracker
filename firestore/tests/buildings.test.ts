// Rules tests for `stakes/{stakeId}/buildings/{buildingId}` per
// `firebase-schema.md` §4.3.
//
// Same shape as wards: read by any stake member; write by managers
// with `lastActor` integrity check.
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
const BUILDING_ID = 'cordera-building';
const PATH = `stakes/${STAKE_ID}/buildings/${BUILDING_ID}`;

function freshBuildingDoc(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    building_id: BUILDING_ID,
    building_name: 'Cordera Building',
    address: '1234 Cordera Cir',
    created_at: new Date(),
    last_modified_at: new Date(),
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

describe('firestore.rules — stakes/{sid}/buildings/{buildingId}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('buildings');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  describe('read', () => {
    it('manager / stake member / bishopric can all read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshBuildingDoc());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).get());
      await assertSucceeds(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
      await assertSucceeds(bishopricContext(env, STAKE_ID, ['01']).firestore().doc(PATH).get());
    });

    it('outsider denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshBuildingDoc());
      });
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('anonymous denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshBuildingDoc());
      });
      await assertFails(unauthedContext(env).firestore().doc(PATH).get());
    });

    it('cross-stake denied', async () => {
      const otherPath = `stakes/someother/buildings/${BUILDING_ID}`;
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(otherPath).set(freshBuildingDoc());
      });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(otherPath).get());
    });
  });

  describe('write', () => {
    it('manager write with matching lastActor → ok', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).set(freshBuildingDoc()));
    });

    it('manager write with bad lastActor → denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          freshBuildingDoc({
            lastActor: { email: 'X@gmail.com', canonical: 'y@gmail.com' },
          }),
        ),
      );
    });

    it('non-managers cannot write', async () => {
      await assertFails(
        stakeMemberContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(freshBuildingDoc({ lastActor: lastActorOf(personas.stakeMember) })),
      );
      await assertFails(
        bishopricContext(env, STAKE_ID, ['01'])
          .firestore()
          .doc(PATH)
          .set(freshBuildingDoc({ lastActor: lastActorOf(personas.bishopric) })),
      );
      await assertFails(
        outsiderContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(freshBuildingDoc({ lastActor: lastActorOf(personas.outsider) })),
      );
    });
  });

  // Extension v2.1 — `kindoo_rule` is manager-only and shape-checked.
  describe('kindoo_rule (extension v2.1)', () => {
    const validKindooRule = { rule_id: 1234, rule_name: 'Cordera Bldg Access Schedule' };

    it('manager can add kindoo_rule', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).set(freshBuildingDoc({ kindoo_rule: validKindooRule })));
    });

    it('manager can modify an existing kindoo_rule', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(freshBuildingDoc({ kindoo_rule: validKindooRule }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PATH).set(
          freshBuildingDoc({
            kindoo_rule: { rule_id: 5678, rule_name: 'Cordera Bldg Access Schedule (revised)' },
          }),
        ),
      );
    });

    it('stake-scope member cannot add kindoo_rule', async () => {
      await assertFails(
        stakeMemberContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(
            freshBuildingDoc({
              kindoo_rule: validKindooRule,
              lastActor: lastActorOf(personas.stakeMember),
            }),
          ),
      );
    });

    it('outsider cannot add kindoo_rule', async () => {
      await assertFails(
        outsiderContext(env, STAKE_ID)
          .firestore()
          .doc(PATH)
          .set(
            freshBuildingDoc({
              kindoo_rule: validKindooRule,
              lastActor: lastActorOf(personas.outsider),
            }),
          ),
      );
    });

    it('manager write with badly-shaped kindoo_rule (rule_id as string) → denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          freshBuildingDoc({
            kindoo_rule: { rule_id: 'not-a-number', rule_name: 'X' },
          }),
        ),
      );
    });

    it('manager write with missing kindoo_rule.rule_name → denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          freshBuildingDoc({
            kindoo_rule: { rule_id: 1234 },
          }),
        ),
      );
    });
  });
});
