// Rules tests for `userIndex/{canonicalEmail}` — the Phase 2
// match block, extended in Phase 10.5 with self-update for
// `fcmTokens` + `notificationPrefs` + `lastActor`.
//
// Layout matches the read/write matrix in
// `docs/firebase-schema.md` §3.1: the user themselves can read their
// own bridge entry (uid match), nobody else can read it. Create +
// delete remain server-only; update is permitted ONLY for the push
// keys (allowlist + lastActor integrity).
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

const ALICE_TYPED = 'Alice@gmail.com';
const ALICE_CANONICAL = 'alice@gmail.com';
const ALICE_UID = 'alice-uid';
const PATH = `userIndex/${ALICE_CANONICAL}`;

const seedDoc = {
  uid: ALICE_UID,
  typedEmail: ALICE_TYPED,
  // Use a Date — the compat firestore SDK accepts JS Date and
  // serialises to a Timestamp. Tests don't assert on the exact
  // timestamp value.
  lastSignIn: new Date(),
};

const aliceLastActor = { email: ALICE_TYPED, canonical: ALICE_CANONICAL };

/** Build a synthetic auth context mirroring what `onAuthUserCreate` stamps. */
function ownerContext(env: RulesTestEnvironment) {
  return env.authenticatedContext(ALICE_UID, {
    email: ALICE_TYPED,
    email_verified: true,
    canonical: ALICE_CANONICAL,
  });
}

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

  it('denies client create/delete (server-only)', async () => {
    const ownerDb = ownerContext(env).firestore();
    await assertFails(ownerDb.doc(PATH).set(seedDoc));

    await seedAsAdmin(env, async (ctx) => {
      await ctx.firestore().doc(PATH).set(seedDoc);
    });
    await assertFails(ownerDb.doc(PATH).delete());
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

  describe('self-update (push subscribe)', () => {
    beforeAll(async () => {
      // env initialised in outer beforeAll.
    });

    it('allows owner to update fcmTokens + notificationPrefs + lastActor', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = ownerContext(env).firestore();
      await assertSucceeds(
        db.doc(PATH).update({
          fcmTokens: { d1: 'tok-1' },
          notificationPrefs: { push: { newRequest: true } },
          lastActor: aliceLastActor,
        }),
      );
    });

    it('denies update touching uid', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = ownerContext(env).firestore();
      await assertFails(
        db.doc(PATH).update({
          uid: 'someone-else',
          lastActor: aliceLastActor,
        }),
      );
    });

    it('denies update touching typedEmail', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = ownerContext(env).firestore();
      await assertFails(
        db.doc(PATH).update({
          typedEmail: 'pwned@example.com',
          lastActor: aliceLastActor,
        }),
      );
    });

    it('denies update touching lastSignIn', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = ownerContext(env).firestore();
      await assertFails(
        db.doc(PATH).update({
          lastSignIn: new Date(0),
          lastActor: aliceLastActor,
        }),
      );
    });

    it('denies update without a matching lastActor.canonical', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = ownerContext(env).firestore();
      await assertFails(
        db.doc(PATH).update({
          fcmTokens: { d1: 'tok-1' },
          lastActor: { email: 'mallory@example.com', canonical: 'mallory@example.com' },
        }),
      );
    });

    it('denies update by a different uid (foreign owner)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      // bob-uid signed in, with bob's canonical claim — but the doc
      // belongs to alice. resource.data.uid !== request.auth.uid → deny.
      const db = env
        .authenticatedContext('bob-uid', {
          email: 'Bob@gmail.com',
          email_verified: true,
          canonical: 'bob@gmail.com',
        })
        .firestore();
      await assertFails(
        db.doc(PATH).update({
          fcmTokens: { d1: 'tok-bob' },
          lastActor: { email: 'Bob@gmail.com', canonical: 'bob@gmail.com' },
        }),
      );
    });

    it('denies update from an unauthenticated client', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(seedDoc);
      });
      const db = unauthedContext(env).firestore();
      await assertFails(
        db.doc(PATH).update({
          fcmTokens: { d1: 'tok-1' },
          lastActor: aliceLastActor,
        }),
      );
    });
  });
});
