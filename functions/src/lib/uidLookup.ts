// `uidForCanonical` — bridge from canonical-email-keyed role data to
// Firebase Auth's uid-keyed user records.
//
// Role data (access docs, kindooManagers docs, platformSuperadmins)
// uses canonical emails as primary keys. `setCustomUserClaims`
// requires a uid. The `userIndex/{canonical}` collection bridges the
// two — written by `onAuthUserCreate` on first sign-in.
//
// If a role doc is written for a canonical email that hasn't signed
// in yet, no `userIndex` entry exists. The caller (a sync trigger)
// no-ops in that case; when the user *does* sign in,
// `onAuthUserCreate` calls `seedClaimsFromRoleData` which will pick
// up the role.

import type { UserIndexEntry } from '@kindoo/shared';
import { getDb } from './admin.js';

/**
 * Look up the Firebase Auth uid for a canonical email by reading
 * `userIndex/{canonical}`. Returns null if no entry exists — the
 * user hasn't completed a first sign-in yet.
 */
export async function uidForCanonical(canonical: string): Promise<string | null> {
  if (!canonical) return null;
  const db = getDb();
  const snap = await db.doc(`userIndex/${canonical}`).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<UserIndexEntry> | undefined;
  if (!data || typeof data.uid !== 'string' || data.uid === '') return null;
  return data.uid;
}
