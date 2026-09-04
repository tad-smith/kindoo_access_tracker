// Tests for the expired-temp-seat reminder (T-103).
//
// `expiredTempGrants` and `backoffElapsed` are pure and run everywhere.
// `sendSyncReminderIfDue` reads the stake + seats + managers and
// dispatches email and push, so it runs against the emulator with
// Resend and FCM mocked at the wrapper level.
//
// The reminder owns its own send frequency but knows nothing about
// scheduling, so `now` is a plain argument and every backoff case below
// is a second call with a later `now` — no clock mocking anywhere.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';
import type { DuplicateGrant, Seat, Stake, Ward } from '@kindoo/shared';
import {
  backoffElapsed,
  expiredTempGrants,
  sendSyncReminderIfDue,
} from '../src/services/SyncReminderService.js';
import {
  _setResendSender,
  type EmailPayload,
  type ResendSender,
  type SendResult,
} from '../src/lib/resend.js';
import { _setSender, type Sender } from '../src/lib/messaging.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'sync-reminder-suite';
// 2026-08-18 12:00 UTC is 06:00 in Denver, so the stake-local day is
// 2026-08-18 and the "more than 24h" cutoff is 2026-08-17.
const NOW = new Date('2026-08-18T12:00:00Z');
const TODAY = '2026-08-18';
const YESTERDAY = '2026-08-17';
const TWO_DAYS_AGO = '2026-08-16';

function buildSeat(overrides: Partial<Seat> = {}): Seat {
  const canonical = overrides.member_canonical ?? 'jane@gmail.com';
  return {
    member_canonical: canonical,
    member_email: canonical,
    member_name: 'Jane Doe',
    scope: 'GE',
    type: 'temp',
    callings: [],
    building_names: ['Greenwood'],
    duplicate_grants: [],
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: 'admin@example.com', canonical: 'admin@example.com' },
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
    ...overrides,
  };
}

function buildDuplicate(overrides: Partial<DuplicateGrant> = {}): DuplicateGrant {
  return {
    scope: 'stake',
    type: 'temp',
    detected_at: Timestamp.now(),
    ...overrides,
  };
}

function buildStake(overrides: Partial<Stake> = {}): Stake {
  return {
    stake_name: 'CSNorth Stake',
    created_at: Timestamp.now(),
    created_by: 'admin@example.com',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: 'admin@example.com', canonical: 'admin@example.com' },
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure: which grants qualify.
// ---------------------------------------------------------------------------

describe('expiredTempGrants', () => {
  it('ignores a grant that ended today — the seat is held THROUGH its end date', () => {
    expect(expiredTempGrants([buildSeat({ end_date: TODAY })], YESTERDAY)).toEqual([]);
  });

  it('ignores a grant that ended yesterday — expired, but not yet by 24 hours', () => {
    expect(expiredTempGrants([buildSeat({ end_date: YESTERDAY })], YESTERDAY)).toEqual([]);
  });

  it('flags a grant that ended two days ago', () => {
    const rows = expiredTempGrants([buildSeat({ end_date: TWO_DAYS_AGO })], YESTERDAY);
    expect(rows).toEqual([
      {
        memberName: 'Jane Doe',
        memberEmail: 'jane@gmail.com',
        scope: 'GE',
        endDate: TWO_DAYS_AGO,
      },
    ]);
  });

  it('ignores non-temp seats and temp seats with no end date', () => {
    const seats = [
      buildSeat({ member_canonical: 'a@gmail.com', type: 'manual', end_date: '2020-01-01' }),
      buildSeat({ member_canonical: 'b@gmail.com', type: 'auto', end_date: '2020-01-01' }),
      buildSeat({ member_canonical: 'c@gmail.com', type: 'temp' }),
    ];
    expect(expiredTempGrants(seats, YESTERDAY)).toEqual([]);
  });

  it('finds an expired duplicate grant sitting alongside a live primary', () => {
    const seat = buildSeat({
      type: 'manual',
      duplicate_grants: [buildDuplicate({ end_date: TWO_DAYS_AGO })],
    });
    const rows = expiredTempGrants([seat], YESTERDAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'stake', endDate: TWO_DAYS_AGO });
  });

  it('emits one row per expired grant when a seat carries several', () => {
    const seat = buildSeat({
      end_date: TWO_DAYS_AGO,
      duplicate_grants: [
        buildDuplicate({ scope: 'stake', end_date: '2026-08-01' }),
        // Not expired by more than 24h — excluded even on a seat that
        // qualifies on another grant.
        buildDuplicate({ scope: 'BR', end_date: YESTERDAY }),
      ],
    });
    const rows = expiredTempGrants([seat], YESTERDAY);
    expect(rows.map((r) => r.scope)).toEqual(['stake', 'GE']);
  });

  it('sorts oldest-first, then by address', () => {
    const seats = [
      buildSeat({ member_canonical: 'zoe@gmail.com', end_date: TWO_DAYS_AGO }),
      buildSeat({ member_canonical: 'amy@gmail.com', end_date: TWO_DAYS_AGO }),
      buildSeat({ member_canonical: 'bob@gmail.com', end_date: '2026-01-01' }),
    ];
    expect(expiredTempGrants(seats, YESTERDAY).map((r) => r.memberEmail)).toEqual([
      'bob@gmail.com',
      'amy@gmail.com',
      'zoe@gmail.com',
    ]);
  });

  it('falls back to the canonical address when a seat carries no typed email', () => {
    const seat = { ...buildSeat({ end_date: TWO_DAYS_AGO }) } as Partial<Seat>;
    delete seat.member_email;
    const rows = expiredTempGrants([seat as Seat], YESTERDAY);
    expect(rows[0]?.memberEmail).toBe('jane@gmail.com');
  });
});

// ---------------------------------------------------------------------------
// Pure: when may the reminder repeat.
// ---------------------------------------------------------------------------

describe('backoffElapsed', () => {
  it('sends when there is no stamp — the condition has just tripped', () => {
    expect(backoffElapsed(undefined, TODAY)).toBe(true);
  });

  it('holds off on the same day and the two after it', () => {
    expect(backoffElapsed('2026-08-18', '2026-08-18')).toBe(false);
    expect(backoffElapsed('2026-08-18', '2026-08-19')).toBe(false);
    expect(backoffElapsed('2026-08-18', '2026-08-20')).toBe(false);
  });

  it('sends again on the third day', () => {
    expect(backoffElapsed('2026-08-18', '2026-08-21')).toBe(true);
  });

  it('counts across a month boundary', () => {
    expect(backoffElapsed('2026-08-30', '2026-09-01')).toBe(false);
    expect(backoffElapsed('2026-08-30', '2026-09-02')).toBe(true);
  });

  it('sends rather than stalls on a stamp it cannot read or one from the future', () => {
    expect(backoffElapsed('not-a-date', TODAY)).toBe(true);
    expect(backoffElapsed('2099-01-01', TODAY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: the whole unit of work for one stake.
// ---------------------------------------------------------------------------

function mockResend(responses: SendResult[]): { sender: ResendSender; calls: EmailPayload[] } {
  const calls: EmailPayload[] = [];
  const sender: ResendSender = {
    send: async (payload) => {
      calls.push(payload);
      return responses.shift() ?? { ok: true, id: 'mid-default' };
    },
  };
  return { sender, calls };
}

function mockFcm(responses: Array<{ success: boolean; errorCode?: string }>): {
  sender: Sender;
  calls: MulticastMessage[];
} {
  const calls: MulticastMessage[] = [];
  const sender: Sender = {
    sendEachForMulticast: async (message) => {
      calls.push(message);
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

async function seedStake(overrides: Partial<Stake> = {}): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}`).set(buildStake(overrides));
}

async function seedWard(wardCode: string, wardName: string): Promise<void> {
  const { db } = requireEmulators();
  const ward: Ward = {
    ward_code: wardCode,
    ward_name: wardName,
    building_name: 'Greenwood',
    seat_cap: 20,
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  };
  await db.doc(`stakes/${STAKE_ID}/wards/${wardCode}`).set(ward);
}

async function seedSeat(overrides: Partial<Seat> = {}): Promise<void> {
  const { db } = requireEmulators();
  const seat = buildSeat(overrides);
  await db.doc(`stakes/${STAKE_ID}/seats/${seat.member_canonical}`).set(seat);
}

async function seedManager(canonical: string, active: boolean): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/kindooManagers/${canonical}`).set({
    member_canonical: canonical,
    member_email: canonical,
    active,
    added_at: Timestamp.now(),
    lastActor: { email: canonical, canonical },
  });
}

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

/** The common happy-path fixture: one manager, subscribed, one stale seat. */
async function seedReminderWorthyStake(overrides: Partial<Stake> = {}): Promise<void> {
  await seedStake(overrides);
  await seedWard('GE', 'Greenwood Ward');
  await seedSeat({ end_date: TWO_DAYS_AGO });
  await seedManager('alice@gmail.com', true);
  await seedUserIndex('alice@gmail.com', {
    fcmTokens: { d1: 'tok-alice' },
    notificationPrefs: { push: { syncReminder: true } },
  });
}

describe.skipIf(!hasEmulators())('sendSyncReminderIfDue', () => {
  let restoreResend: (() => void) | undefined;
  let restoreFcm: (() => void) | undefined;

  beforeAll(async () => {
    await clearEmulators();
    process.env['WEB_BASE_URL'] = 'https://stakebuildingaccess.org';
  });
  beforeEach(() => {
    restoreResend = undefined;
    restoreFcm = undefined;
  });
  afterEach(async () => {
    if (restoreResend) restoreResend();
    if (restoreFcm) restoreFcm();
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
    delete process.env['WEB_BASE_URL'];
  });

  it('emails active managers and pushes to the subscribed ones', async () => {
    await seedReminderWorthyStake();
    const { sender: resend, calls: emails } = mockResend([{ ok: true, id: 'mid-1' }]);
    const { sender: fcm, calls: pushes } = mockFcm([{ success: true }]);
    restoreResend = _setResendSender(resend);
    restoreFcm = _setSender(fcm);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'sent', seats: 1, grants: 1, pushed: 1 });
    expect(emails).toHaveLength(1);
    const email = emails[0]!;
    expect(email.to).toEqual(['alice@gmail.com']);
    expect(email.subject).toBe(
      '[Stake Building Access] One temporary seat has expired but is still on the roster',
    );
    // Ward name, never the raw ward_code.
    expect(email.text).toContain('Greenwood Ward');
    expect(email.text).not.toMatch(/\bGE\b/);
    expect(email.html).toContain('>Greenwood Ward</td>');
    expect(email.text).toContain('https://stakebuildingaccess.org/manager/seats');

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.tokens).toEqual(['tok-alice']);
    expect(pushes[0]!.data?.['deepLink']).toBe(`/manager/seats?stake=${STAKE_ID}`);
    // FCM requires every data value to be a string.
    for (const v of Object.values(pushes[0]!.data ?? {})) {
      expect(typeof v).toBe('string');
      expect(v).not.toBe('');
    }
  });

  it('skips a stake still in the bootstrap wizard', async () => {
    await seedReminderWorthyStake({ setup_complete: false });
    const { sender: resend, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(resend);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome.status).toBe('setup-incomplete');
    expect(emails).toHaveLength(0);
  });

  it('reports stake-missing rather than throwing for an unknown stake', async () => {
    const { sender: resend, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(resend);

    const outcome = await sendSyncReminderIfDue('no-such-stake', NOW);

    expect(outcome.status).toBe('stake-missing');
    expect(emails).toHaveLength(0);
  });

  it('sends nothing when the only expired seat ended yesterday', async () => {
    await seedStake();
    await seedSeat({ end_date: YESTERDAY });
    await seedManager('alice@gmail.com', true);
    const { sender: resend, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(resend);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'nothing-expired', grants: 0 });
    expect(emails).toHaveLength(0);
  });

  it('reads the cutoff in the stake timezone, not UTC', async () => {
    // 2026-08-18T05:30Z is still 2026-08-17 in Denver, so the cutoff is
    // 2026-08-16 and a seat that ended then is not yet reminder-worthy.
    await seedReminderWorthyStake();
    const { sender: resend, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(resend);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, new Date('2026-08-18T05:30:00Z'));

    expect(outcome.status).toBe('nothing-expired');
    expect(emails).toHaveLength(0);
  });

  it('counts a seat once but lists each of its expired grants', async () => {
    await seedStake();
    await seedWard('GE', 'Greenwood Ward');
    await seedSeat({
      end_date: TWO_DAYS_AGO,
      duplicate_grants: [buildDuplicate({ scope: 'stake', end_date: '2026-08-01' })],
    });
    await seedManager('alice@gmail.com', true);
    const { sender: resend, calls: emails } = mockResend([{ ok: true, id: 'mid-1' }]);
    restoreResend = _setResendSender(resend);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'sent', seats: 1, grants: 2 });
    expect(emails[0]!.subject).toContain('Two temporary seats have expired');
    expect(emails[0]!.text).toContain('Stake, ended 2026-08-01');
    expect(emails[0]!.text).toContain('Greenwood Ward, ended 2026-08-16');
  });

  it('honours the stake email kill-switch, and push is not gated by it', async () => {
    await seedReminderWorthyStake({ notifications_enabled: false });
    const { sender: resend, calls: emails } = mockResend([]);
    const { sender: fcm, calls: pushes } = mockFcm([{ success: true }]);
    restoreResend = _setResendSender(resend);
    restoreFcm = _setSender(fcm);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'sent', pushed: 1 });
    expect(emails).toHaveLength(0);
    expect(pushes).toHaveLength(1);
  });

  it('emails a manager who never opted into the push category', async () => {
    await seedStake();
    await seedSeat({ end_date: TWO_DAYS_AGO });
    await seedManager('alice@gmail.com', true);
    // Subscribed to new-request pushes only — `syncReminder` is absent,
    // which reads as off. Email is not gated on push prefs.
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-alice' },
      notificationPrefs: { push: { newRequest: true } },
    });
    const { sender: resend, calls: emails } = mockResend([{ ok: true, id: 'mid-1' }]);
    const { sender: fcm, calls: pushes } = mockFcm([]);
    restoreResend = _setResendSender(resend);
    restoreFcm = _setSender(fcm);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'sent', pushed: 0 });
    expect(emails).toHaveLength(1);
    expect(pushes).toHaveLength(0);
  });

  it('does not push to a manager who opted out explicitly', async () => {
    await seedStake();
    await seedSeat({ end_date: TWO_DAYS_AGO });
    await seedManager('alice@gmail.com', true);
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-alice' },
      notificationPrefs: { push: { syncReminder: false } },
    });
    const { sender: resend } = mockResend([{ ok: true, id: 'mid-1' }]);
    const { sender: fcm, calls: pushes } = mockFcm([]);
    restoreResend = _setResendSender(resend);
    restoreFcm = _setSender(fcm);

    await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(pushes).toHaveLength(0);
  });

  it('excludes inactive managers from both channels', async () => {
    await seedReminderWorthyStake();
    await seedManager('bob@gmail.com', false);
    await seedUserIndex('bob@gmail.com', {
      fcmTokens: { d1: 'tok-bob' },
      notificationPrefs: { push: { syncReminder: true } },
    });
    const { sender: resend, calls: emails } = mockResend([{ ok: true, id: 'mid-1' }]);
    const { sender: fcm, calls: pushes } = mockFcm([{ success: true }]);
    restoreResend = _setResendSender(resend);
    restoreFcm = _setSender(fcm);

    await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(emails[0]!.to).toEqual(['alice@gmail.com']);
    expect(pushes[0]!.tokens).toEqual(['tok-alice']);
  });

  it('reports no-managers without sending when nobody is active', async () => {
    await seedStake();
    await seedSeat({ end_date: TWO_DAYS_AGO });
    await seedManager('bob@gmail.com', false);
    const { sender: resend, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(resend);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'no-managers', grants: 1 });
    expect(emails).toHaveLength(0);
  });

  it('writes an email_send_failed audit row and still pushes when Resend fails', async () => {
    await seedReminderWorthyStake();
    const { sender: resend } = mockResend([
      { ok: false, error: { message: 'boom', code: 'rate_limit' } },
    ]);
    const { sender: fcm, calls: pushes } = mockFcm([{ success: true }]);
    restoreResend = _setResendSender(resend);
    restoreFcm = _setSender(fcm);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome.status).toBe('sent');
    expect(pushes).toHaveLength(1);
    const { db } = requireEmulators();
    const rows = await db
      .collection(`stakes/${STAKE_ID}/auditLog`)
      .where('action', '==', 'email_send_failed')
      .get();
    expect(rows.size).toBe(1);
    expect(rows.docs[0]!.data()['after']).toMatchObject({ type: 'syncReminder' });
  });

  it('reports a push failure on the outcome rather than throwing', async () => {
    await seedReminderWorthyStake();
    const { sender: resend, calls: emails } = mockResend([{ ok: true, id: 'mid-1' }]);
    const failing: Sender = {
      sendEachForMulticast: async () => {
        throw new Error('FCM unavailable');
      },
    };
    restoreResend = _setResendSender(resend);
    restoreFcm = _setSender(failing);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    // The email already went out, so a throw here would earn a retry
    // that sends it twice.
    expect(outcome).toMatchObject({ status: 'sent', pushed: 0 });
    expect(outcome.pushError).toContain('FCM unavailable');
    expect(emails).toHaveLength(1);
  });

  // ---- backoff, end to end ------------------------------------------------

  it('stamps the stake-local send date on the stake doc', async () => {
    await seedReminderWorthyStake();
    const { sender: resend } = mockResend([{ ok: true, id: 'mid-1' }]);
    restoreResend = _setResendSender(resend);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome.sentOn).toBe(TODAY);
    const { db } = requireEmulators();
    const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
    expect(stake.last_sync_reminder_date).toBe(TODAY);
  });

  it('does not send twice on the same day — the stamp is the dedupe', async () => {
    await seedReminderWorthyStake();
    const { sender: resend, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(resend);

    await sendSyncReminderIfDue(STAKE_ID, NOW);
    // Same day, e.g. an at-least-once invoker redelivering.
    const second = await sendSyncReminderIfDue(STAKE_ID, new Date('2026-08-18T18:00:00Z'));

    expect(second).toMatchObject({ status: 'backed-off', grants: 1 });
    expect(emails).toHaveLength(1);
  });

  it('stays quiet on the two days after a send, then sends on the third', async () => {
    await seedReminderWorthyStake();
    const { sender: resend, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(resend);

    await sendSyncReminderIfDue(STAKE_ID, NOW);
    const dayOne = await sendSyncReminderIfDue(STAKE_ID, new Date('2026-08-19T12:00:00Z'));
    const dayTwo = await sendSyncReminderIfDue(STAKE_ID, new Date('2026-08-20T12:00:00Z'));
    const dayThree = await sendSyncReminderIfDue(STAKE_ID, new Date('2026-08-21T12:00:00Z'));

    expect(dayOne.status).toBe('backed-off');
    expect(dayTwo.status).toBe('backed-off');
    expect(dayThree).toMatchObject({ status: 'sent', sentOn: '2026-08-21' });
    expect(emails).toHaveLength(2);
  });

  it('clears the stamp once nothing is expired, so the next occurrence sends at once', async () => {
    await seedReminderWorthyStake();
    const { sender: resend, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(resend);
    const { db } = requireEmulators();

    await sendSyncReminderIfDue(STAKE_ID, NOW);

    // Manager runs Sync; the stale seat goes away.
    await db.doc(`stakes/${STAKE_ID}/seats/jane@gmail.com`).delete();
    const cleared = await sendSyncReminderIfDue(STAKE_ID, new Date('2026-08-19T12:00:00Z'));
    expect(cleared.status).toBe('nothing-expired');
    const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
    expect(stake.last_sync_reminder_date).toBeUndefined();

    // A new temp seat expires the next day — a fresh first send, not the
    // tail of a backoff it has nothing to do with.
    await seedSeat({ member_canonical: 'newguy@gmail.com', end_date: '2026-08-18' });
    const fresh = await sendSyncReminderIfDue(STAKE_ID, new Date('2026-08-20T12:00:00Z'));

    expect(fresh).toMatchObject({ status: 'sent', sentOn: '2026-08-20' });
    expect(emails).toHaveLength(2);
  });

  it('leaves no stamp when there was nobody to notify', async () => {
    await seedStake();
    await seedSeat({ end_date: TWO_DAYS_AGO });
    const { sender: resend } = mockResend([]);
    restoreResend = _setResendSender(resend);

    await sendSyncReminderIfDue(STAKE_ID, NOW);

    const { db } = requireEmulators();
    const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
    expect(stake.last_sync_reminder_date).toBeUndefined();
  });

  it('writes nothing to the stake doc when there is no stamp to clear', async () => {
    await seedStake();
    await seedManager('alice@gmail.com', true);
    const before = (await requireEmulators().db.doc(`stakes/${STAKE_ID}`).get()).updateTime;

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome.status).toBe('nothing-expired');
    const after = (await requireEmulators().db.doc(`stakes/${STAKE_ID}`).get()).updateTime;
    expect(after?.isEqual(before!)).toBe(true);
  });

  it('records that the kill-switch suppressed the email', async () => {
    await seedReminderWorthyStake({ notifications_enabled: false });
    const { sender: resend } = mockResend([]);
    restoreResend = _setResendSender(resend);

    const outcome = await sendSyncReminderIfDue(STAKE_ID, NOW);

    expect(outcome.emailSuppressed).toBe(true);
  });

  it('prunes an invalid token, same as the request push path', async () => {
    await seedReminderWorthyStake();
    await seedUserIndex('alice@gmail.com', {
      fcmTokens: { d1: 'tok-bad', d2: 'tok-good' },
      notificationPrefs: { push: { syncReminder: true } },
    });
    const { sender: resend } = mockResend([{ ok: true, id: 'mid-1' }]);
    const { sender: fcm } = mockFcm([
      { success: false, errorCode: 'messaging/registration-token-not-registered' },
      { success: true },
    ]);
    restoreResend = _setResendSender(resend);
    restoreFcm = _setSender(fcm);

    await sendSyncReminderIfDue(STAKE_ID, NOW);

    const { db } = requireEmulators();
    const idx = await db.doc('userIndex/alice@gmail.com').get();
    expect((idx.data() as { fcmTokens?: Record<string, string> }).fcmTokens).toEqual({
      d2: 'tok-good',
    });
  });
});
