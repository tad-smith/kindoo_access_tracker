// `syncAccessClaims` — fires on every write to
// `stakes/{stakeId}/access/{memberCanonical}`. Recomputes the user's
// `stakes[stakeId].stake` + `stakes[stakeId].wards` claims from the
// post-write doc shape, then writes them via `setCustomUserClaims` +
// `revokeRefreshTokens`.
//
// The `manager` flag is not derived from the access doc (it lives in
// `kindooManagers/`); we re-read it inside `computeStakeClaims` so the
// per-stake block is always self-consistent. That extra read is one
// per access write — fine at this scale.
//
// If the canonical's user has never signed in (`userIndex/` entry
// absent), the trigger no-ops: when the user *does* sign in,
// `onAuthUserCreate` calls `seedClaimsFromRoleData` which will pick
// up the role.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { computeStakeClaims } from '../lib/seedClaims.js';
import { uidForCanonical } from '../lib/uidLookup.js';
import { applyStakeClaims } from '../lib/applyClaims.js';

export const syncAccessClaims = onDocumentWritten(
  'stakes/{stakeId}/access/{memberCanonical}',
  async (event) => {
    const { stakeId, memberCanonical } = event.params as {
      stakeId: string;
      memberCanonical: string;
    };
    if (!stakeId || !memberCanonical) return;

    const uid = await uidForCanonical(memberCanonical);
    if (!uid) return;

    const stakeClaims = await computeStakeClaims(stakeId, memberCanonical);
    await applyStakeClaims(uid, memberCanonical, stakeId, stakeClaims);
  },
);
