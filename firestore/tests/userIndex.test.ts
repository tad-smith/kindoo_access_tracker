// Rules tests for `userIndex/{canonicalEmail}` — the Phase 2
// match block.
//
// Layout matches the read/write matrix in
// `docs/firebase-schema.md` §3.1: the user themselves can read their
// own bridge entry (uid match), nobody else can read it, no client can
// write at all (the `onAuthUserCreate` trigger writes via Admin SDK,
// bypassing rules).
//
// We use the compat-style chained API exposed off `ctx.firestore()`
// (the `RulesTestContext.firestore()` return type) rather than the v9
// modular API, so the test file doesn't have to import from
// `firebase/firestore` directly — `@firebase/rules-unit-testing`
// already pulls the firebase peer dep in its types.
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  authedContext,
  clearAll,
  seedAsAdmin,
  setupTestEnv,
  unauthedContext,
} from './lib/rules.js';

const PATH = 'userIndex/alice@gmail.com';

const seedDoc = {
  uid: 'alice-uid',
  typedEmail: 'Alice@gmail.com',
  // Use a Date — the compat firestore SDK accepts JS Date and
  // serialises to a Timestamp. Tests don't assert on the exact
  // timestamp value.
  lastSignIn: new Date(),
};

describe('firestore.rules — userIndex', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('user-index');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('denies anonymous reads', async () => {
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(PATH).set(seedDoc);
    });
    const db = unauthedContext(env).firestore();
    await assertFails(db.doc(PATH).get());
  });

  it('allows the owning user (uid match) to read their own entry', async () => {
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(PATH).set(seedDoc);
    });
    const db = authedContext(env, 'alice-uid').firestore();
    await assertSucceeds(db.doc(PATH).get());
  });

  it('denies reads when the auth uid does not match the doc uid', async () => {
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(PATH).set(seedDoc);
    });
    const db = authedContext(env, 'bob-uid').firestore();
    await assertFails(db.doc(PATH).get());
  });

  it('denies client writes from anonymous, owner, and other-uid contexts', async () => {
    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(PATH).set(seedDoc);
    });
    const anonDb = unauthedContext(env).firestore();
    const ownerDb = authedContext(env, 'alice-uid').firestore();
    const otherDb = authedContext(env, 'bob-uid').firestore();

    await assertFails(anonDb.doc(PATH).set(seedDoc));
    await assertFails(ownerDb.doc(PATH).set(seedDoc));
    await assertFails(otherDb.doc(PATH).set(seedDoc));
  });

  it('denies anonymous reads of an absent doc (no uid to compare against)', async () => {
    // This is the "phishing path" where a caller probes existence by
    // hitting a guessed canonical email. Rules deny pre-doc-load
    // because resource.data is undefined.
    const anonDb = unauthedContext(env).firestore();
    await assertFails(anonDb.doc('userIndex/who@example.com').get());
    const authedDb = authedContext(env, 'someone').firestore();
    await assertFails(authedDb.doc('userIndex/who@example.com').get());
  });
});
