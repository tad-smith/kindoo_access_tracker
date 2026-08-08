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
// Driven off the before/after snapshots' `(bootstrap_admin_email,
// setup_complete)` pair, matched into the single lowercased email
// (or null) that is eligible to be the marker, each side:
//   - before=null, after=X            → mint on X
//   - before=X, after=null            → clear on X (setup completed,
//                                        doc deleted, or the email
//                                        field was cleared)
//   - before=X, after=Y (X != Y)      → clear on X, mint on Y
//   - before=X, after=X               → no-op (nothing changed)
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
// 11556ee) rather than throwing, which would make Eventarc retry
// forever.
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

  const beforeEmail = bootstrapEmailFor(before);
  const afterEmail = bootstrapEmailFor(after);

  if (beforeEmail === afterEmail) return;

  if (beforeEmail) await setBootstrapMarker(beforeEmail, stakeId, false);
  if (afterEmail) await setBootstrapMarker(afterEmail, stakeId, true);
});

/**
 * The stake-doc snapshot's bootstrap-eligible email, or null. Eligible
 * iff `setup_complete` is the exact boolean `false` AND
 * `bootstrap_admin_email` is a non-empty string.
 */
function bootstrapEmailFor(data: Partial<Stake> | undefined): string | null {
  if (!data) return null;
  if (data.setup_complete !== false) return null;
  const email = data.bootstrap_admin_email;
  if (typeof email !== 'string' || email === '') return null;
  return email;
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
