// Rules tests for `stakes/{sid}/auditLog/{auditId}` per
// `firebase-schema.md` §4.10. Manager-only read; all client writes
// denied (the parameterized `auditTrigger` Cloud Function fans rows
// here via Admin SDK, bypassing rules).
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  bishopricContext,
  clearAll,
  managerContext,
  outsiderContext,
  seedAsAdmin,
  setupTestEnv,
  stakeMemberContext,
  unauthedContext,
} from './lib/rules.js';

const STAKE_ID = 'csnorth';
const AUDIT_ID = '2026-04-28T14:23:45.123Z_seats_alice@gmail.com';
const PATH = `stakes/${STAKE_ID}/auditLog/${AUDIT_ID}`;

const seedDoc = {
  audit_id: AUDIT_ID,
  timestamp: new Date(),
  actor_email: 'Mgr@gmail.com',
  actor_canonical: 'mgr@gmail.com',
  action: 'create_seat',
  entity_type: 'seat',
  entity_id: 'alice@gmail.com',
  member_canonical: 'alice@gmail.com',
  before: null,
  after: { scope: 'stake', type: 'manual' },
  ttl: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
};

describe('firestore.rules — stakes/{sid}/auditLog/{auditId}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('audit-log');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('manager can read', async () => {
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(PATH).set(seedDoc);
    });
    await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).get());
  });

  it('stake-scope member is denied', async () => {
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(PATH).set(seedDoc);
    });
    await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
  });

  it('bishopric is denied', async () => {
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(PATH).set(seedDoc);
    });
    await assertFails(bishopricContext(env, STAKE_ID, ['01']).firestore().doc(PATH).get());
  });

  it('outsider is denied', async () => {
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(PATH).set(seedDoc);
    });
    await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(PATH).get());
  });

  it('anonymous denied', async () => {
    await assertFails(unauthedContext(env).firestore().doc(PATH).get());
  });

  it('cross-stake reads denied', async () => {
    const otherPath = `stakes/someother/auditLog/${AUDIT_ID}`;
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(otherPath).set(seedDoc);
    });
    await assertFails(managerContext(env, STAKE_ID).firestore().doc(otherPath).get());
  });

  it('all client writes denied — even from manager', async () => {
    const db = managerContext(env, STAKE_ID).firestore();
    await assertFails(db.doc(PATH).set(seedDoc));
  });

  it('all client writes denied — anonymous', async () => {
    await assertFails(unauthedContext(env).firestore().doc(PATH).set(seedDoc));
  });
});
