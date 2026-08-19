// `syncBootstrapClaims` — fires on every write to `stakes/{stakeId}`.
// Mints or clears the `bootstrap` marker (see `StakeClaims.bootstrap`
// in `@kindoo/shared`) on the designated bootstrap admin's claim
// block for that stake.
//
// `bootstrap` is NOT a role — it grants no access. It exists so the
// bootstrap admin's stake shows up in the web switcher before the
// wizard has run: `createStake` writes `bootstrap_admin_email` on the
// parent stake doc but mints no other claim (the wizard doesn't
// create the `kindooManagers` doc — and thus a real claim — until
// later), so without this signal nothing tells the switcher which
// stake(s) a freshly-signed-in admin should see.
//
// Reconciles off the AFTER state, not the before/after transition: on
// every write, compute the desired marker from `(bootstrap_admin_email,
// setup_complete)` in `after` and converge the claim toward it. A stake
// doc's `bootstrap_admin_email` is set once at `createStake` and never
// cleared, so this runs on every subsequent write to that doc for the
// rest of its life — including ones that have nothing to do with
// bootstrap (config changes, `last_over_caps_json`, seat-count churn).
// That's deliberate: reconciling only on eligibility transitions (the
// prior design) means a lost update racing a concurrent same-uid claim
// write, a failed claim write, or a half-completed backfill leaves the
// marker permanently wrong, with nothing left to heal it. Converging on
// every write means the very next write to the doc — whatever it is —
// fixes a stuck marker.
//
// This is safe from token churn because `applyBootstrapClaim` (via
// `applyClaims.ts`'s `loadExistingClaims`/`claimsEqual`) reads the
// user's current claim block and only calls `setCustomUserClaims` +
// `revokeRefreshTokens` when the merged result actually differs — so
// the steady-state cost of reconciling on every write is an extra
// `getUserByEmail` + claims read, never a write or a revoke. Do NOT
// short-circuit that read-then-compare step with an early return keyed
// on "did anything change" — that's exactly the bug this replaced.
//
// The prior designated email (`before`'s raw `bootstrap_admin_email`,
// regardless of its own eligibility) is reconciled toward `false`
// whenever it differs from `after`'s, so a re-point or a doc delete
// still clears the old admin's marker even though after-state alone
// can't see it:
//   - before=null, after=X            → mint on X (if eligible)
//   - before=X, after=null            → clear on X (doc deleted or the
//                                        email field cleared)
//   - before=X, after=Y (X != Y)      → clear on X, converge Y
//   - before=X, after=X               → converge X (no-op if already
//                                        correct)
//
// Matches `firestore.rules:157-163` `isBootstrapAdmin`'s equality
// check exactly: `bootstrap_admin_email` is already
// `.trim().toLowerCase()` from `createStake`, and Firebase Auth emits
// `token.email` lowercased, so the stored value is used verbatim as
// the `getUserByEmail` lookup key — NOT run through `canonicalEmail()`,
// which would fold Gmail dot/`+suffix` aliases and could resolve a
// different user than the one the rules will actually match (F19,
// `firebase-schema.md` §4.1).
//
// `setup_complete === false` exactly, not `!== true` — a stake the
// rules would refuse the wizard's writes on (absent or non-boolean
// `setup_complete`) must not be advertised as bootstrap-reachable.
//
// No-ops silently when no Auth user exists for the email — the common
// case, since a stake is usually created before its admin has ever
// signed in (see `seedClaimsFromRoleData` for the first-sign-in catch
// -up path). Follows the same benign-no-op handling as
// `applyClaims.ts`'s `loadExistingClaims`/`writeClaims` (commit
// 11556ee) rather than throwing, which would drop the event outright
// (this trigger doesn't set `retry`) and, where retries are enabled,
// burn the redelivery window on a user who doesn't exist yet.
//
// Reads `stakeId` off the event, never a cached stake-list — a warm
// instance holding a stale list is exactly the failure mode a
// claims-based design must avoid.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import type { Stake } from '@kindoo/shared';
import { canonicalize } from '../lib/canonicalEmail.js';
import { getAdminAuth } from '../lib/admin.js';
import { applyBootstrapClaim, isUserNotFound } from '../lib/applyClaims.js';

export const syncBootstrapClaims = onDocumentWritten('stakes/{stakeId}', async (event) => {
  const { stakeId } = event.params as { stakeId: string };
  if (!stakeId) return;

  const before = event.data?.before?.exists
    ? (event.data.before.data() as Partial<Stake> | undefined)
    : undefined;
  const after = event.data?.after?.exists
    ? (event.data.after.data() as Partial<Stake> | undefined)
    : undefined;

  const beforeCandidate = candidateEmailFor(before);
  const afterCandidate = candidateEmailFor(after);
  const desired = bootstrapEmailFor(after) !== null;

  // The doc no longer designates `beforeCandidate` (re-point or
  // delete) — it must not keep holding the marker, and after-state
  // alone can't see it, so clear it explicitly here.
  if (beforeCandidate && beforeCandidate !== afterCandidate) {
    await setBootstrapMarker(beforeCandidate, stakeId, false);
  }
  // Converge the currently-designated candidate toward its desired
  // state on every write — not just eligibility transitions — so a
  // stuck divergence heals on the next write regardless of cause.
  if (afterCandidate) {
    await setBootstrapMarker(afterCandidate, stakeId, desired);
  }
});

/**
 * The stake-doc snapshot's raw `bootstrap_admin_email`, lowercased at
 * the source and used verbatim — or null if the doc is absent or the
 * field isn't a non-empty string. Ignores `setup_complete`; this is
 * "who does the doc designate," not "is that designation live" (see
 * {@link bootstrapEmailFor} for the latter).
 */
function candidateEmailFor(data: Partial<Stake> | undefined): string | null {
  if (!data) return null;
  const email = data.bootstrap_admin_email;
  if (typeof email !== 'string' || email === '') return null;
  return email;
}

/**
 * The stake-doc snapshot's bootstrap-eligible email, or null. Eligible
 * iff `setup_complete` is the exact boolean `false` AND
 * `bootstrap_admin_email` is a non-empty string.
 */
function bootstrapEmailFor(data: Partial<Stake> | undefined): string | null {
  if (data?.setup_complete !== false) return null;
  return candidateEmailFor(data);
}

/** Look up the Auth user for `email` and mint/clear the marker on `stakeId`'s block. */
async function setBootstrapMarker(email: string, stakeId: string, flag: boolean): Promise<void> {
  const auth = getAdminAuth();
  let uid: string;
  try {
    uid = (await auth.getUserByEmail(email)).uid;
  } catch (err) {
    if (isUserNotFound(err)) {
      logger.info('skipping bootstrap claim sync: no auth user for email', { stakeId, flag });
      return;
    }
    throw err;
  }

  const canonical = canonicalize(email);
  await applyBootstrapClaim(uid, canonical, stakeId, flag);
}
