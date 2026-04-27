// Smoke test for the Phase 1 rules-test scaffolding.
//
// Asserts that the lock-everything firestore.rules stub denies an
// unauthenticated read of an arbitrary path. That denial IS the stub's
// behaviour — every path returns `if false`. Phase 3 replaces this with
// per-collection suites that exercise the real allow/deny matrix.
import { afterAll, beforeAll, describe, it } from 'vitest';
import { assertFails } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { setupTestEnv, unauthedContext } from './lib/rules.js';

describe('firestore.rules — lock-everything stub', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('stub');
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('denies unauthenticated reads of any path', async () => {
    const db = unauthedContext(env).firestore();
    await assertFails(db.collection('anything').doc('here').get());
  });
});
