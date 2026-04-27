// Helpers for spinning up `@firebase/rules-unit-testing` against the
// committed firestore.rules. Phase 1 ships only the scaffolding; Phase 3
// adds real per-collection rules and per-match-block test files that
// reuse the helpers here.
//
// The helper reads firestore.rules from a path relative to THIS file,
// not from the test's CWD — vitest runs tests from the workspace root
// but the rules file lives one level up.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// firestore/tests/lib/rules.ts → firestore/firestore.rules
const RULES_PATH = resolve(__dirname, '..', '..', 'firestore.rules');

/**
 * Initialise a rules-unit-testing environment loaded with the committed
 * firestore.rules. `host`/`port` default to the Firestore emulator's
 * standard 127.0.0.1:8080; override via FIRESTORE_EMULATOR_HOST if
 * running on a non-default port.
 *
 * `stakeId` is folded into the synthetic emulator project ID so test
 * files using different stakes get isolated emulator state. Phase 3
 * multi-stake rules tests will pass a real stake slug here; until then,
 * the default keeps every rules test under one synthetic project.
 */
export async function setupTestEnv(stakeId?: string): Promise<RulesTestEnvironment> {
  const projectId = stakeId ? `kindoo-rules-test-${stakeId}` : 'kindoo-rules-test';
  return initializeTestEnvironment({
    projectId,
    firestore: {
      rules: readFileSync(RULES_PATH, 'utf8'),
    },
  });
}

/**
 * Reset all data in the rules-test environment. Call between test cases
 * to keep them isolated; tearing down + rebuilding the env on every test
 * is much slower than `clearFirestore()`.
 */
export async function clearAll(env: RulesTestEnvironment): Promise<void> {
  await env.clearFirestore();
}

/**
 * Build a Firestore handle authenticated as the given uid (with optional
 * custom claims). Phase 3 will pass the same shape of token claims that
 * Phase 2's claim-sync triggers stamp on real users.
 */
export function authedContext(
  env: RulesTestEnvironment,
  uid: string,
  claims?: Record<string, unknown>,
): RulesTestContext {
  return env.authenticatedContext(uid, claims);
}

/**
 * Build a Firestore handle with no auth — the "anonymous reader" case
 * that the lock-everything stub denies for every path.
 */
export function unauthedContext(env: RulesTestEnvironment): RulesTestContext {
  return env.unauthenticatedContext();
}
