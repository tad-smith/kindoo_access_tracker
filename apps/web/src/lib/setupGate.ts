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
// While the stake-doc subscription is pending: an authed (claim-bearing)
// principal, or an unauthenticated principal who is the bootstrap admin
// of the active stake (`bootstrapStakes` includes it), waits ('pending')
// rather than being rejected — both are permitted to read the doc per
// the rules (`isAnyMember` / `isSetupInProgressReadable`), so the
// snapshot lands quickly and the wait is brief. Every other principal
// shortcuts straight to NotAuthorized rather than waiting; see the
// `stake.status === 'pending'` branch below for why.

import { canonicalEmail as canonicalEmailFn } from '@kindoo/shared';
import type { Stake } from '@kindoo/shared';

/**
 * Minimal shape consumed from `usePrincipal()`. Kept narrow so this
 * module doesn't pull the full `Principal` type and the unit tests can
 * synthesize inputs without constructing a full Firebase user.
 *
 * `isPlatformSuperadmin` is included so the gate can short-circuit
 * the "no active stake" case for a superadmin (see `gateDecision`
 * stake-doc-pending branch). Defaults to `false` when omitted.
 *
 * `bootstrapStakes` mirrors `Principal.bootstrapStakes` (per
 * `packages/shared`) — the stakes where this principal holds a
 * `bootstrap: true` claim. `bootstrap` is deliberately excluded from
 * `hasAnyRole` (so `isAuthenticated` stays `false` for a bootstrap-only
 * principal — that must NOT change), but the gate still needs to know
 * about it to avoid mis-treating a bootstrapping admin as a stranger
 * during the pending window (see the `stake.status === 'pending'`
 * branch below). Defaults to `[]` when omitted.
 */
export type GatePrincipal = {
  firebaseAuthSignedIn: boolean;
  isAuthenticated: boolean;
  isPlatformSuperadmin?: boolean;
  email: string | null | undefined;
  canonical?: string | null | undefined;
  bootstrapStakes?: string[];
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
export function gateDecision(
  principal: GatePrincipal,
  stake: GateStakeRead,
  activeStakeId: string | null = null,
): GateDecision {
  if (!principal.firebaseAuthSignedIn) {
    return 'sign-in';
  }

  // Platform superadmin with no active stake (zero per-stake roles).
  // The caller passes `null` to `useFirestoreDoc(stakeRef)` in that
  // case so the query is disabled and reports `status: 'pending'`
  // forever; the pending branch below would hang the route. Spec §2.1
  // sends this identity to `/superadmin/stakes`, so admit them past
  // the gate and let the caller's redirect logic (`defaultLandingFor`)
  // route them.
  if (principal.isPlatformSuperadmin === true && activeStakeId === null) {
    return 'authed';
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
  //
  // Exception: a bootstrap-only principal (`isAuthenticated: false` by
  // design — `bootstrap` deliberately does not count toward
  // `hasAnyRole`) whose `bootstrapStakes` names the active stake IS
  // permitted to read the stake doc while `setup_complete=false`
  // (rules' `isSetupInProgressReadable`), so (a) doesn't apply — the
  // listener will resolve, not permission-deny. Wait for it instead of
  // shortcutting to NotAuthorized; that shortcut is precisely the flash
  // this carve-out exists to eliminate.
  if (stake.status === 'pending') {
    const bootstrapping =
      activeStakeId !== null && (principal.bootstrapStakes ?? []).includes(activeStakeId);
    return principal.isAuthenticated || bootstrapping ? 'pending' : 'not-authorized';
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
  //
  // No bootstrapping carve-out here (unlike the pending branch above):
  // `isBootstrapAdmin`/`isSetupInProgressReadable` both require the
  // stake doc to `exists()`, so a bootstrap-only principal can only
  // reach `error` when the doc genuinely doesn't exist yet (an
  // unseeded stake) — a real failure, not a timing window. Already
  // uniform with the claim-bearing-user case above; kept that way.
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
    //
    // No bootstrapping carve-out here either, same reasoning as the
    // `error` branch above: `exists()`-gated rules mean a bootstrap-
    // only principal can't reach a successful-but-absent read on a
    // doc that's truly missing, so this stays the same "genuinely
    // ambiguous, fail safe" path as the no-claims case.
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
