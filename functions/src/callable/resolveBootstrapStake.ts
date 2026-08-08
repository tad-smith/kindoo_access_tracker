// Callable: lets a freshly signed-in user discover every not-yet-set-up
// stake they're the bootstrap admin of. `createStake` writes
// `bootstrap_admin_email` on the parent stake doc but mints no custom
// claim — the wizard doesn't create the manager doc (and thus the
// claim) until later — so nothing else in the system can answer
// "which stake(s) am I the bootstrap admin of?". A client-side query
// can't do this either: rules can't scope a `list` to "docs where
// bootstrap_admin_email == me" without leaking every stake's name and
// admin email to any signed-in user. Discovery has to be server-side.
//
// A caller can be the bootstrap admin of more than one stake at once
// (e.g. a platform superadmin who provisioned several, or an email
// reused across two in-progress stakes) — return all of them and let
// the web switcher list every match rather than guessing which one
// the caller wants. This also means every signed-in session calls
// this once, not just zero-claims sessions, so the no-match path
// (empty result) has to stay a single cheap equality query — no
// caching, no batching.
//
// Auth: any signed-in caller — deliberately no role gate, since role
// discovery is the entire point. This is safe because the query only
// ever returns stakes whose `bootstrap_admin_email` already equals
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
// completed stake is excluded even on an exact email match.
//
// Requires an exact boolean `false`, matching `firestore.rules:157-163`
// `isBootstrapAdmin`'s `get(stakePath).data.setup_complete == false` —
// NOT `setupGate.ts`'s strict-truthy `=== true` polarity. The gate and
// the rules already diverge on this field; this callable must follow
// the rules, because the rules are what gate the wizard's writes. A
// doc where the field is absent or holds a non-boolean value fails the
// rule's `== false` too, so handing back that stakeId would open the
// wizard only to have every write refused with permission-denied — a
// worse outcome than the NotAuthorized page this callable exists to
// avoid. Do not "harmonise" this with the gate's polarity.

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
      return { stakeIds: [] };
    }

    const db = getDb();
    const snap = await db.collection('stakes').where('bootstrap_admin_email', '==', email).get();

    // Sorted so repeat calls are stable rather than racing on
    // Firestore's unspecified order.
    const stakeIds = snap.docs
      .filter((d) => (d.data() as Stake).setup_complete === false)
      .map((d) => d.id)
      .sort();

    return { stakeIds };
  },
);
