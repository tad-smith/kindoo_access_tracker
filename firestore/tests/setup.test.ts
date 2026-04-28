// Smoke test for the rules-test scaffolding. Phases 1–2 had a
// "lock-everything" stub for `firestore.rules`; Phase 3 replaces it
// with the real per-collection matrix. The smoke test is preserved
// for the harness it exercises (`@firebase/rules-unit-testing` is
// loaded; the rules file at the configured path parses cleanly), but
// it now asserts deny on a path that has no specific match block —
// the catch-all behaviour of the rules system is "no allow → deny."
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
