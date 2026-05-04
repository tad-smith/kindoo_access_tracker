// Fires on `stakes/{stakeId}/requests/{requestId}` writes and emits
// the matching email per `docs/spec.md` §9. Coexists with
// `pushOnRequestSubmit` (Phase 10.5) — that trigger handles push for
// the new-request transition only; this trigger handles email for all
// four lifecycle transitions (submit, complete, reject, cancel).
//
// Lifecycle detection:
//   - `before == null` && `after.status == 'pending'`        → new request → managers
//   - `before.status == 'pending'` && after.status flipped:
//       complete  → requester
//       rejected  → requester
//       cancelled → managers
//
// Best-effort: Resend errors land as `email_send_failed` audit rows
// inside `EmailService` rather than re-throwing. Pin to APP_SA so the
// trigger has the same identity as the rest of the function suite.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import type { AccessRequest, RequestStatus, Stake } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { activeManagerEmails } from '../lib/managers.js';
import {
  notifyManagersCancelled,
  notifyManagersNewRequest,
  notifyRequesterCompleted,
  notifyRequesterRejected,
} from '../services/EmailService.js';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
// Operator sets this at deploy time. EmailService reads it via
// `process.env.WEB_BASE_URL` from the link builder.
const WEB_BASE_URL = defineString('WEB_BASE_URL', {
  description:
    'Base URL of the web app (e.g. https://stakebuildingaccess.org). Used in email body deep-links.',
});

export const notifyOnRequestWrite = onDocumentWritten(
  {
    document: 'stakes/{stakeId}/requests/{requestId}',
    serviceAccount: APP_SA,
    secrets: [RESEND_API_KEY],
  },
  async (event) => {
    if (!event.data) return;
    const before = event.data.before?.exists ? (event.data.before.data() as AccessRequest) : null;
    const after = event.data.after?.exists ? (event.data.after.data() as AccessRequest) : null;
    const { stakeId, requestId } = event.params as { stakeId: string; requestId: string };

    const transition = classify(before, after);
    if (transition === null) return;

    // Touch the param so firebase-functions registers it on the
    // function spec at deploy time. The actual value is read via
    // `process.env.WEB_BASE_URL` inside EmailService's link builder.
    void WEB_BASE_URL.value();

    const db = getDb();
    const stakeSnap = await db.doc(`stakes/${stakeId}`).get();
    if (!stakeSnap.exists) {
      logger.warn('notifyOnRequestWrite: stake doc missing', { stakeId, requestId });
      return;
    }
    const stake = stakeSnap.data() as Stake;

    switch (transition) {
      case 'newRequest': {
        const managers = await activeManagerEmails(db, stakeId);
        await notifyManagersNewRequest({
          db,
          stakeId,
          stake,
          req: after!,
          managerEmails: managers,
        });
        return;
      }
      case 'completed': {
        await notifyRequesterCompleted({ db, stakeId, stake, req: after! });
        return;
      }
      case 'rejected': {
        await notifyRequesterRejected({ db, stakeId, stake, req: after! });
        return;
      }
      case 'cancelled': {
        const managers = await activeManagerEmails(db, stakeId);
        await notifyManagersCancelled({ db, stakeId, stake, req: after!, managerEmails: managers });
        return;
      }
    }
  },
);

type Transition = 'newRequest' | 'completed' | 'rejected' | 'cancelled';

function classify(before: AccessRequest | null, after: AccessRequest | null): Transition | null {
  // Pure delete (rules forbid; defensive).
  if (!after) return null;

  // Create — only fire when the new doc is `pending`. Anything else
  // implies a programmatic seed or a misuse.
  if (!before) {
    return after.status === 'pending' ? 'newRequest' : null;
  }

  // Update — only the pending → terminal flips fire.
  if (before.status !== 'pending') return null;
  if (after.status === before.status) return null;

  return statusToTransition(after.status);
}

function statusToTransition(status: RequestStatus): Transition | null {
  switch (status) {
    case 'complete':
      return 'completed';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}
