// Rules tests for `stakes/{stakeId}/access/{memberCanonical}` per
// `firebase-schema.md` §4.5. The split-ownership boundary
// (`importer_callings` server-only; `manual_grants` manager-writable)
// is the most subtle rule in the file — exercised in detail below.
//
// Read: managers only.
// Create: manager creating a manual-only doc (importer_callings={},
//         manual_grants non-empty, doc-id matches member_canonical).
// Update: manager touching only `manual_grants` + bookkeeping fields;
//         importer_callings byte-equal pre/post.
// Delete: manager deletes a now-empty doc (both maps empty).
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
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
const TARGET_CANONICAL = 'alice@gmail.com';
const PATH = `stakes/${STAKE_ID}/access/${TARGET_CANONICAL}`;

function emptyAccessDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    member_canonical: TARGET_CANONICAL,
    member_email: 'Alice@gmail.com',
    member_name: 'Alice Smith',
    importer_callings: {},
    manual_grants: {},
    created_at: new Date(),
    last_modified_at: new Date(),
    last_modified_by: lastActorOf(personas.manager),
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

const SAMPLE_GRANT = {
  grant_id: '11111111-2222-3333-4444-555555555555',
  reason: 'Visiting authority',
  granted_by: lastActorOf(personas.manager),
  granted_at: new Date(),
};

describe('firestore.rules — stakes/{sid}/access/{canonical}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('access');
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
        await ctx.firestore().doc(PATH).set(emptyAccessDoc());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('non-manager (stake member) is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(emptyAccessDoc());
      });
      await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('outsider is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(emptyAccessDoc());
      });
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('anonymous denied', async () => {
      await assertFails(unauthedContext(env).firestore().doc(PATH).get());
    });

    it('cross-stake: manager of stake A is denied reading stake B access', async () => {
      const otherPath = `stakes/someother/access/${TARGET_CANONICAL}`;
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(otherPath).set(emptyAccessDoc());
      });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(otherPath).get());
    });
  });

  describe('create — manual-only docs', () => {
    it('manager creates a manual-only doc (importer={}, manual non-empty) → ok', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PATH).set(emptyAccessDoc({ manual_grants: { stake: [SAMPLE_GRANT] } })),
      );
    });

    it('create with non-empty importer_callings → denied (server-only field)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          emptyAccessDoc({
            importer_callings: { stake: ['Stake Clerk'] },
            manual_grants: { stake: [SAMPLE_GRANT] },
          }),
        ),
      );
    });

    it('create with empty manual_grants → denied (would create empty doc)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).set(emptyAccessDoc()));
    });

    it('create where doc-id and member_canonical disagree → denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          emptyAccessDoc({
            member_canonical: 'bob@gmail.com',
            manual_grants: { stake: [SAMPLE_GRANT] },
          }),
        ),
      );
    });

    it('create with bad lastActor → denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          emptyAccessDoc({
            manual_grants: { stake: [SAMPLE_GRANT] },
            lastActor: { email: 'X@x.com', canonical: 'y@x.com' },
          }),
        ),
      );
    });

    it('non-manager create is denied', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          emptyAccessDoc({
            manual_grants: { stake: [SAMPLE_GRANT] },
            lastActor: lastActorOf(personas.stakeMember),
          }),
        ),
      );
    });

    // Mirror of the SPA's `useAddManualGrantMutation` create path —
    // the EXACT field set the form writes when the access doc
    // doesn't yet exist, by a pure manager (manager:true, no
    // stake / no wards). Catches shape regressions in the form-
    // driven path that the slim fixtures above miss.
    it('pure manager creates the form-shaped manual-only doc → ok', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      const formPayload: Record<string, unknown> = {
        member_canonical: TARGET_CANONICAL,
        member_email: 'Alice@gmail.com',
        member_name: 'Alice Smith',
        importer_callings: {},
        manual_grants: {
          stake: [
            {
              grant_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
              reason: 'Stake helper',
              granted_by: lastActorOf(personas.manager),
              granted_at: new Date(),
            },
          ],
        },
        created_at: new Date(),
        last_modified_at: new Date(),
        last_modified_by: lastActorOf(personas.manager),
        lastActor: lastActorOf(personas.manager),
      };
      await assertSucceeds(db.doc(PATH).set(formPayload));
    });
  });

  describe('update — split-ownership enforcement', () => {
    it('manager touches manual_grants only → ok', async () => {
      const seed = emptyAccessDoc({
        importer_callings: { stake: ['Stake Clerk'] },
        manual_grants: {},
      });
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seed);
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PATH).update({
          manual_grants: { stake: [SAMPLE_GRANT] },
          last_modified_at: new Date(),
          last_modified_by: lastActorOf(personas.manager),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('manager mutates importer_callings → denied (split-ownership)', async () => {
      const seed = emptyAccessDoc({
        importer_callings: { stake: ['Stake Clerk'] },
        manual_grants: {},
      });
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seed);
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).update({
          importer_callings: { stake: ['Bishop'] }, // forbidden
          last_modified_at: new Date(),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('manager update touching member_email → denied (not in affectedKeys allowlist)', async () => {
      const seed = emptyAccessDoc({
        importer_callings: { stake: ['Stake Clerk'] },
        manual_grants: {},
      });
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seed);
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).update({
          member_email: 'NewAlice@gmail.com',
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('manager update with bad lastActor → denied', async () => {
      const seed = emptyAccessDoc({ manual_grants: { stake: [SAMPLE_GRANT] } });
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seed);
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).update({
          manual_grants: {},
          last_modified_at: new Date(),
          lastActor: { email: 'X@x.com', canonical: 'y@x.com' },
        }),
      );
    });

    it('non-manager update is denied', async () => {
      const seed = emptyAccessDoc({ manual_grants: { stake: [SAMPLE_GRANT] } });
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seed);
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).update({
          manual_grants: {},
          lastActor: lastActorOf(personas.stakeMember),
        }),
      );
    });
  });

  describe('delete — only when both maps are empty', () => {
    it('manager deletes a doc with both maps empty → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(emptyAccessDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).delete());
    });

    it('manager deletes a doc with non-empty importer_callings → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(emptyAccessDoc({ importer_callings: { stake: ['Bishop'] } }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).delete());
    });

    it('manager deletes a doc with non-empty manual_grants → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(emptyAccessDoc({ manual_grants: { stake: [SAMPLE_GRANT] } }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).delete());
    });

    it('non-manager delete is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(emptyAccessDoc());
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).delete());
    });
  });
});
