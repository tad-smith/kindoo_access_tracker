// Rules tests for `stakes/{stakeId}/organizations/{organizationId}`.
//
// A stake-scope concept (named seat pool with a display-only cap),
// manager-managed. Read: any stake member (manager, stake-scope, or
// bishopric). Write: managers only, with the `lastActor` integrity
// check. Mirrors the `kindooSites` rule block.
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
const ORG_ID = 'primary-childrens-hospital';
const PATH = `stakes/${STAKE_ID}/organizations/${ORG_ID}`;
const OTHER_PATH = `stakes/someother/organizations/${ORG_ID}`;

function freshOrgDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    organization_id: ORG_ID,
    name: "Primary Children's Hospital",
    seat_cap: 25,
    created_at: new Date(),
    last_modified_at: new Date(),
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

describe('firestore.rules — stakes/{sid}/organizations/{organizationId}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('organizations');
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
        await ctx.firestore().doc(PATH).set(freshOrgDoc());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('stake member can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshOrgDoc());
      });
      await assertSucceeds(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('bishopric member can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshOrgDoc());
      });
      await assertSucceeds(bishopricContext(env, STAKE_ID, ['01']).firestore().doc(PATH).get());
    });

    it('outsider denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshOrgDoc());
      });
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('anonymous denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshOrgDoc());
      });
      await assertFails(unauthedContext(env).firestore().doc(PATH).get());
    });

    it('cross-stake denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(OTHER_PATH).set(freshOrgDoc());
      });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(OTHER_PATH).get());
    });
  });

  describe('write', () => {
    it('manager create with matching lastActor → ok', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).set(freshOrgDoc()));
    });

    it('manager update an existing org → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshOrgDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db
          .doc(PATH)
          .set(freshOrgDoc({ name: "Primary Children's Hospital (renamed)", seat_cap: 30 })),
      );
    });

    it('manager delete → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshOrgDoc());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).delete());
    });

    it('manager write with bad lastActor → denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db
          .doc(PATH)
          .set(
            freshOrgDoc({ lastActor: { email: 'Wrong@gmail.com', canonical: 'wrong@gmail.com' } }),
          ),
      );
    });

    it('stake-scope member cannot write', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(freshOrgDoc({ lastActor: lastActorOf(personas.stakeMember) })),
      );
    });

    it('stake-scope member cannot delete', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshOrgDoc());
      });
      await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).delete());
    });

    it('bishopric member cannot write', async () => {
      const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
      await assertFails(
        db.doc(PATH).set(freshOrgDoc({ lastActor: lastActorOf(personas.bishopric) })),
      );
    });

    it('outsider cannot write', async () => {
      const db = outsiderContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(freshOrgDoc({ lastActor: lastActorOf(personas.outsider) })),
      );
    });

    it('anonymous cannot write', async () => {
      const db = unauthedContext(env).firestore();
      await assertFails(db.doc(PATH).set(freshOrgDoc()));
    });

    it('cross-stake manager cannot write', async () => {
      const db = managerContext(env, 'demo-other-stake').firestore();
      await assertFails(db.doc(PATH).set(freshOrgDoc()));
    });
  });
});
