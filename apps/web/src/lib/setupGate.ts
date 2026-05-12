// Pure decision logic for the setup-complete gate, shared between
// `routes/_authed.tsx` and `routes/index.tsx` so the two route gates
// can never drift. The single source of truth for "given the current
// principal + stake-doc subscription state, where do we send the user?"
//
// Per `docs/spec.md` §10:
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

  // Stake-doc subscription not yet resolved.
  //
  // For an authed (claim-bearing) user we render null in the caller
  // so a manager who's also the bootstrap admin doesn't flash the
  // dashboard before the wizard gate fires.
  //
  // For a no-claims user we shortcut to NotAuthorized immediately.
  // Two reasons:
  //   (a) The post-setup wrong-account case is the common path; the
  //       listener will eventually error with permission-denied (rules
  //       require isAnyMember) and the gate would land on
  //       NotAuthorized anyway.
  //   (b) Avoiding the listener on this code path sidesteps a known
  //       Firestore JS SDK 12.x assertion crash ("Unexpected state
  //       ID: ca9") that fires when onSnapshot encounters a
  //       permission-denied response on initial connection. Keeping
  //       no-claims users on the immediate-NotAuthorized path keeps
  //       the SPA from rendering its error boundary in production.
  //
  // The brief flash of NotAuthorized for the rare "non-admin during
  // bootstrap" case (where the listener succeeds and the gate
  // re-renders into SetupInProgress) is acceptable; a 5-second blank
  // page or a crashed app is not.
  if (stake.status === 'pending') {
    return principal.isAuthenticated ? 'pending' : 'not-authorized';
  }

  // Listener error path. The most common cause is a no-claims user
  // hitting a `setup_complete=true` stake: the read rules require
  // `isAnyMember`, so the listener errors with permission-denied
  // (the `isSetupInProgressReadable` gate goes silent the moment
  // `setup_complete` flips to true). We surface NotAuthorized in
  // that case rather than SetupInProgress — the user genuinely lacks
  // access.
  //
  // For an authed (claim-bearing) user, the rules permit the read at
  // all states, so an `error` here is a transient connection issue
  // or a rules misconfiguration. NotAuthorized is the safest failure
  // mode (better than letting them past the gate on a stake we
  // couldn't read).
  if (stake.status === 'error') {
    return 'not-authorized';
  }

  const data = stake.data;
  const setupComplete = data?.setup_complete === true;

  if (data === undefined) {
    // Successful read but no data: the doc doesn't exist. Two
    // possible causes that the SDK can't distinguish from the
    // client side:
    //   (a) the operator hasn't seeded the stake doc yet, OR
    //   (b) the rules denied the read but the SDK reported "doesn't
    //       exist" instead of erroring (some emulator + offline
    //       paths surface this way).
    //
    // For a no-claims user we resolve the ambiguity towards
    // NotAuthorized — case (b) is by far the more common one in
    // practice (post-setup wrong-account / bishopric-import-lag
    // path per spec §6 + §10). The rarer case (a) — a no-claims
    // user hitting a never-seeded stake — still surfaces a
    // reasonable page (NotAuthorized prompts them to contact the
    // admin, who'll then run the seed runbook).
    //
    // For a claim-bearing user the rules permit the read at all
    // states; "doesn't exist" is unambiguous case (a). Per Option
    // A from the staging-bug fix (2026-04-29), an absent stake doc
    // is treated as setup-incomplete: the operator MUST seed the
    // stake doc per the runbook, and absent should be a "this
    // isn't set up yet" state, not "this is fully set up." Route
    // them to SetupInProgress.
    if (!principal.isAuthenticated) {
      return 'not-authorized';
    }
    return 'setup-in-progress';
  }

  if (!setupComplete) {
    // Strict-truthy polarity — anything that isn't an explicit
    // boolean `true` (false, missing field, non-boolean value) is
    // treated as setup-incomplete. See file header for the staging
    // repro that justifies this. Wizard for the bootstrap admin,
    // SetupInProgress for everyone else (incl. zero-claims users and
    // claim-bearing users alike — SetupInProgress takes precedence
    // over both Dashboard and NotAuthorized during setup).
    const adminCanonical = canonicalEmailFn(data.bootstrap_admin_email ?? '');
    // `||` not `??`: the principal's `canonical` claim is the empty
    // string (not null/undefined) for a user whose `onAuthUserCreate`
    // trigger has not yet minted claims — the bootstrap admin's very
    // first sign-in. `??` only falls back on null/undefined and treats
    // `''` as present, so the typed-email canonicalization branch never
    // ran and the wizard route was unreachable on a fresh project.
    // See B-2 in `docs/BUGS.md`.
    const meCanonical = principal.canonical || canonicalEmailFn(principal.email ?? '');
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
