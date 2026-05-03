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
import type { AccessRequest, KindooManager, RequestType, UserIndexEntry } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { getSender } from '../lib/messaging.js';

type PerToken = { canonical: string; deviceId: string; token: string };

const TYPE_LABEL: Record<RequestType, string> = {
  add_manual: 'add',
  add_temp: 'add (temp)',
  remove: 'remove',
};

export const pushOnRequestSubmit = onDocumentCreated(
  {
    document: 'stakes/{stakeId}/requests/{requestId}',
    serviceAccount: APP_SA,
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

    // Active managers — same shape as `seedClaims.ts`'s manager check.
    const managersSnap = await db
      .collection(`stakes/${stakeId}/kindooManagers`)
      .where('active', '==', true)
      .get();
    if (managersSnap.empty) return;

    // Resolve userIndex per manager; filter to subscribed + has tokens.
    const indexFetches = await Promise.all(
      managersSnap.docs.map(async (mDoc) => {
        const canonical = (mDoc.data() as KindooManager).member_canonical ?? mDoc.id;
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

    const message: MulticastMessage = {
      notification: {
        title: 'New request',
        body: buildBody(req),
      },
      data: {
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
    // FieldValue.delete for each invalid token's slot, grouped by owning doc.
    const cleanups = new Map<string, Record<string, unknown>>();
    response.responses.forEach((res, i) => {
      if (res.success) return;
      tokensInvalid++;
      const code = res.error?.code;
      if (
        code !== 'messaging/registration-token-not-registered' &&
        code !== 'messaging/invalid-registration-token'
      ) {
        return;
      }
      const slot = perToken[i];
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
