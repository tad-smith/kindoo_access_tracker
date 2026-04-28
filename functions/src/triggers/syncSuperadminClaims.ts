// `syncSuperadminClaims` — fires on every write to
// `platformSuperadmins/{memberCanonical}`. Toggles the user's
// top-level `isPlatformSuperadmin` claim based on doc presence.
//
// v1 has no superadmins (the allow-list is managed via Firestore
// console per `firebase-schema.md` §3.2). This trigger is wired now
// so the surface is identical when Phase B turns the superadmin role
// on; if the doc is never created, the trigger never fires.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { uidForCanonical } from '../lib/uidLookup.js';
import { applySuperadminClaim } from '../lib/applyClaims.js';

export const syncSuperadminClaims = onDocumentWritten(
  'platformSuperadmins/{memberCanonical}',
  async (event) => {
    const { memberCanonical } = event.params as { memberCanonical: string };
    if (!memberCanonical) return;

    const uid = await uidForCanonical(memberCanonical);
    if (!uid) return;

    const exists = event.data?.after?.exists ?? false;
    await applySuperadminClaim(uid, memberCanonical, exists);
  },
);
