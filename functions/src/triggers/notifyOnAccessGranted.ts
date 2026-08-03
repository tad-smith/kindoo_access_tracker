// Fires on `stakes/{stakeId}/access/{memberCanonical}` writes and
// welcomes a member the first time their doc carries any app-access
// scope. Third trigger on this path alongside `syncAccessClaims` and
// `auditAccessWrites`; the document trigger is the only hook that sees
// every grant write path, including the raw client manual-grant write
// (which goes through no callable).
//
// Fires iff the before-doc has zero scopes and the after-doc has at
// least one:
//   - first grant                      → fires
//   - scope added to an existing holder → silent (already welcomed)
//   - revoke down to zero scopes        → silent
//   - re-grant after a full revoke      → fires again (intended)
//
// Best-effort like the other email triggers: Resend errors land as
// `email_send_failed` audit rows inside `EmailService` rather than
// re-throwing. Delivery is at-least-once — a retried invocation sends a
// second copy, accepted at this scale.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import type { Stake } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { isActiveManagerDoc, isLimitedTier, scopesFromAccessDoc } from '../lib/seedClaims.js';
import { notifyMemberAccessGranted } from '../services/EmailService.js';

// `WEB_BASE_URL` is registered at module load by `lib/params.ts`,
// imported transitively via EmailService. No re-import needed here.
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

export const notifyOnAccessGranted = onDocumentWritten(
  {
    document: 'stakes/{stakeId}/access/{memberCanonical}',
    serviceAccount: APP_SA,
    secrets: [RESEND_API_KEY],
  },
  async (event) => {
    if (!event.data) return;
    const after = event.data.after?.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : undefined;
    // A delete is never a grant.
    if (!after) return;
    const before = event.data.before?.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : undefined;

    const grantedScopes = scopesFromAccessDoc(after);
    if (!hasAnyScope(grantedScopes)) return;
    if (hasAnyScope(scopesFromAccessDoc(before))) return;

    const { stakeId, memberCanonical } = event.params as {
      stakeId: string;
      memberCanonical: string;
    };

    const db = getDb();
    // Manager status comes from the doc plus `active === true`, never
    // from the claim, which can be ~1h stale on an idle session.
    const [stakeSnap, managerSnap] = await Promise.all([
      db.doc(`stakes/${stakeId}`).get(),
      db.doc(`stakes/${stakeId}/kindooManagers/${memberCanonical}`).get(),
    ]);
    if (!stakeSnap.exists) {
      logger.warn('notifyOnAccessGranted: stake doc missing', { stakeId, memberCanonical });
      return;
    }
    const stake = stakeSnap.data() as Stake;
    const isLimited = isLimitedTier({
      limited: grantedScopes.limited,
      manager: managerSnap.exists && isActiveManagerDoc(managerSnap.data()),
    });

    // The doc id is itself a canonical email, so it's a valid recipient
    // when the typed form is missing.
    const memberEmail = (after['member_email'] as string | undefined)?.trim() || memberCanonical;
    const memberName = (after['member_name'] as string | undefined)?.trim();

    await notifyMemberAccessGranted({
      db,
      stakeId,
      stake,
      memberCanonical,
      memberEmail,
      ...(memberName ? { memberName } : {}),
      grantedScopes,
      isLimited,
    });
  },
);

function hasAnyScope(scopes: { hasStake: boolean; wards: string[] }): boolean {
  return scopes.hasStake || scopes.wards.length > 0;
}
