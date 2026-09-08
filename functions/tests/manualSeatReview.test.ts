// Tests for the quarterly manual-seat review.
//
// `intervalElapsed`, `manualGrantsByScope` and `bishopricRecipients` are
// pure and run everywhere. `sendManualSeatReviewIfDue` reads the stake,
// seats, access docs, wards and managers and sends one mail per scope,
// so it runs against the emulator with Resend mocked at the wrapper
// level.
//
// The review owns its own cadence but knows nothing about scheduling,
// so `now` is a plain argument and every interval case below is a second
// call with a later `now` — no clock mocking anywhere.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from 'firebase-functions';
import { Timestamp } from 'firebase-admin/firestore';
import type { Access, DuplicateGrant, Seat, Stake, Ward } from '@kindoo/shared';
import {
  MANUAL_SEAT_REVIEW_INTERVAL_DAYS,
  bishopricRecipients,
  intervalElapsed,
  manualGrantsByScope,
  sendManualSeatReviewIfDue,
} from '../src/services/ManualSeatReviewService.js';
import {
  _setResendSender,
  type EmailPayload,
  type ResendSender,
  type SendResult,
} from '../src/lib/resend.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'manual-review-suite';
// 2026-10-01 09:00 UTC is 03:00 in Denver, so the stake-local day is
// 2026-10-01 — the shape a jittered 02:00 monthly slot delivers in.
const NOW = new Date('2026-10-01T09:00:00Z');
const TODAY = '2026-10-01';

function buildSeat(overrides: Partial<Seat> = {}): Seat {
  const canonical = overrides.member_canonical ?? 'jane@gmail.com';
  return {
    member_canonical: canonical,
    member_email: canonical,
    member_name: 'Jane Doe',
    scope: 'GE',
    type: 'manual',
    callings: [],
    reason: 'Ward music chair',
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
    type: 'manual',
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
// Pure: when does the review come round again.
// ---------------------------------------------------------------------------

describe('intervalElapsed', () => {
  it('sends when the stake has never been reviewed', () => {
    expect(intervalElapsed(undefined, TODAY)).toBe(true);
  });

  it('holds off up to the day before the interval, then sends', () => {
    // 2026-07-01 + 74 days = 2026-09-13; + 75 = 2026-09-14.
    expect(intervalElapsed('2026-07-01', '2026-09-13')).toBe(false);
    expect(intervalElapsed('2026-07-01', '2026-09-14')).toBe(true);
  });

  it('lands on every third month for every month of the year', () => {
    // The whole reason 75 is safe: the longest two-month gap is 62 days
    // and the shortest three-month gap is 89 (Feb 1 → May 1, non-leap),
    // so a threshold in that band rejects the second month and admits
    // the third, always. The walk below crosses that exact Feb → May
    // gap at i=1 (2026 is not a leap year).
    const firsts = [
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
      '2027-03-01',
      '2027-04-01',
    ];
    for (let i = 0; i < firsts.length - 3; i += 1) {
      const from = firsts[i]!;
      expect(intervalElapsed(from, firsts[i + 1]!), `${from} → +1 month`).toBe(false);
      expect(intervalElapsed(from, firsts[i + 2]!), `${from} → +2 months`).toBe(false);
      expect(intervalElapsed(from, firsts[i + 3]!), `${from} → +3 months`).toBe(true);
    }
  });

  it('sends rather than stalls on a stamp it cannot read or one from the future', () => {
    expect(intervalElapsed('not-a-date', TODAY)).toBe(true);
    expect(intervalElapsed('2099-01-01', TODAY)).toBe(true);
  });

  it('takes the threshold as a parameter, defaulting to the quarter', () => {
    expect(MANUAL_SEAT_REVIEW_INTERVAL_DAYS).toBe(75);
    expect(intervalElapsed('2026-09-29', TODAY, 2)).toBe(true);
    expect(intervalElapsed('2026-09-30', TODAY, 2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure: which grants land on which scope's list.
// ---------------------------------------------------------------------------

describe('manualGrantsByScope', () => {
  it('groups a manual primary under the seat’s scope', () => {
    const byScope = manualGrantsByScope([buildSeat()]);
    expect([...byScope.keys()]).toEqual(['GE']);
    expect(byScope.get('GE')).toEqual([
      {
        memberName: 'Jane Doe',
        memberEmail: 'jane@gmail.com',
        reason: 'Ward music chair',
        buildingNames: ['Greenwood'],
      },
    ]);
  });

  it('ignores auto and temp grants entirely', () => {
    const seats = [
      buildSeat({ member_canonical: 'a@gmail.com', type: 'auto', callings: ['Bishop'] }),
      buildSeat({ member_canonical: 'b@gmail.com', type: 'temp', end_date: '2026-12-01' }),
    ];
    expect(manualGrantsByScope(seats).size).toBe(0);
  });

  it('files a manual duplicate under its OWN scope, not the primary’s', () => {
    // The shape the whole grouping exists for: a ward-scope auto seat
    // carrying a stake-scope manual duplicate belongs on the stake's
    // list, and nowhere near the ward's.
    const seat = buildSeat({
      type: 'auto',
      scope: 'GE',
      callings: ['Bishop'],
      duplicate_grants: [
        buildDuplicate({ scope: 'stake', reason: 'Stake activities', building_names: ['Pine'] }),
      ],
    });
    const byScope = manualGrantsByScope([seat]);
    expect([...byScope.keys()]).toEqual(['stake']);
    expect(byScope.get('stake')?.[0]).toMatchObject({
      reason: 'Stake activities',
      buildingNames: ['Pine'],
    });
  });

  it('lets a same-site duplicate with no buildings inherit the primary’s', () => {
    const seat = buildSeat({
      type: 'auto',
      building_names: ['Greenwood'],
      duplicate_grants: [buildDuplicate({ scope: 'stake' })],
    });
    expect(manualGrantsByScope([seat]).get('stake')?.[0]?.buildingNames).toEqual(['Greenwood']);
  });

  it('never inherits across Kindoo sites', () => {
    // The primary's buildings live on another site; rendering them on
    // this row would be wrong data rather than missing data.
    const seat = buildSeat({
      type: 'auto',
      kindoo_site_id: null,
      building_names: ['Greenwood'],
      duplicate_grants: [buildDuplicate({ scope: 'stake', kindoo_site_id: 'east' })],
    });
    expect(manualGrantsByScope([seat]).get('stake')?.[0]?.buildingNames).toEqual([]);
  });

  it('carries a seat with both a manual primary and a manual duplicate onto both lists', () => {
    const seat = buildSeat({
      scope: 'GE',
      duplicate_grants: [buildDuplicate({ scope: 'BR', reason: 'Branch help' })],
    });
    const byScope = manualGrantsByScope([seat]);
    expect(byScope.get('GE')).toHaveLength(1);
    expect(byScope.get('BR')?.[0]?.reason).toBe('Branch help');
  });

  it('sorts each scope by name then address', () => {
    const seats = [
      buildSeat({ member_canonical: 'z@gmail.com', member_name: 'Zoe Zed' }),
      buildSeat({ member_canonical: 'a@gmail.com', member_name: 'Amy Ash' }),
      buildSeat({ member_canonical: 'b@gmail.com', member_name: 'Amy Ash' }),
    ];
    expect(
      manualGrantsByScope(seats)
        .get('GE')
        ?.map((g) => g.memberEmail),
    ).toEqual(['a@gmail.com', 'b@gmail.com', 'z@gmail.com']);
  });

  it('falls back to the canonical address when a seat carries no typed email', () => {
    const seat = { ...buildSeat() } as Partial<Seat>;
    delete seat.member_email;
    expect(manualGrantsByScope([seat as Seat]).get('GE')?.[0]?.memberEmail).toBe('jane@gmail.com');
  });
});

// ---------------------------------------------------------------------------
// Pure: who is answerable for a scope's roster.
// ---------------------------------------------------------------------------

describe('bishopricRecipients', () => {
  const doc = (id: string, data: Partial<Access>) => ({ id, data });

  it('includes an importer-sourced, full-tier calling for the scope', () => {
    const docs = [
      doc('bishop@gmail.com', {
        member_email: 'Bishop@example.com',
        importer_callings: { GE: ['Bishop'] },
      }),
    ];
    expect(bishopricRecipients(docs, 'GE')).toEqual(['Bishop@example.com']);
  });

  it('excludes someone whose only calling for the scope is limited-tier', () => {
    // The only limited unit calling is Elders Quorum President (D26),
    // and `canRemoveSeat` refuses a limited user any non-temp grant — so
    // they would open a list of manual seats with no Remove on any row.
    const docs = [
      doc('eq@gmail.com', {
        member_email: 'eq@example.com',
        importer_callings: { GE: ['Elders Quorum President'] },
        importer_limited_callings: { GE: ['Elders Quorum President'] },
      }),
    ];
    expect(bishopricRecipients(docs, 'GE')).toEqual([]);
  });

  it('includes someone holding one limited and one full calling', () => {
    const docs = [
      doc('both@gmail.com', {
        member_email: 'both@example.com',
        importer_callings: { GE: ['Elders Quorum President', 'Ward Clerk'] },
        importer_limited_callings: { GE: ['Elders Quorum President'] },
      }),
    ];
    expect(bishopricRecipients(docs, 'GE')).toEqual(['both@example.com']);
  });

  it('confers nothing on a manual grant', () => {
    // `manual_grants` is how a manager hands someone the app; it is not
    // evidence they are answerable for the ward's roster.
    const docs = [
      doc('helper@gmail.com', {
        member_email: 'helper@example.com',
        importer_callings: {},
        manual_grants: {
          GE: [
            {
              grant_id: 'g1',
              reason: 'helper',
              granted_by: { email: 'a@b.c', canonical: 'a@b.c' },
              granted_at: Timestamp.now(),
            },
          ],
        },
      }),
    ];
    expect(bishopricRecipients(docs, 'GE')).toEqual([]);
  });

  it('never crosses scopes', () => {
    const docs = [
      doc('bishop@gmail.com', {
        member_email: 'bishop@example.com',
        importer_callings: { BR: ['Branch President'] },
      }),
    ];
    expect(bishopricRecipients(docs, 'GE')).toEqual([]);
    expect(bishopricRecipients(docs, 'BR')).toEqual(['bishop@example.com']);
  });

  it('falls back to the doc id when no typed email is stored', () => {
    const docs = [doc('bishop@gmail.com', { importer_callings: { GE: ['Bishop'] } })];
    expect(bishopricRecipients(docs, 'GE')).toEqual(['bishop@gmail.com']);
  });

  it('reads garbage as full access, never as a restriction', () => {
    const docs = [
      doc('a@gmail.com', {
        member_email: 'a@example.com',
        importer_callings: { GE: ['Bishop'] },
        importer_limited_callings: 'nonsense' as unknown as Record<string, string[]>,
      }),
      doc('b@gmail.com', {
        member_email: 'b@example.com',
        importer_callings: { GE: ['Ward Clerk'] },
        importer_limited_callings: { GE: 'nonsense' as unknown as string[] },
      }),
      // Nothing readable at all contributes nothing — but does not throw.
      doc('c@gmail.com', {
        importer_callings: undefined as unknown as Record<string, string[]>,
      }),
      doc('d@gmail.com', {
        importer_callings: { GE: 'Bishop' as unknown as string[] },
      }),
    ];
    expect(bishopricRecipients(docs, 'GE')).toEqual(['a@example.com', 'b@example.com']);
  });

  it('matches the tier stamp case-insensitively', () => {
    const docs = [
      doc('eq@gmail.com', {
        member_email: 'eq@example.com',
        importer_callings: { GE: ['Elders Quorum President'] },
        importer_limited_callings: { GE: ['  elders quorum president '] },
      }),
    ];
    expect(bishopricRecipients(docs, 'GE')).toEqual([]);
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

async function seedAccess(canonical: string, data: Partial<Access>): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/access/${canonical}`).set({
    member_canonical: canonical,
    member_email: canonical,
    member_name: 'Access Holder',
    importer_callings: {},
    manual_grants: {},
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: canonical, canonical },
    lastActor: { email: canonical, canonical },
    ...data,
  });
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

/** One ward with one manual seat and a bishop to tell about it. */
async function seedReviewWorthyStake(overrides: Partial<Stake> = {}): Promise<void> {
  await seedStake(overrides);
  await seedWard('GE', 'Greenwood Ward');
  await seedSeat();
  await seedAccess('bishop@gmail.com', { importer_callings: { GE: ['Bishop'] } });
}

async function readStake(): Promise<Stake> {
  const { db } = requireEmulators();
  return (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
}

describe.skipIf(!hasEmulators())('sendManualSeatReviewIfDue', () => {
  let restoreResend: (() => void) | undefined;

  beforeAll(async () => {
    await clearEmulators();
    process.env['WEB_BASE_URL'] = 'https://stakebuildingaccess.org';
  });
  beforeEach(() => {
    restoreResend = undefined;
  });
  afterEach(async () => {
    if (restoreResend) restoreResend();
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
    delete process.env['WEB_BASE_URL'];
  });

  it('mails a ward’s bishopric its manual seats', async () => {
    await seedReviewWorthyStake();
    await seedAccess('counselor@gmail.com', {
      importer_callings: { GE: ['Bishopric First Counselor'] },
    });
    const { sender, calls: emails } = mockResend([{ ok: true, id: 'mid-1' }]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({
      status: 'sent',
      scopes: 1,
      grants: 1,
      mailsSent: 1,
      scopesSkipped: 0,
      sentOn: TODAY,
    });
    expect(emails).toHaveLength(1);
    const email = emails[0]!;
    expect(email.to).toEqual(['bishop@gmail.com', 'counselor@gmail.com']);
    expect(email.subject).toBe('[Stake Building Access] Quarterly access review — Greenwood Ward');
    // Ward name, never the raw ward_code.
    expect(email.text).toContain('Greenwood Ward');
    expect(email.text).toContain('Jane Doe (jane@gmail.com) — Ward music chair — Greenwood');
    expect(email.text).toContain(
      'https://stakebuildingaccess.org/bishopric/roster?ward=GE&stake=manual-review-suite',
    );
  });

  it('sends the stake scope to the active Kindoo Managers, and only them', async () => {
    await seedStake();
    await seedSeat({ scope: 'stake', reason: 'Stake activities' });
    await seedManager('alice@gmail.com', true);
    await seedManager('bob@gmail.com', false);
    // A stake-scope app-access holder gets nothing.
    await seedAccess('sp@gmail.com', { importer_callings: { stake: ['Stake President'] } });
    const { sender, calls: emails } = mockResend([{ ok: true, id: 'mid-1' }]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'sent', mailsSent: 1 });
    expect(emails[0]!.to).toEqual(['alice@gmail.com']);
    expect(emails[0]!.subject).toBe('[Stake Building Access] Quarterly access review — Stake');
    expect(emails[0]!.text).toContain(
      'https://stakebuildingaccess.org/stake/roster?stake=manual-review-suite',
    );
  });

  it('sends one mail per scope, each carrying only its own seats', async () => {
    await seedReviewWorthyStake();
    await seedSeat({
      member_canonical: 'karl@gmail.com',
      member_name: 'Karl King',
      scope: 'stake',
      reason: 'Stake activities',
    });
    await seedManager('alice@gmail.com', true);
    const { sender, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'sent', scopes: 2, grants: 2, mailsSent: 2 });
    // Stake first, then ward codes alphabetically.
    expect(emails.map((e) => e.to)).toEqual([['alice@gmail.com'], ['bishop@gmail.com']]);
    expect(emails[0]!.text).toContain('Karl King');
    expect(emails[0]!.text).not.toContain('Jane Doe');
    expect(emails[1]!.text).toContain('Jane Doe');
    expect(emails[1]!.text).not.toContain('Karl King');
  }, 15_000);

  it('skips a scope with no qualifying recipient, and sends the rest', async () => {
    await seedReviewWorthyStake();
    // A second ward with a manual seat but only a limited-tier holder.
    await seedWard('BR', 'Brookside Ward');
    await seedSeat({ member_canonical: 'ed@gmail.com', scope: 'BR' });
    await seedAccess('eq@gmail.com', {
      importer_callings: { BR: ['Elders Quorum President'] },
      importer_limited_callings: { BR: ['Elders Quorum President'] },
    });
    const { sender, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    // No fallback anywhere: BR sends nothing rather than reaching the
    // managers, who cannot answer "does this person still need it?"
    expect(outcome).toMatchObject({ status: 'sent', scopes: 2, mailsSent: 1, scopesSkipped: 1 });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toEqual(['bishop@gmail.com']);
  });

  it('reports no-recipients and stamps nothing when no scope has anyone', async () => {
    await seedStake();
    await seedWard('GE', 'Greenwood Ward');
    await seedSeat();
    const { sender, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'no-recipients', scopes: 1, scopesSkipped: 1 });
    expect(emails).toHaveLength(0);
    // Nothing was said, so nothing is being deferred — next month retries.
    expect((await readStake()).last_manual_seat_review_date).toBeUndefined();
  });

  it('reports stake-missing rather than throwing for an unknown stake', async () => {
    const { sender, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue('no-such-stake', NOW);

    expect(outcome.status).toBe('stake-missing');
    expect(emails).toHaveLength(0);
  });

  it('skips a stake still in the bootstrap wizard', async () => {
    await seedReviewWorthyStake({ setup_complete: false });
    const { sender, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    expect(outcome.status).toBe('setup-incomplete');
    expect(emails).toHaveLength(0);
  });

  it('reports nothing-due when no manual seat exists anywhere', async () => {
    await seedStake();
    await seedSeat({ type: 'auto', callings: ['Bishop'] });
    await seedAccess('bishop@gmail.com', { importer_callings: { GE: ['Bishop'] } });
    const { sender, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'nothing-due', scopes: 0, grants: 0 });
    expect(emails).toHaveLength(0);
  });

  it('stamps — never deletes — the quarter on an empty run', async () => {
    // The cadence is "once a quarter", not "when a condition trips": an
    // empty quarter still consumes it. The old assertion here only
    // checked that the prior value survived, which cannot tell "deleted"
    // apart from "left alone" apart from "rewritten" at a date this old
    // — all three read back as `'2026-07-01'` if the run does nothing.
    // Reaching this branch means the stamp is already due (that is why
    // `intervalElapsed` let the run past `backed-off`), so leaving it
    // alone would make the very next monthly check fire again and
    // review the first manual seat to appear within a month instead of
    // at the next quarter.
    await seedStake({ last_manual_seat_review_date: '2026-07-01' });
    await seedSeat({ type: 'auto', callings: ['Bishop'] });
    const { sender } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    expect(outcome.status).toBe('nothing-due');
    // Rewritten, to today — not left at the old value.
    expect((await readStake()).last_manual_seat_review_date).toBe(TODAY);
  });

  it('defers the next send by a full interval after an empty quarter', async () => {
    // Proves the rewrite actually moves the goalposts: a check the very
    // next month must still hold off, and the quarter after that must
    // fire — exactly the cadence a manual seat landing right after the
    // empty run should get, not an early review a month later.
    await seedStake({ last_manual_seat_review_date: '2026-07-01' });
    const { sender } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const empty = await sendManualSeatReviewIfDue(STAKE_ID, NOW);
    expect(empty.status).toBe('nothing-due');

    // A manual seat shows up the day after the empty run.
    await seedSeat();
    const month1 = await sendManualSeatReviewIfDue(STAKE_ID, new Date('2026-11-01T09:00:00Z'));
    const month2 = await sendManualSeatReviewIfDue(STAKE_ID, new Date('2026-12-01T09:00:00Z'));

    expect(month1.status).toBe('backed-off');
    expect(month2.status).toBe('backed-off');
  });

  it('stamps the stake-local send date, last', async () => {
    await seedReviewWorthyStake();
    const { sender } = mockResend([{ ok: true, id: 'mid-1' }]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    expect(outcome.sentOn).toBe(TODAY);
    expect((await readStake()).last_manual_seat_review_date).toBe(TODAY);
  });

  it('holds off inside the interval and comes round on the next quarter', async () => {
    await seedReviewWorthyStake();
    const { sender, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(sender);

    await sendManualSeatReviewIfDue(STAKE_ID, NOW);
    // The next two monthly checks — 2026-11-01 and 2026-12-01 — are 31
    // and 61 days on, both inside the interval.
    const month1 = await sendManualSeatReviewIfDue(STAKE_ID, new Date('2026-11-01T09:00:00Z'));
    const month2 = await sendManualSeatReviewIfDue(STAKE_ID, new Date('2026-12-01T09:00:00Z'));
    const month3 = await sendManualSeatReviewIfDue(STAKE_ID, new Date('2027-01-01T09:00:00Z'));

    expect(month1.status).toBe('backed-off');
    expect(month2.status).toBe('backed-off');
    expect(month3).toMatchObject({ status: 'sent', sentOn: '2027-01-01' });
    expect(emails).toHaveLength(2);
  });

  it('honours the stake email kill-switch but still consumes the quarter', async () => {
    await seedReviewWorthyStake({ notifications_enabled: false });
    const { sender, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({
      status: 'sent',
      mailsSent: 1,
      mailsFailed: 0,
      emailSuppressed: true,
    });
    expect(emails).toHaveLength(0);
    expect((await readStake()).last_manual_seat_review_date).toBe(TODAY);
  });

  it('does not pace scopes it is not mailing, with the kill-switch on', async () => {
    // Three scopes: pacing would sleep 2 × SEND_GAP_MS before the run
    // could return, and no Resend call is made to pace.
    await seedReviewWorthyStake({ notifications_enabled: false });
    await seedWard('BR', 'Brookside Ward');
    await seedSeat({ member_canonical: 'ed@gmail.com', scope: 'BR' });
    await seedAccess('br-bishop@gmail.com', { importer_callings: { BR: ['Bishop'] } });
    await seedSeat({ member_canonical: 'karl@gmail.com', scope: 'stake' });
    await seedManager('alice@gmail.com', true);
    const { sender, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const started = Date.now();
    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);
    const elapsed = Date.now() - started;

    expect(outcome).toMatchObject({ status: 'sent', mailsSent: 3, emailSuppressed: true });
    expect(emails).toHaveLength(0);
    // Generous, so emulator latency can't flake it — but far below the
    // 2s of pacing the old unconditional gap would have spent.
    expect(elapsed).toBeLessThan(1_500);
  }, 15_000);

  it('leaves the quarter unconsumed when every send failed', async () => {
    await seedReviewWorthyStake();
    await seedSeat({ member_canonical: 'karl@gmail.com', scope: 'stake' });
    await seedManager('alice@gmail.com', true);
    const { sender } = mockResend([
      { ok: false, error: { message: 'boom', code: 'rate_limit' } },
      { ok: false, error: { message: 'boom', code: 'rate_limit' } },
    ]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    // Best-effort per send — an audit row, never a throw — but a run
    // that said nothing must not burn the quarter: a Resend outage on
    // the firing day would otherwise buy three months of silence.
    expect(outcome).toMatchObject({
      status: 'send-failed',
      mailsSent: 0,
      mailsFailed: 2,
    });
    expect(outcome.sentOn).toBeUndefined();
    expect((await readStake()).last_manual_seat_review_date).toBeUndefined();
  }, 15_000);

  it('consumes the quarter when one scope failed and another landed, and warns naming it', async () => {
    await seedReviewWorthyStake();
    await seedSeat({ member_canonical: 'karl@gmail.com', scope: 'stake' });
    await seedManager('alice@gmail.com', true);
    // Stake sends first, then the ward.
    const { sender, calls: emails } = mockResend([
      { ok: false, error: { message: 'boom', code: 'rate_limit' } },
      { ok: true, id: 'mid-2' },
    ]);
    restoreResend = _setResendSender(sender);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    // One bishopric heard about its seats; re-mailing them next month
    // is worse than the stake scope waiting a quarter.
    expect(outcome).toMatchObject({
      status: 'sent',
      mailsSent: 1,
      mailsFailed: 1,
      sentOn: TODAY,
    });
    expect(emails).toHaveLength(2);
    expect((await readStake()).last_manual_seat_review_date).toBe(TODAY);
    // The case most likely to go unnoticed — some scopes sent, so the
    // quarter is gone for the ones that didn't — logs at WARN, same as
    // the all-failed case, and names the scope that lost its quarter.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('some scopes failed'),
      expect.objectContaining({ mailsFailed: 1, failedScopes: ['stake'] }),
    );
    warn.mockRestore();
  }, 15_000);

  it('keys an email_send_failed audit row on the scope, one row per failed scope', async () => {
    await seedReviewWorthyStake();
    await seedSeat({ member_canonical: 'karl@gmail.com', scope: 'stake' });
    await seedManager('alice@gmail.com', true);
    const { sender } = mockResend([
      { ok: false, error: { message: 'boom', code: 'rate_limit' } },
      { ok: false, error: { message: 'boom', code: 'rate_limit' } },
    ]);
    restoreResend = _setResendSender(sender);

    await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    const { db } = requireEmulators();
    const rows = await db
      .collection(`stakes/${STAKE_ID}/auditLog`)
      .where('action', '==', 'email_send_failed')
      .get();
    // Without the scope in `source` the deterministic suffix would
    // collapse both failures onto one row.
    expect(rows.size).toBe(2);
    expect(rows.docs.map((d) => (d.data()['after'] as { source: string }).source).sort()).toEqual([
      'GE',
      'stake',
    ]);
  }, 15_000);

  it('lists a stake-scope manual duplicate on the stake’s mail, not the ward’s', async () => {
    await seedReviewWorthyStake();
    await seedManager('alice@gmail.com', true);
    // An auto ward seat carrying a manual stake duplicate: the row
    // belongs to the grant's scope, which is not the seat's.
    await seedSeat({
      member_canonical: 'dana@gmail.com',
      member_name: 'Dana Dean',
      type: 'auto',
      callings: ['Bishop'],
      duplicate_grants: [buildDuplicate({ scope: 'stake', reason: 'Stake building committee' })],
    });
    const { sender, calls: emails } = mockResend([]);
    restoreResend = _setResendSender(sender);

    const outcome = await sendManualSeatReviewIfDue(STAKE_ID, NOW);

    expect(outcome).toMatchObject({ status: 'sent', scopes: 2, grants: 2 });
    const stakeMail = emails.find((e) => e.subject.endsWith('Stake'))!;
    const wardMail = emails.find((e) => e.subject.endsWith('Greenwood Ward'))!;
    expect(stakeMail.text).toContain('Dana Dean');
    expect(stakeMail.text).toContain('Stake building committee');
    expect(wardMail.text).not.toContain('Dana Dean');
    // The duplicate inherited the primary's buildings — same site.
    expect(stakeMail.text).toContain('Greenwood');
  }, 15_000);
});
