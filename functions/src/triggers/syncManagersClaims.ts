// `syncManagersClaims` — fires on every write to
// `stakes/{stakeId}/kindooManagers/{memberCanonical}`. Recomputes the
// user's per-stake claims from scratch (via `computeStakeClaims`)
// rather than incrementally toggling the manager bit, because the
// "right" answer is always derivable from role data — no merge
// surprises.
//
// Cost is one read per manager-flip event, which is human-frequency.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { computeStakeClaims } from '../lib/seedClaims.js';
import { uidForCanonical } from '../lib/uidLookup.js';
import { applyStakeClaims } from '../lib/applyClaims.js';

export const syncManagersClaims = onDocumentWritten(
  'stakes/{stakeId}/kindooManagers/{memberCanonical}',
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
