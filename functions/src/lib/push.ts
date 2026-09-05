// Push fanout to a set of managers: collect their tokens, send one
// data-only multicast, prune the tokens FCM rejects as permanently
// invalid.
//
// One copy, two callers: the `pushOnRequestSubmit` trigger, and
// `sendSyncReminderIfDue` (`services/SyncReminderService.ts`), which is
// complete but reached by no trigger yet — its invoker arrives with the
// scheduled-task work.
// The pruning half in particular is the reason this is shared: it
// decides which FCM failures cost a user their registration, and two
// copies of that list would silently disagree about which device stops
// receiving notifications.
//
// Never throws on partial send failure — invalid tokens are routine
// (browser uninstall, extension reset) and not an error condition. A
// throw here would fail the calling trigger for something that is
// working as designed.

import { logger } from 'firebase-functions';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { MulticastMessage } from 'firebase-admin/messaging';
import type { UserIndexEntry } from '@kindoo/shared';
import { getSender } from './messaging.js';

/**
 * Push categories a user can subscribe to, keyed as they appear under
 * `userIndex.notificationPrefs.push`. Every category is opt-in: an
 * absent key means "not subscribed", so the gate below reads `=== true`
 * and never `!== false`.
 */
export type PushCategory = 'newRequest' | 'syncReminder';

/** Just enough of a recipient to look their userIndex doc up. */
export type PushRecipient = { canonical: string };

type PerToken = { canonical: string; deviceId: string; token: string };

export type PushResult = {
  /** Recipients who were subscribed and had at least one token. */
  subscribers: number;
  tokensSent: number;
  tokensInvalid: number;
  tokensCleaned: number;
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

/**
 * Send `data` to every recipient subscribed to `category`.
 *
 * `data` is the whole payload — data-only, no `notification` block.
 * With both blocks present Chrome auto-displays the `notification` AND
 * the service worker's `onBackgroundMessage` handler fires for the
 * `data` payload, producing two notifications. Data-only routes 100%
 * through the SW (`firebase-messaging-sw.template.js`), which reads
 * `data.title` / `data.body` and calls `showNotification` exactly once.
 * FCM requires every `data` value to be a string, so callers coerce at
 * this boundary rather than at the SW's.
 *
 * `context` is folded into every log line so a caller stays traceable.
 */
export async function sendPushToSubscribers(
  db: Firestore,
  opts: {
    source: string;
    category: PushCategory;
    recipients: readonly PushRecipient[];
    data: Record<string, string>;
    context?: Record<string, unknown>;
  },
): Promise<PushResult> {
  const { source, category, recipients, data } = opts;
  const context = { source, category, ...(opts.context ?? {}) };
  const empty: PushResult = { subscribers: 0, tokensSent: 0, tokensInvalid: 0, tokensCleaned: 0 };
  if (recipients.length === 0) return empty;

  const indexFetches = await Promise.all(
    recipients.map(async ({ canonical }) => ({
      canonical,
      idxSnap: await db.doc(`userIndex/${canonical}`).get(),
    })),
  );

  const perToken: PerToken[] = [];
  const subscribed = new Set<string>();
  for (const { canonical, idxSnap } of indexFetches) {
    if (!idxSnap.exists) continue;
    const idx = idxSnap.data() as UserIndexEntry;
    if (idx.notificationPrefs?.push?.[category] !== true) continue;
    const tokens = idx.fcmTokens ?? {};
    for (const [deviceId, token] of Object.entries(tokens)) {
      if (typeof token === 'string' && token.length > 0) {
        perToken.push({ canonical, deviceId, token });
        subscribed.add(canonical);
      }
    }
  }

  if (perToken.length === 0) {
    logger.info('push skipped — no subscribed recipients', context);
    return empty;
  }

  const message: MulticastMessage = { data, tokens: perToken.map((p) => p.token) };
  const response = await getSender().sendEachForMulticast(message);

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
    logger.warn('push: FCM rejected token', {
      ...context,
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

  const result: PushResult = {
    subscribers: subscribed.size,
    tokensSent: response.successCount,
    tokensInvalid,
    tokensCleaned,
  };
  logger.info('push sent', { ...context, ...result });
  return result;
}
