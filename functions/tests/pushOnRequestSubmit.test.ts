// Integration tests for `pushOnRequestSubmit`. The trigger fires once
// per `onDocumentCreated` on a request — Firestore guarantees one fire
// per create event, so the trigger has no idempotency-on-double-fire
// branch to exercise. The cases below cover the read+filter pipeline
// + invalid-token cleanup.
//
// FCM is mocked at the wrapper level (`lib/messaging.ts`) so no
// network round-trip happens in tests.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';
import { pushOnRequestSubmit } from '../src/triggers/pushOnRequestSubmit.js';
import { _setSender, type Sender } from '../src/lib/messaging.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';
const REQUEST_ID = 'req-1';

type SendCall = MulticastMessage;

function makeEvent(after: Record<string, unknown>): never {
  const snap = {
    exists: true,
    data: () => after,
  };
  return {
    params: { stakeId: STAKE_ID, requestId: REQUEST_ID },
    time: '2026-04-29T12:00:00.000Z',
    data: snap,
  } as unknown as never;
}

const baseRequest = {
  request_id: REQUEST_ID,
  type: 'add_manual',
  scope: 'stake',
  member_email: 'Subject@gmail.com',
  member_canonical: 'subject@gmail.com',
  member_name: 'Subject Person',
  reason: 'Stake Clerk',
  comment: '',
  building_names: ['Main'],
  status: 'pending',
  requester_email: 'Mgr@gmail.com',
  requester_canonical: 'mgr@gmail.com',
  requested_at: Timestamp.now(),
  lastActor: { email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' },
};

async function seedManager(canonical: string, active: boolean): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/kindooManagers/${canonical}`).set({
    member_canonical: canonical,
    member_email: canonical,
    active,
    lastActor: { email: canonical, canonical },
  });
}

async function seedUserIndex(
  canonical: string,
  data: {
    fcmTokens?: Record<string, string>;
    notificationPrefs?: { push?: { newRequest: boolean } };
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

function mockSender(responses: Array<{ success: boolean; errorCode?: string }>): {
  sender: Sender;
  calls: SendCall[];
} {
  const calls: SendCall[] = [];
  const sender: Sender = {
    sendEachForMulticast: async (message) => {
      calls.push(message);
      const successCount = responses.filter((r) => r.success).length;
      const failureCount = responses.length - successCount;
      const batch: BatchResponse = {
        successCount,
        failureCount,
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

describe.skipIf(!hasEmulators())('pushOnRequestSubmit', () => {
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

  it('reads only managers where active===true (excludes inactive)', async () => {
    await seedManager('alice@gmail.com', true);
    await seedManager('bob@gmail.com', false); // inactive
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-alice' },
      notificationPrefs: { push: { newRequest: true } },
    });
    await seedUserIndex('bob@gmail.com', {
      fcmTokens: { d1: 'tok-bob' },
      notificationPrefs: { push: { newRequest: true } },
    });
    const { sender, calls } = mockSender([{ success: true }]);
    restoreSender = _setSender(sender);

    await pushOnRequestSubmit.run(makeEvent(baseRequest));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tokens).toEqual(['tok-alice']);
  });

  it('filters out managers whose notificationPrefs.push.newRequest !== true', async () => {
    await seedManager('alice@gmail.com', true);
    await seedManager('carl@gmail.com', true);
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-alice' },
      notificationPrefs: { push: { newRequest: true } },
    });
    await seedUserIndex('carl@gmail.com', {
      fcmTokens: { d1: 'tok-carl' },
      notificationPrefs: { push: { newRequest: false } }, // opted out
    });
    const { sender, calls } = mockSender([{ success: true }]);
    restoreSender = _setSender(sender);

    await pushOnRequestSubmit.run(makeEvent(baseRequest));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tokens).toEqual(['tok-alice']);
  });

  it('filters out managers with empty fcmTokens', async () => {
    await seedManager('alice@gmail.com', true);
    await seedManager('dee@gmail.com', true);
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-alice' },
      notificationPrefs: { push: { newRequest: true } },
    });
    await seedUserIndex('dee@gmail.com', {
      fcmTokens: {},
      notificationPrefs: { push: { newRequest: true } },
    });
    const { sender, calls } = mockSender([{ success: true }]);
    restoreSender = _setSender(sender);

    await pushOnRequestSubmit.run(makeEvent(baseRequest));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tokens).toEqual(['tok-alice']);
  });

  it('calls sendEachForMulticast exactly once with all subscribed tokens', async () => {
    await seedManager('alice@gmail.com', true);
    await seedManager('eve@gmail.com', true);
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-a1', d2: 'tok-a2' },
      notificationPrefs: { push: { newRequest: true } },
    });
    await seedUserIndex('eve@gmail.com', {
      fcmTokens: { d1: 'tok-e1' },
      notificationPrefs: { push: { newRequest: true } },
    });
    const { sender, calls } = mockSender([{ success: true }, { success: true }, { success: true }]);
    restoreSender = _setSender(sender);

    await pushOnRequestSubmit.run(makeEvent(baseRequest));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tokens?.sort()).toEqual(['tok-a1', 'tok-a2', 'tok-e1'].sort());
    // Data-only payload — `notification` block must be absent so the SW
    // is the single display path; double-fire bug regression.
    expect(calls[0]!.notification).toBeUndefined();
    expect(calls[0]!.data).toEqual({
      title: 'New request',
      body: expect.stringContaining('Subject Person'),
      requestId: REQUEST_ID,
      deepLink: `/manager/queue?focus=${REQUEST_ID}`,
    });
    // FCM constraint: every `data` value must be a string.
    for (const [k, v] of Object.entries(calls[0]!.data ?? {})) {
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
      // Reference k to keep the loop traceable on assertion failure.
      void k;
    }
  });

  it('removes a token reported as registration-token-not-registered', async () => {
    await seedManager('alice@gmail.com', true);
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-bad', d2: 'tok-good' },
      notificationPrefs: { push: { newRequest: true } },
    });
    const { sender } = mockSender([
      { success: false, errorCode: 'messaging/registration-token-not-registered' },
      { success: true },
    ]);
    restoreSender = _setSender(sender);

    // Note: token order in the multicast is iteration order of fcmTokens
    // entries — d1 first, then d2 — so response[0] maps to tok-bad.
    await pushOnRequestSubmit.run(makeEvent(baseRequest));

    const { db } = requireEmulators();
    const idx = await db.doc('userIndex/alice@gmail.com').get();
    const tokens = (idx.data() as { fcmTokens?: Record<string, string> }).fcmTokens ?? {};
    expect(tokens).toEqual({ d2: 'tok-good' });
  });

  it('mixed valid + invalid tokens — valid succeed, invalid cleaned (mixed managers)', async () => {
    await seedManager('alice@gmail.com', true);
    await seedManager('frank@gmail.com', true);
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-alice-bad' },
      notificationPrefs: { push: { newRequest: true } },
    });
    await seedUserIndex('frank@gmail.com', {
      fcmTokens: { d1: 'tok-frank-good' },
      notificationPrefs: { push: { newRequest: true } },
    });
    const { sender, calls } = mockSender([
      { success: false, errorCode: 'messaging/invalid-registration-token' },
      { success: true },
    ]);
    restoreSender = _setSender(sender);

    await pushOnRequestSubmit.run(makeEvent(baseRequest));

    expect(calls).toHaveLength(1);
    const { db } = requireEmulators();
    const aliceIdx = await db.doc('userIndex/alice@gmail.com').get();
    const frankIdx = await db.doc('userIndex/frank@gmail.com').get();
    const aliceTokens = (aliceIdx.data() as { fcmTokens?: Record<string, string> }).fcmTokens ?? {};
    const frankTokens = (frankIdx.data() as { fcmTokens?: Record<string, string> }).fcmTokens ?? {};
    expect(aliceTokens).toEqual({}); // bad token pruned
    expect(frankTokens).toEqual({ d1: 'tok-frank-good' }); // untouched
  });

  it('silently skips when no managers are subscribed (no send call, no error)', async () => {
    // No managers seeded at all.
    const { sender, calls } = mockSender([]);
    restoreSender = _setSender(sender);

    await pushOnRequestSubmit.run(makeEvent(baseRequest));

    expect(calls).toHaveLength(0);
  });

  it('does not clean tokens for transient FCM error codes', async () => {
    await seedManager('alice@gmail.com', true);
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-alice' },
      notificationPrefs: { push: { newRequest: true } },
    });
    const { sender } = mockSender([{ success: false, errorCode: 'messaging/internal-error' }]);
    restoreSender = _setSender(sender);

    await pushOnRequestSubmit.run(makeEvent(baseRequest));

    const { db } = requireEmulators();
    const idx = await db.doc('userIndex/alice@gmail.com').get();
    const tokens = (idx.data() as { fcmTokens?: Record<string, string> }).fcmTokens ?? {};
    expect(tokens).toEqual({ d1: 'tok-alice' }); // preserved
  });

  it('cleans tokens for additional unrecoverable codes (mismatched-credential, sender-id-mismatch)', async () => {
    await seedManager('alice@gmail.com', true);
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-mismatch', d2: 'tok-senderid', d3: 'tok-keep' },
      notificationPrefs: { push: { newRequest: true } },
    });
    const { sender } = mockSender([
      { success: false, errorCode: 'messaging/mismatched-credential' },
      { success: false, errorCode: 'messaging/sender-id-mismatch' },
      { success: true },
    ]);
    restoreSender = _setSender(sender);

    await pushOnRequestSubmit.run(makeEvent(baseRequest));

    const { db } = requireEmulators();
    const idx = await db.doc('userIndex/alice@gmail.com').get();
    const tokens = (idx.data() as { fcmTokens?: Record<string, string> }).fcmTokens ?? {};
    expect(tokens).toEqual({ d3: 'tok-keep' });
  });
});
