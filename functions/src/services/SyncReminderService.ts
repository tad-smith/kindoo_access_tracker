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
// Deliberately knows nothing about scheduling: no cron expression, no
// hour gate, no "have I run recently". Whatever decides WHEN to
// consider a stake calls `sendSyncReminder(stakeId)` and reads the
// outcome. That keeps the invoker a thin shell and keeps this testable
// without a clock.
//
// Send-frequency backoff is likewise NOT here yet — see the module note
// at the bottom for where it belongs when it lands.

import { logger } from 'firebase-functions';
import type { Firestore } from 'firebase-admin/firestore';
import { isExpiredTempGrant, previousIsoDate, todayInStakeTz } from '@kindoo/shared';
import type { Seat, Stake } from '@kindoo/shared';
import { getDb } from '../lib/admin.js';
import { activeManagers } from '../lib/managers.js';
import { sendPushToSubscribers } from '../lib/push.js';
import { notifyManagersSyncReminder, type ExpiredTempGrant } from './EmailService.js';

export type SyncReminderStatus =
  | 'sent'
  | 'stake-missing'
  | 'setup-incomplete'
  | 'nothing-expired'
  | 'no-managers';

export type SyncReminderOutcome = {
  stakeId: string;
  status: SyncReminderStatus;
  /** Seats carrying at least one qualifying grant. */
  seats: number;
  /** Qualifying grants across those seats — a seat can contribute more than one. */
  grants: number;
  /** Tokens FCM accepted. Zero when nobody opted into the push category. */
  pushed: number;
  /** Set only when the push half threw; the email had already gone out. */
  pushError?: string;
};

/**
 * Send one stake's reminder, if it has anything to say.
 *
 * `now` is injectable for tests; production callers pass nothing. `db`
 * likewise defaults to the shared Admin handle.
 *
 * Never throws for an ordinary "nothing to do" — those are statuses, so
 * a caller can log them without a try/catch. A genuine fault (Firestore
 * unreachable) still propagates.
 */
export async function sendSyncReminder(
  stakeId: string,
  deps: { db?: Firestore; now?: Date } = {},
): Promise<SyncReminderOutcome> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const nothing = (status: SyncReminderStatus): SyncReminderOutcome => ({
    stakeId,
    status,
    seats: 0,
    grants: 0,
    pushed: 0,
  });

  const stakeSnap = await db.doc(`stakes/${stakeId}`).get();
  if (!stakeSnap.exists) return nothing('stake-missing');
  const stake = stakeSnap.data() as Stake;
  // A stake still in the bootstrap wizard has no managers to nag and no
  // roster worth reading.
  if (stake.setup_complete !== true) return nothing('setup-incomplete');

  // "Expired more than 24 hours ago" is the canonical expiry rule run
  // against yesterday rather than today — the boundary moves, the rule
  // doesn't. A temp seat is held THROUGH its `end_date`, so a grant
  // that ended yesterday is expired but has not yet had its day.
  const cutoff = previousIsoDate(todayInStakeTz(stake.timezone, now));

  // ~250 seats at target scale: read the collection and filter in
  // memory rather than earning a composite index.
  const seatsSnap = await db.collection(`stakes/${stakeId}/seats`).get();
  const grants = expiredTempGrants(
    seatsSnap.docs.map((d) => d.data() as Seat),
    cutoff,
  );
  if (grants.length === 0) return nothing('nothing-expired');

  const seats = new Set(grants.map((g) => g.memberEmail)).size;
  const managers = await activeManagers(db, stakeId);
  if (managers.length === 0) {
    logger.info('syncReminder: nobody to notify', { stakeId, grants: grants.length });
    return { ...nothing('no-managers'), seats, grants: grants.length };
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

  return {
    stakeId,
    status: 'sent',
    seats,
    grants: grants.length,
    pushed,
    ...(pushError ? { pushError } : {}),
  };
}

/**
 * Every temp grant on `seats` that expired on or before `cutoff`, in
 * oldest-first order.
 *
 * Both the primary grant and `duplicate_grants[]` are checked: an
 * expired temp grant can sit alongside a live one on the same seat, and
 * that seat is exactly the case a roster reader finds most confusing.
 * Nothing here consults `syncWillClearSeat` — a multi-grant seat is
 * still a seat someone has to deal with, even though Sync alone won't
 * reap it.
 *
 * Pure; exported for unit tests.
 */
export function expiredTempGrants(seats: readonly Seat[], cutoff: string): ExpiredTempGrant[] {
  const rows: ExpiredTempGrant[] = [];
  for (const seat of seats) {
    for (const grant of [seat, ...(seat.duplicate_grants ?? [])]) {
      if (!isExpiredTempGrant(grant, cutoff)) continue;
      rows.push({
        memberName: seat.member_name ?? '',
        memberEmail: seat.member_email ?? seat.member_canonical,
        scope: grant.scope,
        // Narrowed by `isExpiredTempGrant`, which is false without it.
        endDate: grant.end_date!,
      });
    }
  }
  return rows.sort(
    (a, b) => a.endDate.localeCompare(b.endDate) || a.memberEmail.localeCompare(b.memberEmail),
  );
}

function pushBody(count: number): string {
  const noun = count === 1 ? 'temporary seat' : 'temporary seats';
  return `${count} expired ${noun} still on the roster — run Sync to clear ${count === 1 ? 'it' : 'them'}.`;
}

// Where the every-third-day backoff goes when it lands: with the
// reminder's own state, not with whatever schedules it. The cron says
// "consider this stake"; only this function can see whether there is
// anything to say, and the rule is "don't repeat WHILE the same
// condition holds, but send immediately on a fresh one" — a condition a
// schedule interval cannot express. It is also the natural home for the
// at-least-once dedupe any task-queue invoker will need. Storing it
// beside the invoker's own per-(stake, task) state keeps per-feature
// fields off the stake doc, and off the audit trigger that watches it.
