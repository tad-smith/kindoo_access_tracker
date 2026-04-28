// `onAuthUserCreate` — fires when Firebase Auth creates a new user
// (i.e., on first sign-in). Two responsibilities:
//
//   1. Write `userIndex/{canonical}` so canonical-email-keyed role
//      data has a uid bridge for sync triggers to read.
//   2. Compute claims from any pre-existing role data the user
//      qualifies for, stamp them via `setCustomUserClaims`, and
//      revoke refresh tokens so the next request picks them up.
//
// Implementation notes:
//
// - `firebase-functions/v2/identity` only exposes BLOCKING auth
//   triggers (`beforeUserCreated` / `beforeUserSignedIn`). We want a
//   post-create non-blocking trigger so a transient Firestore hiccup
//   doesn't block sign-in itself; the only such trigger is v1's
//   `auth.user().onCreate`. The migration plan locks in "all
//   functions are 2nd gen"; v1 auth triggers are still supported by
//   the platform and don't carry the gen-1 region/scaling
//   limitations the rest of the architecture is avoiding (this trigger
//   is fired at most ~1/user/lifetime, so cold-start cost is
//   immaterial).
//
// - First-sign-in is rare (≤ ~250 events ever for v1 stake size); we
//   intentionally don't optimise the read pattern.
//
// - We never look up the uid via `getUserByEmail` here — the user
//   is THIS event's subject; the uid is on the event itself.

import { auth as v1Auth } from 'firebase-functions/v1';
import type { UserRecord } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../lib/admin.js';
import { canonicalize } from '../lib/canonicalEmail.js';
import { seedClaimsFromRoleData } from '../lib/seedClaims.js';
import { applyFullClaims } from '../lib/applyClaims.js';

export const onAuthUserCreate = v1Auth.user().onCreate(async (user: UserRecord) => {
  const typedEmail = user.email ?? '';
  if (!typedEmail) {
    // No email on the auth record — this happens with phone-only or
    // anonymous sign-in flows we don't expect in this app. Bail
    // without writing anything; the user will hit NotAuthorized at
    // the SPA's role check.
    return;
  }
  const canonical = canonicalize(typedEmail);
  if (!canonical) return;

  const db = getDb();

  // 1. userIndex bridge.
  await db.doc(`userIndex/${canonical}`).set({
    uid: user.uid,
    typedEmail,
    lastSignIn: FieldValue.serverTimestamp(),
  });

  // 2. Seed claims from any pre-existing role data. The `canonical`
  //    field is always set so rules can rely on
  //    `request.auth.token.canonical`.
  const claims = await seedClaimsFromRoleData(user.uid, canonical);
  await applyFullClaims(user.uid, claims);
});
