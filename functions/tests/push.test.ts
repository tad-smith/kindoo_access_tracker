// Integration tests for `lib/push.ts` — the shared fanout, driven
// directly rather than through a trigger.
//
// Two behaviours are covered here because they are the ones a second
// caller can break. The `category` gate is the whole reason the fanout
// takes a category at all: `newRequest` and `syncReminder` are separate
// opt-ins, and a subscriber to one must not be reached by the other.
// The pruning list decides which FCM failures cost a device its
// registration — a regression there silently stops delivering to real
// users, and it now has two callers that would both inherit it.
//
// FCM is mocked at the wrapper level (`lib/messaging.ts`); Firestore is
// the emulator.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { BatchResponse } from 'firebase-admin/messaging';
import { sendPushToSubscribers, type PushCategory } from '../src/lib/push.js';
import { _setSender, type Sender } from '../src/lib/messaging.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const DATA = { title: 'T', body: 'B' };

async function seedUserIndex(
  canonical: string,
  data: {
    fcmTokens?: Record<string, string>;
    notificationPrefs?: { push?: { newRequest?: boolean; syncReminder?: boolean } };
  },
): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`userIndex/${canonical}`).set({
    uid: `uid-${canonical}`,
    typedEmail: canonical,
    lastSignIn: Timestamp.now(),
    ...data,
  });
}

async function tokensOf(canonical: string): Promise<Record<string, string>> {
  const { db } = requireEmulators();
  const snap = await db.doc(`userIndex/${canonical}`).get();
  return (snap.data() as { fcmTokens?: Record<string, string> }).fcmTokens ?? {};
}

function mockSender(responses: Array<{ success: boolean; errorCode?: string }>): {
  sender: Sender;
  calls: Array<{ tokens: string[] }>;
} {
  const calls: Array<{ tokens: string[] }> = [];
  const sender: Sender = {
    sendEachForMulticast: async (message) => {
      calls.push({ tokens: [...(message.tokens ?? [])] });
      const successCount = responses.filter((r) => r.success).length;
      const batch: BatchResponse = {
        successCount,
        failureCount: responses.length - successCount,
        responses: responses.map((r) =>
          r.success
            ? { success: true, messageId: 'mid' }
            : {
                success: false,
                error: {
                  code: r.errorCode ?? 'messaging/unknown',
                  message: 'mock failure',
                  toJSON: () => ({}),
                  name: 'FirebaseMessagingError',
                },
              },
        ),
      };
      return batch;
    },
  };
  return { sender, calls };
}

function send(
  category: PushCategory,
  recipients: string[],
): ReturnType<typeof sendPushToSubscribers> {
  const { db } = requireEmulators();
  return sendPushToSubscribers(db, {
    source: 'test',
    category,
    recipients: recipients.map((canonical) => ({ canonical })),
    data: DATA,
  });
}

describe.skipIf(!hasEmulators())('sendPushToSubscribers', () => {
  let restoreSender: (() => void) | undefined;

  beforeAll(async () => {
    await clearEmulators();
  });
  beforeEach(() => {
    restoreSender = undefined;
  });
  afterEach(async () => {
    if (restoreSender) restoreSender();
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  describe('category filter', () => {
    it('reaches only the subscribers of the category being sent', async () => {
      // Each opted into exactly one category, and neither into both.
      await seedUserIndex('alice@gmail.com', {
        fcmTokens: { d1: 'tok-alice' },
        notificationPrefs: { push: { newRequest: true, syncReminder: false } },
      });
      await seedUserIndex('bob@gmail.com', {
        fcmTokens: { d1: 'tok-bob' },
        notificationPrefs: { push: { newRequest: false, syncReminder: true } },
      });

      const first = mockSender([{ success: true }]);
      restoreSender = _setSender(first.sender);
      const newRequest = await send('newRequest', ['alice@gmail.com', 'bob@gmail.com']);
      expect(first.calls).toHaveLength(1);
      expect(first.calls[0]!.tokens).toEqual(['tok-alice']);
      expect(newRequest.subscribers).toBe(1);

      restoreSender();
      const second = mockSender([{ success: true }]);
      restoreSender = _setSender(second.sender);
      const syncReminder = await send('syncReminder', ['alice@gmail.com', 'bob@gmail.com']);
      expect(second.calls).toHaveLength(1);
      expect(second.calls[0]!.tokens).toEqual(['tok-bob']);
      expect(syncReminder.subscribers).toBe(1);
    });

    it('treats an absent category key as off — opting into one is not opting into both', async () => {
      // The realistic shape: an existing push subscriber, from before
      // `syncReminder` existed, whose prefs name only `newRequest`.
      await seedUserIndex('alice@gmail.com', {
        fcmTokens: { d1: 'tok-alice' },
        notificationPrefs: { push: { newRequest: true } },
      });
      const { sender, calls } = mockSender([]);
      restoreSender = _setSender(sender);

      const result = await send('syncReminder', ['alice@gmail.com']);

      expect(calls).toHaveLength(0);
      expect(result).toEqual({
        subscribers: 0,
        tokensSent: 0,
        tokensInvalid: 0,
        tokensCleaned: 0,
      });
    });

    it('sends to a subscriber opted into both', async () => {
      await seedUserIndex('carol@gmail.com', {
        fcmTokens: { d1: 'tok-carol' },
        notificationPrefs: { push: { newRequest: true, syncReminder: true } },
      });
      const { sender, calls } = mockSender([{ success: true }]);
      restoreSender = _setSender(sender);

      const result = await send('syncReminder', ['carol@gmail.com']);

      expect(calls[0]!.tokens).toEqual(['tok-carol']);
      expect(result.tokensSent).toBe(1);
    });

    it('skips a recipient with no notificationPrefs and one with no userIndex doc', async () => {
      await seedUserIndex('dee@gmail.com', { fcmTokens: { d1: 'tok-dee' } });
      const { sender, calls } = mockSender([]);
      restoreSender = _setSender(sender);

      const result = await send('syncReminder', ['dee@gmail.com', 'ghost@gmail.com']);

      expect(calls).toHaveLength(0);
      expect(result.subscribers).toBe(0);
    });

    it('does not send at all for an empty recipient list', async () => {
      const { sender, calls } = mockSender([]);
      restoreSender = _setSender(sender);

      const result = await send('syncReminder', []);

      expect(calls).toHaveLength(0);
      expect(result.tokensSent).toBe(0);
    });
  });

  describe('invalid-token pruning', () => {
    // Token order in the multicast is `Object.entries(fcmTokens)` order
    // within each recipient, recipients in the order passed — so the
    // response array below maps positionally onto d1, d2, d3.
    it('prunes each unrecoverable code and leaves the healthy slot', async () => {
      await seedUserIndex('alice@gmail.com', {
        fcmTokens: { d1: 'tok-unregistered', d2: 'tok-invalid', d3: 'tok-good' },
        notificationPrefs: { push: { syncReminder: true } },
      });
      const { sender } = mockSender([
        { success: false, errorCode: 'messaging/registration-token-not-registered' },
        { success: false, errorCode: 'messaging/invalid-registration-token' },
        { success: true },
      ]);
      restoreSender = _setSender(sender);

      const result = await send('syncReminder', ['alice@gmail.com']);

      expect(await tokensOf('alice@gmail.com')).toEqual({ d3: 'tok-good' });
      expect(result).toEqual({
        subscribers: 1,
        tokensSent: 1,
        tokensInvalid: 2,
        tokensCleaned: 2,
      });
    });

    it('keeps a token that failed with a transient code', async () => {
      await seedUserIndex('alice@gmail.com', {
        fcmTokens: { d1: 'tok-alice' },
        notificationPrefs: { push: { syncReminder: true } },
      });
      const { sender } = mockSender([{ success: false, errorCode: 'messaging/internal-error' }]);
      restoreSender = _setSender(sender);

      const result = await send('syncReminder', ['alice@gmail.com']);

      expect(await tokensOf('alice@gmail.com')).toEqual({ d1: 'tok-alice' });
      // Counted as a failure, but not as a cleanup — the device keeps
      // its registration for the next fire.
      expect(result.tokensInvalid).toBe(1);
      expect(result.tokensCleaned).toBe(0);
    });

    it('prunes only the failing recipient, leaving the other doc untouched', async () => {
      await seedUserIndex('alice@gmail.com', {
        fcmTokens: { d1: 'tok-alice-bad' },
        notificationPrefs: { push: { syncReminder: true } },
      });
      await seedUserIndex('bob@gmail.com', {
        fcmTokens: { d1: 'tok-bob-good' },
        notificationPrefs: { push: { syncReminder: true } },
      });
      const { sender } = mockSender([
        { success: false, errorCode: 'messaging/sender-id-mismatch' },
        { success: true },
      ]);
      restoreSender = _setSender(sender);

      await send('syncReminder', ['alice@gmail.com', 'bob@gmail.com']);

      expect(await tokensOf('alice@gmail.com')).toEqual({});
      expect(await tokensOf('bob@gmail.com')).toEqual({ d1: 'tok-bob-good' });
    });

    it('does not throw when every token is rejected', async () => {
      // Invalid tokens are routine, not an error condition: a throw here
      // would fail the calling trigger for something working as designed.
      await seedUserIndex('alice@gmail.com', {
        fcmTokens: { d1: 'tok-alice' },
        notificationPrefs: { push: { syncReminder: true } },
      });
      const { sender } = mockSender([
        { success: false, errorCode: 'messaging/mismatched-credential' },
      ]);
      restoreSender = _setSender(sender);

      await expect(send('syncReminder', ['alice@gmail.com'])).resolves.toMatchObject({
        tokensSent: 0,
        tokensCleaned: 1,
      });
    });
  });
});
