// Callable: lets a freshly signed-in user discover whether they are
// the bootstrap admin of a not-yet-set-up stake. `createStake` writes
// `bootstrap_admin_email` on the parent stake doc but mints no custom
// claim — the wizard doesn't create the manager doc (and thus the
// claim) until later — so nothing else in the system can answer
// "which stake am I the bootstrap admin of?". A client-side query
// can't do this either: rules can't scope a `list` to "docs where
// bootstrap_admin_email == me" without leaking every stake's name and
// admin email to any signed-in user. Discovery has to be server-side.
//
// Auth: any signed-in caller — deliberately no role gate, since role
// discovery is the entire point. This is safe because the query only
// ever returns a stake whose `bootstrap_admin_email` already equals
// the caller's own token email.
//
// Match on plain lowercase, NOT `canonicalEmail()`. Mirrors
// `firestore.rules` `isBootstrapAdmin` (`get(stakePath).data.bootstrap_admin_email
// == request.auth.token.email`) and `createStake.ts`, which stores
// `.trim().toLowerCase()` with Gmail dots and `+suffix` preserved (see
// F19 / `firebase-schema.md` §4.1). Canonicalising here could resolve
// a stakeId whose rules predicate then refuses the wizard's writes —
// worse than the current bug.
//
// `setup_complete` gate: only a stake still mid-setup is eligible.
// Post-setup access is claim-gated like everything else, so a
// completed stake must return `null` here even on an exact email
// match.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { ResolveBootstrapStakeOutput, Stake } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';

export const resolveBootstrapStake = onCall(
  { serviceAccount: APP_SA },
  async (req): Promise<ResolveBootstrapStakeOutput> => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'sign in required');
    }

    // Firebase Auth always emits this lowercased.
    const email = req.auth.token.email;
    if (!email) {
      return { stakeId: null };
    }

    const db = getDb();
    const snap = await db.collection('stakes').where('bootstrap_admin_email', '==', email).get();

    // Multiple matches shouldn't happen in practice (an operator would
    // have to reuse the same bootstrap admin email across two
    // in-progress stakes), but pick deterministically so repeat calls
    // are stable rather than racing on Firestore's unspecified order.
    const stakeId = snap.docs
      .filter((d) => (d.data() as Stake).setup_complete !== true)
      .map((d) => d.id)
      .sort()[0];

    return { stakeId: stakeId ?? null };
  },
);
