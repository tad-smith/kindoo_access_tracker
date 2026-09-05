// Fires when a request doc is created (status='pending'). Fans an FCM
// push to every active manager whose userIndex carries
// `notificationPrefs.push.newRequest === true` and at least one
// `fcmTokens` entry.
//
// Token collection, the data-only payload, and invalid-token pruning
// all live in `lib/push.ts` — this trigger only decides who and what.
//
// Email is the source-of-truth fallback, sent by sibling
// `notifyOnRequestWrite.ts`. For now: silent skip when no managers
// are subscribed to push.

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import type { AccessRequest, RequestType } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { activeManagers } from '../lib/managers.js';
import { sendPushToSubscribers } from '../lib/push.js';

const TYPE_LABEL: Record<RequestType, string> = {
  add_manual: 'add',
  add_temp: 'add (temp)',
  remove: 'remove',
  edit_auto: 'edit (auto)',
  edit_manual: 'edit (manual)',
  edit_temp: 'edit (temp)',
};

export const pushOnRequestSubmit = onDocumentCreated(
  {
    document: 'stakes/{stakeId}/requests/{requestId}',
    serviceAccount: APP_SA,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const req = snap.data() as AccessRequest;
    const { stakeId, requestId } = event.params as { stakeId: string; requestId: string };

    const db = getDb();

    // Active managers — shared helper used by both notification triggers.
    const managers = await activeManagers(db, stakeId);
    if (managers.length === 0) return;

    logger.info('pushOnRequestSubmit: firing', { stakeId, requestId, managers: managers.length });
    await sendPushToSubscribers(db, {
      source: 'pushOnRequestSubmit',
      category: 'newRequest',
      recipients: managers,
      data: {
        title: 'New request',
        body: buildBody(req),
        requestId,
        // `stake` param ensures multi-stake managers tapping the push
        // land in the stake that owns the request — URL tier wins over
        // storage tiers in the active-stake resolver (spec §2.1).
        deepLink: `/manager/queue?focus=${requestId}&stake=${stakeId}`,
      },
      context: { stakeId, requestId },
    });
  },
);

function buildBody(req: AccessRequest): string {
  const subject = req.member_name?.trim() || req.member_email || 'Someone';
  const typeLabel = TYPE_LABEL[req.type];
  const reason = req.reason?.trim();
  const reasonSuffix = reason ? ` (${reason})` : '';
  return `${subject} — ${typeLabel}${reasonSuffix}`;
}
