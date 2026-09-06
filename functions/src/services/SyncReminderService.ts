// The sync reminder (T-103, T-106), as one unit of work for one stake.
//
// Two independent conditions, one mail. Either sends; both send one
// message naming both. They share a mail because they share their one
// instruction — run Sync — and two mails saying the same thing teaches
// managers to open neither.
//
//   1. Temp seats Kindoo has expired that are still on the SBA roster.
//   2. A Kindoo site the stake operates that nobody has synced in
//      `SYNC_STALE_DAYS`.
//
// Condition 1 (T-103):
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
//
// Condition 2 (T-106):
//
// Sync itself writes nothing when it finds nothing wrong — the drift
// scan runs entirely in the extension and only *fixes* reach the
// server — so a manager who syncs daily and a manager who has not
// synced since June leave the same trace. `syncHeartbeats` is the
// signal that closes that gap, and this is its only reader.

import { logger } from 'firebase-functions';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  REMOTE_APPLY_HOME_SITE_KEY,
  formatDateInStakeTz,
  isExpiredTempGrant,
  isoDateSpanDays,
  previousIsoDate,
  syncWillClearSeat,
  todayInStakeTz,
} from '@kindoo/shared';
import type { KindooSite, Seat, Stake, SyncHeartbeat } from '@kindoo/shared';
import { getDb } from '../lib/admin.js';
import { activeManagers } from '../lib/managers.js';
import { sendPushToSubscribers } from '../lib/push.js';
import {
  notifyManagersSyncReminder,
  type ExpiredTempGrant,
  type StaleSyncSite,
} from './EmailService.js';

/**
 * Days that must pass before the reminder repeats while the condition
 * persists. Sending on day 0 then every third day after: nagging daily
 * about a backlog someone already knows about trains managers to ignore
 * the mail.
 */
export const SYNC_REMINDER_BACKOFF_DAYS = 3;

/**
 * Whole stake-local days a site may go unsynced before the reminder
 * names it. Seven, so a manager who syncs once a week is never chased.
 *
 * Deliberately NOT in `@kindoo/shared`: the extension only stamps a
 * time, and this handler is the only thing anywhere that asks whether
 * that time is old. A shared constant would advertise a second consumer
 * that does not exist.
 *
 * Note this is a wider window than `SYNC_REMINDER_BACKOFF_DAYS`, and
 * that is right: seven days decides whether a site *is* stale, three
 * decides how often we may say so. A stake that stays stale hears about
 * it every third day, not every seventh.
 *
 * Compared strictly (`> 7`, not `>= 7`), so a site is stale on the
 * eighth calendar day. Calendar-day spans round in the reminder's
 * favour, and `>= 7` would chase a weekly-cadence manager after barely
 * six and a half days.
 */
export const SYNC_STALE_DAYS = 7;

/**
 * How a run ended.
 *
 * `nothing-due` covers "neither condition fired" — it was
 * `nothing-expired` while expired seats were the only condition, which
 * stopped being true the moment a stale sync could fire on its own.
 */
export type SyncReminderStatus =
  | 'sent'
  | 'stake-missing'
  | 'setup-incomplete'
  | 'nothing-due'
  | 'backed-off'
  | 'no-managers';

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
  /** Operated Kindoo sites whose last heartbeat is `SYNC_STALE_DAYS` old or older. */
  staleSites: number;
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
    staleSites: 0,
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

  // ~250 seats and a handful of sites at target scale: read the
  // collections and filter in memory rather than earning a composite
  // index. Both conditions are evaluated every run — the "nothing due"
  // answer depends on both — so the three reads go out together.
  const [seatsSnap, sitesSnap, heartbeatsSnap] = await Promise.all([
    db.collection(`stakes/${stakeId}/seats`).get(),
    db.collection(`stakes/${stakeId}/kindooSites`).get(),
    db.collection(`syncHeartbeats/${stakeId}/sites`).get(),
  ]);

  const grants = expiredTempGrants(
    seatsSnap.docs.map((d) => d.data() as Seat),
    cutoff,
  );

  const stale = staleSyncSites(
    operatedSites(
      stake,
      sitesSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Partial<KindooSite>) })),
    ),
    lastSyncDates(heartbeatsSnap.docs, stake.timezone),
    today,
  );

  if (grants.length === 0 && stale.length === 0) {
    // Both conditions clear. Drop the stamp so the next occurrence is a
    // fresh first send rather than serving out a backoff it has no
    // relation to. Only when there is one — no stamp, no write.
    if (stake.last_sync_reminder_date !== undefined) {
      await stakeRef.update({ last_sync_reminder_date: FieldValue.delete() });
    }
    return nothing('nothing-due');
  }

  const seats = new Set(grants.map((g) => g.memberEmail)).size;
  const partial = {
    stakeId,
    seats,
    grants: grants.length,
    staleSites: stale.length,
    pushed: 0,
  };

  if (!backoffElapsed(stake.last_sync_reminder_date, today)) {
    return { ...partial, status: 'backed-off' };
  }

  const managers = await activeManagers(db, stakeId);
  if (managers.length === 0) {
    // No stamp: nothing was said, so nothing is being backed off from.
    logger.info('syncReminder: nobody to notify', {
      stakeId,
      grants: grants.length,
      staleSites: stale.length,
    });
    return { ...partial, status: 'no-managers' };
  }

  logger.info('syncReminder: firing', {
    stakeId,
    cutoff,
    seats,
    grants: grants.length,
    staleSites: stale.length,
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
    staleSites: stale,
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
        title: pushTitle(grants.length, stale.length),
        body: pushBody(grants.length, stale.length),
        // `stake` param lands a multi-stake manager in the right stake —
        // URL tier wins over storage tiers in the active-stake resolver
        // (spec §2.1).
        deepLink: `/manager/seats?stake=${stakeId}`,
      },
      context: { stakeId, grants: grants.length, staleSites: stale.length },
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

/**
 * One Kindoo site the stake operates, as the heartbeat keys it.
 *
 * `siteKey` is the `syncHeartbeats/{stakeId}/sites` doc id; `siteName`
 * is what the manager will recognise in Kindoo's site switcher.
 */
export type OperatedSite = { siteKey: string; siteName: string };

/**
 * Every Kindoo site this stake operates: its home site, plus each
 * configured foreign site (spec §15).
 *
 * This is the whole answer to "which sites count". A heartbeat outside
 * this set is ignored, which matters because heartbeats can never be
 * deleted (rules deny it, deliberately — a missing document reads as
 * "never synced", which is silent forever). Un-configure a foreign site
 * and its heartbeat is left behind; without the intersection it would
 * age past the window and nag about a site the stake can no longer sync
 * and no one can clear.
 *
 * Home is always operated. It is the stake's own Kindoo environment by
 * construction, so there is no configuration state that can make it
 * not-ours; a stake that has never configured it has simply never
 * heartbeated, and absence is already silent.
 *
 * A foreign site that is configured but has no wards assigned is still
 * counted. Keeping the site configured is the statement that the stake
 * operates it — and in practice such a site is never synced, so it
 * never heartbeats and never fires.
 *
 * Pure; exported for unit tests.
 */
export function operatedSites(
  stake: Pick<Stake, 'stake_name' | 'kindoo_config' | 'kindoo_expected_site_name'>,
  sites: ReadonlyArray<{ id: string } & Partial<Pick<KindooSite, 'display_name'>>>,
): OperatedSite[] {
  // Keyed, not appended: a manager-chosen foreign slug of `home` would
  // otherwise sit beside the reserved home key as a second entry with
  // the same heartbeat. Home is inserted first and wins.
  const byKey = new Map<string, OperatedSite>();
  byKey.set(REMOTE_APPLY_HOME_SITE_KEY, {
    siteKey: REMOTE_APPLY_HOME_SITE_KEY,
    siteName: homeSiteName(stake),
  });
  for (const site of sites) {
    if (byKey.has(site.id)) continue;
    byKey.set(site.id, { siteKey: site.id, siteName: site.display_name?.trim() || site.id });
  }
  return [...byKey.values()];
}

/**
 * What to call the home site in the mail. Kindoo's own captured display
 * name first, since that is the label in the site switcher the manager
 * is being sent to; then the operator's expected-name override; then
 * the stake name. Mirrors the extension's `homeSiteName` preference
 * order.
 */
function homeSiteName(
  stake: Pick<Stake, 'stake_name' | 'kindoo_config' | 'kindoo_expected_site_name'>,
): string {
  return (
    stake.kindoo_config?.site_name?.trim() ||
    stake.kindoo_expected_site_name?.trim() ||
    stake.stake_name?.trim() ||
    'Home Kindoo site'
  );
}

/**
 * Heartbeat docs → `siteKey` → the stake-local calendar day the last
 * Sync completed on.
 *
 * Calendar days rather than instants, so this half is measured the same
 * way the expiry half is and neither can be a few hours off the other.
 * An unreadable `last_sync_at` is dropped: it is not evidence that a
 * site went unsynced, and every ambiguity in this feature resolves
 * toward silence.
 */
function lastSyncDates(
  docs: ReadonlyArray<{ id: string; data: () => unknown }>,
  timezone: string | undefined,
): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const doc of docs) {
    const hb = doc.data() as SyncHeartbeat;
    const iso = formatDateInStakeTz(hb.last_sync_at, timezone);
    if (iso) byKey.set(doc.id, iso);
  }
  return byKey;
}

/**
 * Every operated site whose last Sync is `SYNC_STALE_DAYS` days old or
 * older, oldest first.
 *
 * **A site with no heartbeat is not stale.** A stake that has never
 * written one is never chased — only a site that heartbeated and then
 * went quiet. Firing on absence would be more literally truthful and
 * would mail every stake for the whole extension rollout, teaching
 * managers that this reminder is noise. That is the one thing it cannot
 * afford, so absence is silent by design; don't "fix" it.
 *
 * A future-dated heartbeat is likewise not stale — negative days fall
 * below the threshold, and a clock we cannot trust should not nag.
 *
 * Pure; exported for unit tests.
 */
export function staleSyncSites(
  sites: readonly OperatedSite[],
  lastSyncByKey: ReadonlyMap<string, string>,
  today: string,
): StaleSyncSite[] {
  const rows: StaleSyncSite[] = [];
  for (const site of sites) {
    const lastSyncDate = lastSyncByKey.get(site.siteKey);
    if (lastSyncDate === undefined) continue;
    const daysSince = isoDateSpanDays(lastSyncDate, today);
    // Strictly greater, not `>=`. The span is in stake-local calendar
    // days, so `=== 7` can be as little as ~6d7h of wall clock against a
    // 06:00 dispatch — which would mail the manager who syncs reliably
    // every Sunday, every Sunday. That is precisely the person this
    // reminder exists to leave alone, and it is what makes the mail's
    // "in over a week" true rather than approximately true.
    if (!Number.isFinite(daysSince) || daysSince <= SYNC_STALE_DAYS) continue;
    rows.push({ ...site, lastSyncDate, daysSince });
  }
  return rows.sort((a, b) => b.daysSince - a.daysSince || a.siteName.localeCompare(b.siteName));
}

function pushTitle(grants: number, staleSites: number): string {
  if (grants === 0) return 'Sync is overdue';
  return staleSites === 0 ? 'Expired temporary seats' : 'Sync is overdue';
}

function pushBody(grants: number, staleSites: number): string {
  const clauses: string[] = [];
  if (grants > 0) {
    const noun = grants === 1 ? 'temporary seat' : 'temporary seats';
    // Seats-only keeps T-103's wording verbatim, down to the pronoun —
    // this is the case managers have already been receiving.
    if (staleSites === 0) {
      const it = grants === 1 ? 'it' : 'them';
      return `${grants} expired ${noun} still on the roster — run Sync to clear ${it}.`;
    }
    clauses.push(`${grants} expired ${noun} still on the roster`);
  }
  if (staleSites > 0) {
    const noun = staleSites === 1 ? 'Kindoo site' : 'Kindoo sites';
    clauses.push(`${staleSites} ${noun} not synced in over a week`);
  }
  return `${clauses.join(', ')} — run Sync.`;
}
