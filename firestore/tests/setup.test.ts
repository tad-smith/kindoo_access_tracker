// Smoke test for the rules-test scaffolding. Exercises the harness
// (`@firebase/rules-unit-testing` is loaded; the rules file at the
// configured path parses cleanly), and asserts deny on a path that
// has no specific match block — the catch-all behaviour of the rules
// system is "no allow → deny."
//
// The detailed per-collection allow/deny matrix lives in the sibling
// `*.test.ts` files (one per match block).
import { afterAll, beforeAll, describe, it } from 'vitest';
import { assertFails } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { setupTestEnv, unauthedContext } from './lib/rules.js';

describe('firestore.rules — smoke', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('smoke');
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('denies unauthenticated reads of an arbitrary unmatched path', async () => {
    const db = unauthedContext(env).firestore();
    await assertFails(db.collection('arbitraryUnmatchedCollection').doc('here').get());
  });
});
