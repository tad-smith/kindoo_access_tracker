// Rules tests for the two cross-stake top-level collections covered
// in `firebase-schema.md` §§3.2–3.3:
//
//   - `platformSuperadmins/{canonicalEmail}` — read by superadmins;
//     no client writes (Firestore-console-managed allow-list).
//   - `platformAuditLog/{auditId}` — read by superadmins; writes
//     server-only (the `createStake` callable + superadmin sync
//     triggers fan rows here via Admin SDK).
//
// `userIndex` is covered separately in `userIndex.test.ts` (Phase 2).
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  clearAll,
  managerContext,
  outsiderContext,
  seedAsAdmin,
  setupTestEnv,
  superadminContext,
  unauthedContext,
} from './lib/rules.js';

const STAKE_ID = 'csnorth';

describe('firestore.rules — top-level collections', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('top-level');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  describe('platformSuperadmins/{canonicalEmail}', () => {
    const PATH = 'platformSuperadmins/admin@kindoo.example';
    const seedDoc = {
      email: 'Admin@kindoo.example',
      addedAt: new Date(),
      addedBy: 'self@kindoo.example',
    };

    it('superadmin can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = superadminContext(env).firestore();
      await assertSucceeds(db.doc(PATH).get());
    });

    it('non-superadmin (manager) is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).get());
    });

    it('anonymous read is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = unauthedContext(env).firestore();
      await assertFails(db.doc(PATH).get());
    });

    it('client writes are denied even for superadmins', async () => {
      const db = superadminContext(env).firestore();
      await assertFails(db.doc(PATH).set(seedDoc));
    });
  });

  describe('platformAuditLog/{auditId}', () => {
    const PATH = 'platformAuditLog/2026-04-28T14:23:45.123Z_create-stake-1';
    const seedDoc = {
      timestamp: new Date(),
      actor_email: 'Admin@kindoo.example',
      actor_canonical: 'admin@kindoo.example',
      action: 'create_stake',
      entity_type: 'stake',
      entity_id: 'csnorth',
      before: null,
      after: { stake_id: 'csnorth' },
      ttl: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    };

    it('superadmin can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = superadminContext(env).firestore();
      await assertSucceeds(db.doc(PATH).get());
    });

    it('non-superadmin (manager) is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).get());
    });

    it('anonymous read is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = unauthedContext(env).firestore();
      await assertFails(db.doc(PATH).get());
    });

    it('client writes are denied even for superadmins', async () => {
      const db = superadminContext(env).firestore();
      await assertFails(db.doc(PATH).set(seedDoc));
    });

    it('outsider with no relevant claims is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = outsiderContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).get());
    });
  });
});
