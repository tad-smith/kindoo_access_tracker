// Pure decision logic for the setup-complete gate, shared between
// `routes/_authed.tsx` and `routes/index.tsx` so the two route gates
// can never drift. The single source of truth for "given the current
// principal + stake-doc subscription state, where do we send the user?"
//
// Per `docs/firebase-migration.md` §Phase 7 + `docs/spec.md` §10:
//
//   1. No Firebase Auth user                      → 'sign-in'
//   2. Stake-doc subscription still pending       → 'pending'
//   3. Stake doc loaded with setup_complete !== true (false, missing
//      field, or doc absent — Option A: an absent stake doc reads as
//      "not set up" rather than "fully set up"):
//        a. Token email canonicalises to the stake doc's
//           bootstrap_admin_email                  → 'wizard'
//        b. Otherwise                              → 'setup-in-progress'
//   4. Stake doc loaded with setup_complete === true:
//        a. Principal has any role claims          → 'authed'
//        b. Otherwise                              → 'not-authorized'
//
// Why setup_complete is checked with `=== true` (not `=== false` like
// the previous gate did): the reverse polarity is what blew up on
// staging. A stake doc with `setup_complete: false` plus a missing
// `bootstrap_admin_email` field, viewed by a manager-claimed user, fell
// through both gate branches and rendered the role-default Dashboard.
// The strict `=== true` check guarantees only an explicit, fully-typed
// "yes, setup is done" value lets a claim-bearing user past the gate;
// every other state — including the doc not yet existing on a freshly-
// provisioned stake — surfaces SetupInProgress (or the wizard for the
// designated bootstrap admin) instead.
//
// Why we treat absent as setup_complete=false (Option A):
//   The operator MUST seed the stake doc per the runbook. An absent
//   doc is "not yet set up", not "fully set up". The strict-truthy
//   polarity above already enforces this at the type level; we
//   document it here so future changes don't accidentally let absent
//   docs through.
//
// Why we block on pending instead of shortcutting no-claims users to
// NotAuthorized: rendering NotAuthorized while the stake doc is still
// pending creates a brief flash for the rare "non-admin during
// bootstrap" case that re-renders into SetupInProgress once the
// snapshot lands. The flash is jarring; rendering null briefly while
// the listener fires (typically <100ms in practice) is cleaner. The
// previous gate justified the flash by citing slow Firestore
// permission-denied callbacks in CI, but the rules already explicitly
// allow any authed user to read the parent stake doc during
// `setup_complete=false` (firestore.rules
// `isSetupInProgressReadable`), so the snapshot lands quickly.

import { canonicalEmail as canonicalEmailFn } from '@kindoo/shared';
import type { Stake } from '@kindoo/shared';

/**
 * Minimal shape consumed from `usePrincipal()`. Kept narrow so this
 * module doesn't pull the full `Principal` type and the unit tests can
 * synthesize inputs without constructing a full Firebase user.
 */
export type GatePrincipal = {
  firebaseAuthSignedIn: boolean;
  isAuthenticated: boolean;
  email: string | null | undefined;
  canonical?: string | null | undefined;
};

/**
 * Minimal shape consumed from `useFirestoreDoc(stakeRef(...))`. We
 * accept whatever subset of the result the gate actually inspects; the
 * caller passes through the live result. `data` is `undefined` when
 * the doc doesn't exist, when the subscription hasn't yielded a
 * snapshot yet, or when an error fired.
 */
export type GateStakeRead = {
  data: Partial<Stake> | undefined;
  status: 'pending' | 'success' | 'error';
};

export type GateDecision =
  | 'sign-in'
  | 'pending'
  | 'wizard'
  | 'setup-in-progress'
  | 'not-authorized'
  | 'authed';

/**
 * Pure decision: where does this user belong? Idempotent — call as
 * often as you like; identical inputs always produce the identical
 * decision string.
 */
export function gateDecision(principal: GatePrincipal, stake: GateStakeRead): GateDecision {
  if (!principal.firebaseAuthSignedIn) {
    return 'sign-in';
  }

  // Stake-doc subscription not yet resolved — render null in the
  // caller. We don't try to decide anything until the snapshot lands.
  // An `error` state at the listener level (e.g., listener errored
  // because the rules denied) is treated the same as pending: the
  // gate has no data to decide with, so we surface the safest
  // fallback (the not-authorized branch below) only AFTER the listener
  // had a chance to settle. In practice the rules permit any authed
  // read while setup is incomplete; `error` here means the listener
  // genuinely couldn't read, which is the post-setup no-claims case.
  if (stake.status === 'pending') {
    return 'pending';
  }

  // Strict-truthy polarity — anything that isn't an explicit boolean
  // `true` (false, missing field, doc absent) is treated as "setup
  // not complete". See file header for the staging repro that
  // justifies this. Listener errors fall through here too: an authed
  // user whose stake-doc read errored AFTER pending is the post-setup
  // no-claims case (rules denied the read), and the next branch
  // routes them to NotAuthorized.
  const setupComplete = stake.data?.setup_complete === true;

  if (!setupComplete) {
    // setup_complete=false branch — wizard for the bootstrap admin,
    // SetupInProgress for everyone else (incl. zero-claims users and
    // claim-bearing users alike: SetupInProgress takes precedence
    // over both Dashboard and NotAuthorized during setup).
    const adminCanonical = canonicalEmailFn(stake.data?.bootstrap_admin_email ?? '');
    const meCanonical = principal.canonical ?? canonicalEmailFn(principal.email ?? '');
    if (adminCanonical && meCanonical && adminCanonical === meCanonical) {
      return 'wizard';
    }
    return 'setup-in-progress';
  }

  // Post-setup. Claim-bearing users go to their role-default; users
  // with no claims see NotAuthorized (wrong account, or bishopric
  // import lag per `docs/spec.md` §6).
  if (!principal.isAuthenticated) {
    return 'not-authorized';
  }
  return 'authed';
}
