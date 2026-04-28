// Rules tests for `stakes/{sid}/wardCallingTemplates/{name}` and
// `stakes/{sid}/stakeCallingTemplates/{name}` per
// `firebase-schema.md` §§4.8–4.9. Manager-only on both reads and
// writes.
//
// Both collections share rule-shape and a single setupTestEnv,
// because spinning up two separate rules-test envs in the same file
// can race the emulator's rules-loading endpoint and produce a 500
// from `initializeTestEnvironment`. Pulling both blocks into one env
// is the cleaner pattern for collections that share a rule shape.
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

function templateDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    calling_name: 'Bishop',
    give_app_access: true,
    sheet_order: 1,
    created_at: new Date(),
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

describe('firestore.rules — calling templates', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('templates');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  for (const collection of ['wardCallingTemplates', 'stakeCallingTemplates'] as const) {
    describe(collection, () => {
      const PATH = `stakes/${STAKE_ID}/${collection}/Bishop`;

      it('manager can read', async () => {
        await seedAsAdmin(env, async (ctx) => {
          await ctx.firestore().doc(PATH).set(templateDoc());
        });
        await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).get());
      });

      it('non-manager (stake member) is denied', async () => {
        await seedAsAdmin(env, async (ctx) => {
          await ctx.firestore().doc(PATH).set(templateDoc());
        });
        await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
      });

      it('bishopric is denied', async () => {
        await seedAsAdmin(env, async (ctx) => {
          await ctx.firestore().doc(PATH).set(templateDoc());
        });
        await assertFails(bishopricContext(env, STAKE_ID, ['01']).firestore().doc(PATH).get());
      });

      it('outsider is denied', async () => {
        await seedAsAdmin(env, async (ctx) => {
          await ctx.firestore().doc(PATH).set(templateDoc());
        });
        await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(PATH).get());
      });

      it('anonymous is denied', async () => {
        await assertFails(unauthedContext(env).firestore().doc(PATH).get());
      });

      it('manager write with matching lastActor → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(templateDoc()));
      });

      it('manager write with bad lastActor → denied', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(templateDoc({ lastActor: { email: 'X@x.com', canonical: 'y@x.com' } })),
        );
      });

      it('non-manager write is denied', async () => {
        await assertFails(
          stakeMemberContext(env, STAKE_ID)
            .firestore()
            .doc(PATH)
            .set(templateDoc({ lastActor: lastActorOf(personas.stakeMember) })),
        );
      });
    });
  }
});
