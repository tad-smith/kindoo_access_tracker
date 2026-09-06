// The expired-temp-seat reminder (T-103), as one unit of work for one
// stake.
//
// Kindoo owns temp-seat expiry; SBA runs no expiry scheduler. When
// Kindoo ends a temp user's access the SBA seat stays put until a
// manager's Sync detects it as `sba-only` and removes it (spec §7,
// D34). In that gap the ward sees a seat whose access already ended and
// — per D34's own history — files a removal request for it. Nothing
// prompts the manager to run Sync. This is that prompt.
//
// The split with whatever schedules this: the caller says "consider
// this stake now", and everything after that word is here. Nothing in
// this file knows about hours, cron expressions, or dispatch — the one
// timezone it reads is the stake's own calendar day, which is domain
// logic (when did this grant expire?), not scheduling.
//
// The every-third-day backoff lives here for the same reason. It is not
// expressible as a schedule even in principle: the rule is "don't
// repeat WHILE the same condition holds, but send immediately on a
// fresh one", and only the code that can see the condition can apply
// it. It is also the dedupe any at-least-once invoker needs.

import { logger } from 'firebase-functions';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  isExpiredTempGrant,
  isoDateSpanDays,
  previousIsoDate,
  syncWillClearSeat,
  todayInStakeTz,
} from '@kindoo/shared';
import type { Seat, Stake } from '@kindoo/shared';
import { getDb } from '../lib/admin.js';
import { activeManagers } from '../lib/managers.js';
import { sendPushToSubscribers } from '../lib/push.js';
import { notifyManagersSyncReminder, type ExpiredTempGrant } from './EmailService.js';

/**
 * Days that must pass before the reminder repeats while the condition
 * persists. Sending on day 0 then every third day after: nagging daily
 * about a backlog someone already knows about trains managers to ignore
 * the mail.
 */
export const SYNC_REMINDER_BACKOFF_DAYS = 3;

export type SyncReminderStatus =
  'sent' | 'stake-missing' | 'setup-incomplete' | 'nothing-expired' | 'backed-off' | 'no-managers';

export type SyncReminderOutcome = {
  stakeId: string;
  status: SyncReminderStatus;
  /** Seats carrying a qualifying grant. */
  seats: number;
  /**
   * Qualifying grants. Equal to `seats` under the current selection,
   * which admits only single-grant seats; kept distinct so widening the
   * rule later can't silently change what this number means.
   */
  grants: number;
  /** Tokens FCM accepted. Zero when nobody opted into the push category. */
  pushed: number;
  /**
   * True when `notifications_enabled === false` suppressed the email.
   * The kill-switch is email-only everywhere in this codebase, so a
   * `sent` outcome can still carry this — push went, email didn't.
   */
  emailSuppressed?: boolean;
  /** Stake-local date stamped on the stake doc, when this run sent. */
  sentOn?: string;
  /** Set only when the push half threw; the email had already gone out. */
  pushError?: string;
};

/**
 * Consider one stake, and send its reminder if one is due.
 *
 * `now` is explicit rather than read from the clock so the backoff is
 * testable without clock games; `db` defaults to the shared Admin
 * handle.
 *
 * Never throws for an ordinary "nothing to do" — those are statuses, so
 * a caller can log the outcome without a try/catch. A genuine fault
 * (Firestore unreachable) still propagates.
 */
export async function sendSyncReminderIfDue(
  stakeId: string,
  now: Date,
  deps: { db?: Firestore } = {},
): Promise<SyncReminderOutcome> {
  const db = deps.db ?? getDb();
  const nothing = (status: SyncReminderStatus): SyncReminderOutcome => ({
    stakeId,
    status,
    seats: 0,
    grants: 0,
    pushed: 0,
  });

  const stakeRef = db.doc(`stakes/${stakeId}`);
  const stakeSnap = await stakeRef.get();
  if (!stakeSnap.exists) return nothing('stake-missing');
  const stake = stakeSnap.data() as Stake;
  // A stake still in the bootstrap wizard has no managers to nag and no
  // roster worth reading.
  if (stake.setup_complete !== true) return nothing('setup-incomplete');

  const today = todayInStakeTz(stake.timezone, now);
  // "Expired more than 24 hours ago" is the canonical expiry rule run
  // against yesterday rather than today — the boundary moves, the rule
  // doesn't. A temp seat is held THROUGH its `end_date`, so a grant
  // that ended yesterday is expired but has not yet had its day.
  const cutoff = previousIsoDate(today);

  // ~250 seats at target scale: read the collection and filter in
  // memory rather than earning a composite index.
  const seatsSnap = await db.collection(`stakes/${stakeId}/seats`).get();
  const grants = expiredTempGrants(
    seatsSnap.docs.map((d) => d.data() as Seat),
    cutoff,
  );

  if (grants.length === 0) {
    // Condition cleared. Drop the stamp so the next occurrence is a
    // fresh first send rather than serving out a backoff it has no
    // relation to. Only when there is one — no stamp, no write.
    if (stake.last_sync_reminder_date !== undefined) {
      await stakeRef.update({ last_sync_reminder_date: FieldValue.delete() });
    }
    return nothing('nothing-expired');
  }

  const seats = new Set(grants.map((g) => g.memberEmail)).size;
  const partial = { stakeId, seats, grants: grants.length, pushed: 0 };

  if (!backoffElapsed(stake.last_sync_reminder_date, today)) {
    return { ...partial, status: 'backed-off' };
  }

  const managers = await activeManagers(db, stakeId);
  if (managers.length === 0) {
    // No stamp: nothing was said, so nothing is being backed off from.
    logger.info('syncReminder: nobody to notify', { stakeId, grants: grants.length });
    return { ...partial, status: 'no-managers' };
  }

  logger.info('syncReminder: firing', {
    stakeId,
    cutoff,
    seats,
    grants: grants.length,
    managers: managers.length,
  });

  // Email first: it is the channel every active manager has, gated only
  // by the stake-level kill-switch. Best-effort inside — a Resend
  // failure lands as an `email_send_failed` audit row, never a throw.
  await notifyManagersSyncReminder({
    db,
    stakeId,
    stake,
    grants,
    managerEmails: managers.map((m) => m.email),
  });

  // Push second, and its failure is reported rather than thrown. The
  // email has already gone out by this point, so letting a transient
  // FCM fault propagate would earn a retry that re-sends the email.
  let pushed = 0;
  let pushError: string | undefined;
  try {
    const result = await sendPushToSubscribers(db, {
      source: 'syncReminder',
      category: 'syncReminder',
      recipients: managers,
      data: {
        title: 'Expired temporary seats',
        body: pushBody(grants.length),
        // `stake` param lands a multi-stake manager in the right stake —
        // URL tier wins over storage tiers in the active-stake resolver
        // (spec §2.1).
        deepLink: `/manager/seats?stake=${stakeId}`,
      },
      context: { stakeId, grants: grants.length },
    });
    pushed = result.tokensSent;
  } catch (err) {
    pushError = err instanceof Error ? err.message : String(err);
    logger.error('syncReminder: push failed; email already sent', { stakeId, error: pushError });
  }

  // Stamp last, so a fault before this point leaves the reminder due
  // rather than silently consumed. Bookkeeping-only by design: the
  // field is in `BOOKKEEPING_FIELDS`, so `auditTrigger` reads the write
  // as a no-op and fans no row. Nothing about the stake changed — a
  // reminder went out — and `lastActor` is deliberately left alone so
  // the stake doc keeps naming whoever last really edited it.
  await stakeRef.update({ last_sync_reminder_date: today });

  return {
    ...partial,
    status: 'sent',
    pushed,
    sentOn: today,
    ...(stake.notifications_enabled === false ? { emailSuppressed: true } : {}),
    ...(pushError ? { pushError } : {}),
  };
}

/**
 * True when enough days have passed since `lastSent` to send again. No
 * stamp means the condition has just tripped, which always sends.
 *
 * An unparseable or future-dated stamp also sends: refusing to remind
 * on the strength of a stamp we can't read is the worse failure of the
 * two, and `isoDateSpanDays` answers `NaN` rather than throwing.
 */
export function backoffElapsed(lastSent: string | undefined, today: string): boolean {
  if (!lastSent) return true;
  const days = isoDateSpanDays(lastSent, today);
  if (Number.isNaN(days)) return true;
  return days >= SYNC_REMINDER_BACKOFF_DAYS || days < 0;
}

/**
 * Every expired temp seat that running Sync will actually clear, in
 * oldest-first order.
 *
 * Narrowed by `syncWillClearSeat` — the same helper D34 uses to decide
 * whether to withhold the Remove control. This reminder is a nudge to
 * run Sync and nothing else, so it may only list seats that running Sync
 * will in fact clear. A recurring email whose call to action is wrong
 * for some of its rows is the fastest way to train managers to ignore
 * all of them.
 *
 * An expired grant on a multi-grant seat is therefore absent here. It is
 * still a seat someone has to deal with — it just needs a remove
 * request rather than a Sync, so it is not this feature's to raise.
 * Don't widen the selection back without changing the mail's call to
 * action to match.
 *
 * A seat that passes `syncWillClearSeat` carries no `duplicate_grants`
 * by definition, so its primary is the only grant there is to check.
 *
 * Pure; exported for unit tests.
 */
export function expiredTempGrants(seats: readonly Seat[], cutoff: string): ExpiredTempGrant[] {
  const rows: ExpiredTempGrant[] = [];
  for (const seat of seats) {
    if (!syncWillClearSeat(seat)) continue;
    if (!isExpiredTempGrant(seat, cutoff)) continue;
    rows.push({
      memberName: seat.member_name ?? '',
      memberEmail: seat.member_email ?? seat.member_canonical,
      scope: seat.scope,
      // Narrowed by `isExpiredTempGrant`, which is false without it.
      endDate: seat.end_date!,
    });
  }
  return rows.sort(
    (a, b) => a.endDate.localeCompare(b.endDate) || a.memberEmail.localeCompare(b.memberEmail),
  );
}

function pushBody(count: number): string {
  const noun = count === 1 ? 'temporary seat' : 'temporary seats';
  return `${count} expired ${noun} still on the roster — run Sync to clear ${count === 1 ? 'it' : 'them'}.`;
}
