// Helpers for spinning up `@firebase/rules-unit-testing` against the
// committed firestore.rules. Phase 1 shipped scaffolding; Phase 2 added
// `seedAsAdmin`. Phase 3 adds the stake-aware auth helpers
// (`managerContext`, `stakeMemberContext`, `bishopricContext`,
// `superadminContext`) that build the same custom-claims shape Phase 2's
// sync triggers stamp on real users.
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
 * files using different stakes get isolated emulator state. The
 * project ID has a `demo-` prefix so the emulator allows offline use
 * without prompting for credentials.
 */
export async function setupTestEnv(stakeId?: string): Promise<RulesTestEnvironment> {
  const projectId = stakeId ? `demo-kindoo-rules-${stakeId}` : 'demo-kindoo-rules';
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
 * custom claims). Phase 3 rules read the same shape of token claims that
 * the Phase 2 claim-sync triggers stamp on real users.
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
 * that the locked-down paths deny by default.
 */
export function unauthedContext(env: RulesTestEnvironment): RulesTestContext {
  return env.unauthenticatedContext();
}

/**
 * Run `fn` with rules disabled — the way to seed documents for a rules
 * test. The Admin SDK does the same thing in Cloud Functions; in tests
 * `withSecurityRulesDisabled` is the equivalent affordance.
 */
export async function seedAsAdmin(
  env: RulesTestEnvironment,
  fn: (ctx: RulesTestContext) => Promise<void>,
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await fn(ctx);
  });
}

// ---- Stake-aware identity helpers -----------------------------------
//
// All four helpers below stamp the same custom-claims layout that
// `syncManagersClaims` / `syncAccessClaims` / `syncSuperadminClaims`
// produce on real users — `canonical` + `stakes[stakeId].{manager,
// stake, wards}` (+ `isPlatformSuperadmin`). The rules read these
// fields off the auth token unchanged, so a context built here
// behaves identically to a real signed-in user with the matching role
// docs.
//
// The `email` field on the token is the typed display form, set so
// `lastActorMatchesAuth` can verify it against `lastActor.email` on
// every client write. Tests pass typed emails like `'Mgr@gmail.com'`
// (uppercase / mixed case preserved) and the helper also derives the
// canonical form for the `canonical` claim.

const TYPED_EMAILS: Record<string, string> = {
  manager: 'Mgr@gmail.com',
  stakeMember: 'StakeUser@gmail.com',
  bishopric: 'Bishop@gmail.com',
  outsider: 'Outsider@gmail.com',
  superadmin: 'Superadmin@gmail.com',
  bootstrapAdmin: 'Bootstrap@gmail.com',
};

const CANONICAL_EMAILS: Record<string, string> = {
  manager: 'mgr@gmail.com',
  stakeMember: 'stakeuser@gmail.com',
  bishopric: 'bishop@gmail.com',
  outsider: 'outsider@gmail.com',
  superadmin: 'superadmin@gmail.com',
  bootstrapAdmin: 'bootstrap@gmail.com',
};

/** Synthetic identity (typed email + canonical) used for tests that do not need a custom email. */
export type Persona = {
  uid: string;
  email: string;
  canonical: string;
};

/** A persona for each of the test roles. Tests can also build their own. */
export const personas: {
  manager: Persona;
  stakeMember: Persona;
  bishopric: Persona;
  outsider: Persona;
  superadmin: Persona;
  bootstrapAdmin: Persona;
} = {
  manager: {
    uid: 'uid-mgr',
    email: TYPED_EMAILS['manager']!,
    canonical: CANONICAL_EMAILS['manager']!,
  },
  stakeMember: {
    uid: 'uid-stake',
    email: TYPED_EMAILS['stakeMember']!,
    canonical: CANONICAL_EMAILS['stakeMember']!,
  },
  bishopric: {
    uid: 'uid-bishop',
    email: TYPED_EMAILS['bishopric']!,
    canonical: CANONICAL_EMAILS['bishopric']!,
  },
  outsider: {
    uid: 'uid-outsider',
    email: TYPED_EMAILS['outsider']!,
    canonical: CANONICAL_EMAILS['outsider']!,
  },
  superadmin: {
    uid: 'uid-superadmin',
    email: TYPED_EMAILS['superadmin']!,
    canonical: CANONICAL_EMAILS['superadmin']!,
  },
  bootstrapAdmin: {
    uid: 'uid-bootstrap',
    email: TYPED_EMAILS['bootstrapAdmin']!,
    canonical: CANONICAL_EMAILS['bootstrapAdmin']!,
  },
};

/** A `lastActor` payload matching a given persona — every client-write fixture needs one. */
export function lastActorOf(p: Persona): { email: string; canonical: string } {
  return { email: p.email, canonical: p.canonical };
}

type RoleClaims = {
  manager?: boolean;
  stake?: boolean;
  wards?: string[];
};

/**
 * Build a context authenticated as `persona`, with `stakes[stakeId]`
 * carrying the supplied role flags. Pass an empty `roleClaims` to
 * simulate a signed-in user with no role under that stake (the
 * "outsider" case).
 */
export function contextFor(
  env: RulesTestEnvironment,
  persona: Persona,
  stakeId: string,
  roleClaims: RoleClaims,
): RulesTestContext {
  return env.authenticatedContext(persona.uid, {
    email: persona.email,
    email_verified: true,
    canonical: persona.canonical,
    stakes: {
      [stakeId]: {
        manager: roleClaims.manager === true,
        stake: roleClaims.stake === true,
        wards: roleClaims.wards ?? [],
      },
    },
  });
}

/** Convenience: a manager under `stakeId`. */
export function managerContext(env: RulesTestEnvironment, stakeId: string): RulesTestContext {
  return contextFor(env, personas.manager, stakeId, { manager: true });
}

/** Convenience: a stake-scope member under `stakeId`. */
export function stakeMemberContext(env: RulesTestEnvironment, stakeId: string): RulesTestContext {
  return contextFor(env, personas.stakeMember, stakeId, { stake: true });
}

/** Convenience: a bishopric member with visibility into `wards` under `stakeId`. */
export function bishopricContext(
  env: RulesTestEnvironment,
  stakeId: string,
  wards: string[],
): RulesTestContext {
  return contextFor(env, personas.bishopric, stakeId, { wards });
}

/**
 * Convenience: an authenticated user with no role under `stakeId`. The
 * `email` + `canonical` claims are still set (so `authedCanonical()`
 * resolves), but no entry exists for `stakeId` in the `stakes` map.
 */
export function outsiderContext(env: RulesTestEnvironment, stakeId: string): RulesTestContext {
  return env.authenticatedContext(personas.outsider.uid, {
    email: personas.outsider.email,
    email_verified: true,
    canonical: personas.outsider.canonical,
    stakes: {
      // Deliberately a different stake — the user is signed in but has
      // no claims under `stakeId`. Cross-stake denial tests use this.
      'demo-other-stake': { manager: true, stake: true, wards: [] },
    },
    // Empty stake claim object would also work; keeping `stakes` populated
    // exercises the "stake claims exist but not for this stakeId" branch.
    [`__test_skipStake_${stakeId}`]: true,
  });
}

/** Convenience: a platform superadmin (cross-stake). */
export function superadminContext(env: RulesTestEnvironment): RulesTestContext {
  return env.authenticatedContext(personas.superadmin.uid, {
    email: personas.superadmin.email,
    email_verified: true,
    canonical: personas.superadmin.canonical,
    isPlatformSuperadmin: true,
  });
}

/**
 * Convenience: a signed-in bootstrap admin — `email` + `canonical` set
 * (matching what `onAuthUserCreate` stamps on first sign-in) but NO
 * `stakes` claims, so `isManager` / `isStakeMember` / `isAnyMember` all
 * return false. The rule-level `isBootstrapAdmin(stakeId)` is the only
 * thing that should authorise this context's writes (and only while
 * `setup_complete=false` on the matching stake doc).
 *
 * Tests using this helper must seed the stake doc with
 * `bootstrap_admin_email == personas.bootstrapAdmin.email` and the
 * desired `setup_complete` value before exercising the rule.
 */
export function bootstrapAdminContext(env: RulesTestEnvironment): RulesTestContext {
  return env.authenticatedContext(personas.bootstrapAdmin.uid, {
    email: personas.bootstrapAdmin.email,
    email_verified: true,
    canonical: personas.bootstrapAdmin.canonical,
    // Deliberately no `stakes` block — this is the load-bearing
    // property for the bootstrap-wizard rules tests.
  });
}
