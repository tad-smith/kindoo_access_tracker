// Fires when a request doc is created (status='pending'). Fans an FCM
// push to every active manager whose userIndex carries
// `notificationPrefs.push.newRequest === true` and at least one
// `fcmTokens` entry.
//
// Invalid tokens reported by FCM are pruned from the owning userIndex
// doc so the next fire skips them. The trigger never throws on partial
// send failures — invalid tokens are routine (browser uninstall,
// extension reset) and not an error condition.
//
// Phase 9 (deferred, gated on T-04) will extend this trigger or sibling
// `notifyOnRequestWrite.ts` to send email as the source-of-truth
// fallback. For now: silent skip when no managers are subscribed.

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import type { MulticastMessage } from 'firebase-admin/messaging';
import type { AccessRequest, RequestType, UserIndexEntry } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { activeManagers } from '../lib/managers.js';
import { getSender } from '../lib/messaging.js';

type PerToken = { canonical: string; deviceId: string; token: string };

const TYPE_LABEL: Record<RequestType, string> = {
  add_manual: 'add',
  add_temp: 'add (temp)',
  remove: 'remove',
};

// FCM error codes for which the offending token will never succeed for
// THIS sender and should be pruned from `userIndex.fcmTokens`. Anything
// else (transient: quota-exceeded, server-unavailable, internal-error,
// authentication-error) leaves the token in place for the next fire.
const UNRECOVERABLE_CODES = new Set<string>([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/mismatched-credential',
  'messaging/sender-id-mismatch',
  'messaging/invalid-argument',
]);

export const pushOnRequestSubmit = onDocumentCreated(
  {
    document: 'stakes/{stakeId}/requests/{requestId}',
    serviceAccount: APP_SA.value(),
  },
  async (event) => {
    logger.info('[pushOnRequestSubmit] entry');
    const snap = event.data;
    if (!snap) return;
    const req = snap.data() as AccessRequest;
    const { stakeId, requestId } = event.params as { stakeId: string; requestId: string };

    logger.info('[pushOnRequestSubmit] calling getDb()');
    const db = getDb();
    logger.info('[pushOnRequestSubmit] getDb() returned');

    // Active managers — shared helper used by both notification triggers.
    const managers = await activeManagers(db, stakeId);
    if (managers.length === 0) return;

    // Resolve userIndex per manager; filter to subscribed + has tokens.
    const indexFetches = await Promise.all(
      managers.map(async ({ canonical }) => {
        const idxSnap = await db.doc(`userIndex/${canonical}`).get();
        return { canonical, idxSnap };
      }),
    );

    const perToken: PerToken[] = [];
    for (const { canonical, idxSnap } of indexFetches) {
      if (!idxSnap.exists) continue;
      const idx = idxSnap.data() as UserIndexEntry;
      if (idx.notificationPrefs?.push?.newRequest !== true) continue;
      const tokens = idx.fcmTokens ?? {};
      for (const [deviceId, token] of Object.entries(tokens)) {
        if (typeof token === 'string' && token.length > 0) {
          perToken.push({ canonical, deviceId, token });
        }
      }
    }

    if (perToken.length === 0) {
      logger.info('pushOnRequestSubmit: no subscribed managers', { requestId, stakeId });
      return;
    }

    // Data-only payload — no `notification` block. With both blocks
    // present, Chrome auto-displays the `notification` AND the SW's
    // `onBackgroundMessage` handler also fires for the `data` payload,
    // resulting in two notifications. Data-only routes 100% through the
    // SW (`firebase-messaging-sw.template.js`), which reads `data.title`
    // / `data.body` and calls `showNotification` exactly once.
    //
    // FCM `data` values must all be strings — coerce non-string fields
    // here rather than at the SW boundary.
    const message: MulticastMessage = {
      data: {
        title: 'New request',
        body: buildBody(req),
        requestId,
        deepLink: `/manager/queue?focus=${requestId}`,
      },
      tokens: perToken.map((p) => p.token),
    };

    logger.info('[pushOnRequestSubmit] about to call getSender().sendEachForMulticast', {
      tokenCount: perToken.map((p) => p.token).length,
    });
    const response = await getSender().sendEachForMulticast(message);
    logger.info('[pushOnRequestSubmit] sendEachForMulticast returned');

    let tokensInvalid = 0;
    let tokensCleaned = 0;
    // FieldValue.delete for each unrecoverable token's slot, grouped by
    // owning doc. Per-failure log emits the FCM code + message + token
    // prefix so operators can tell at a glance what the cluster of
    // failures looks like (auth misconfig vs stale tokens vs transient).
    const cleanups = new Map<string, Record<string, unknown>>();
    response.responses.forEach((res, i) => {
      if (res.success) return;
      tokensInvalid++;
      const slot = perToken[i];
      const code = res.error?.code;
      logger.warn('[pushOnRequestSubmit] FCM rejected token', {
        requestId,
        stakeId,
        index: i,
        canonical: slot?.canonical,
        deviceId: slot?.deviceId,
        tokenPrefix: slot?.token.slice(0, 16),
        code,
        message: res.error?.message,
      });
      if (!code || !UNRECOVERABLE_CODES.has(code)) return;
      if (!slot) return;
      const existing = cleanups.get(slot.canonical) ?? {};
      existing[`fcmTokens.${slot.deviceId}`] = FieldValue.delete();
      cleanups.set(slot.canonical, existing);
      tokensCleaned++;
    });

    for (const [canonical, update] of cleanups) {
      await db.doc(`userIndex/${canonical}`).update(update);
    }

    logger.info('pushOnRequestSubmit', {
      requestId,
      stakeId,
      tokensSent: response.successCount,
      tokensInvalid,
      tokensCleaned,
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
