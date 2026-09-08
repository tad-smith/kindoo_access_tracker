// The quarterly manual-seat review, as one unit of work for one stake.
//
// Auto seats follow the callings Sync reads out of Kindoo, and temp
// seats end on a date. Manual seats do neither: they are granted for a
// reason a person typed, and they last until a person takes them away.
// Nothing in the system has ever asked whether that reason still holds,
// so a manual seat granted for a calling outlives the calling — quietly,
// and for years.
//
// Once a quarter, this mails the people responsible for each scope the
// list of manual seats on it and asks them to remove anyone who no
// longer needs access. Per scope, not per stake: the bishopric knows
// who in their own ward still has the calling, and the Kindoo Managers
// do not.
//
// The split with whatever schedules this is the same one
// `SyncReminderService` draws: the caller says "consider this stake
// now", and everything after that word is here. Nothing in this file
// knows about cron, dispatch, or jitter — the one timezone it reads is
// the stake's own calendar day.

import { logger } from 'firebase-functions';
import type { Firestore } from 'firebase-admin/firestore';
import { isoDateSpanDays, todayInStakeTz } from '@kindoo/shared';
import type { Access, Seat, Stake } from '@kindoo/shared';
import { getDb } from '../lib/admin.js';
import { activeManagers } from '../lib/managers.js';
import {
  loadScopeLabeller,
  notifyScopeManualSeatReview,
  type ManualSeatReviewGrant,
} from './EmailService.js';

/**
 * Whole stake-local days that must pass before the review comes round
 * again.
 *
 * Seventy-five, and the arithmetic is the whole reason it is safe. The
 * job checks monthly, so the interval decides which checks send. The
 * longest two-month gap is 62 days (Jul 1 → Sep 1) and the shortest
 * three-month gap is 89 (Feb 1 → May 1, non-leap), so any threshold in
 * 63..89 rejects every second month and admits every third one,
 * forever, in every calendar year. 75 is the middle of that band — as
 * far from either edge as it can be, so no leap year, DST shift or
 * clamped monthly day can walk it over a boundary.
 *
 * Deliberately not in `@kindoo/shared`: this handler is the only thing
 * anywhere that asks the question.
 */
export const MANUAL_SEAT_REVIEW_INTERVAL_DAYS = 75;

/** Whole milliseconds to wait between two per-scope sends. */
const SEND_GAP_MS = 1000;

/** How a run ended. */
export type ManualSeatReviewStatus =
  | 'sent'
  | 'stake-missing'
  | 'setup-incomplete'
  | 'nothing-due'
  | 'backed-off'
  | 'no-recipients'
  | 'send-failed';

export type ManualSeatReviewOutcome = {
  stakeId: string;
  status: ManualSeatReviewStatus;
  /** Scopes carrying at least one manual grant. */
  scopes: number;
  /** Manual grants across every scope. */
  grants: number;
  /**
   * Per-scope mails that landed, plus any the stake-level kill-switch
   * deliberately suppressed — see `emailSuppressed`. This is the count
   * the stamp follows: a suppressed send is a decision and consumes the
   * quarter, a failed one is a fault and does not.
   */
  mailsSent: number;
  /**
   * Per-scope mails attempted that did not land — a Resend error, or a
   * link that could not be built. Excluded from `mailsSent` on purpose.
   */
  mailsFailed: number;
  /**
   * Scopes with manual grants that the REAL recipient rule answers
   * nobody for. In a production run that is also the count of scopes
   * that sent nothing. Under a dry run it is the finding rather than the
   * consequence — those scopes are mailed to the managers anyway, and
   * this number is what the operator is looking for.
   */
  scopesSkipped: number;
  /** Stake-local date stamped on the stake doc, when this run sent. */
  sentOn?: string;
  /** True when `notifications_enabled === false` suppressed every send. */
  emailSuppressed?: boolean;
  /** True when `stake.manual_seat_review_dry_run` redirected this run. */
  dryRun?: true;
};

/**
 * Consider one stake, and send its review if one is due.
 *
 * `now` is explicit rather than read from the clock so the interval is
 * testable without clock games; `db` defaults to the shared Admin
 * handle.
 *
 * Never throws for an ordinary "nothing to do" — those are statuses. A
 * genuine fault (Firestore unreachable) still propagates.
 */
export async function sendManualSeatReviewIfDue(
  stakeId: string,
  now: Date,
  deps: { db?: Firestore } = {},
): Promise<ManualSeatReviewOutcome> {
  const db = deps.db ?? getDb();
  // Set once the stake doc is read; every return before that reports
  // false because nothing yet knows otherwise.
  let dryRun = false;
  const nothing = (status: ManualSeatReviewStatus): ManualSeatReviewOutcome => ({
    stakeId,
    status,
    scopes: 0,
    grants: 0,
    mailsSent: 0,
    mailsFailed: 0,
    scopesSkipped: 0,
    ...(dryRun ? { dryRun: true as const } : {}),
  });

  const stakeRef = db.doc(`stakes/${stakeId}`);
  const stakeSnap = await stakeRef.get();
  if (!stakeSnap.exists) return nothing('stake-missing');
  const stake = stakeSnap.data() as Stake;
  dryRun = stake.manual_seat_review_dry_run === true;
  // A stake still in the bootstrap wizard has no bishoprics to write to
  // and no roster worth reviewing.
  if (stake.setup_complete !== true) return nothing('setup-incomplete');

  const today = todayInStakeTz(stake.timezone, now);
  // Interval first: it is one field off a document already read, and
  // rejecting here saves four collection reads on eleven months out of
  // twelve.
  if (!intervalElapsed(stake.last_manual_seat_review_date, today)) {
    return nothing('backed-off');
  }

  // ~250 seats, ~250 access docs, a dozen wards and a handful of
  // managers at target scale: read the collections whole and filter in
  // memory rather than earning composite indexes. One wards read backs
  // the labeller for every scope this run mails.
  const [seatsSnap, accessSnap, labelScope, managers] = await Promise.all([
    db.collection(`stakes/${stakeId}/seats`).get(),
    db.collection(`stakes/${stakeId}/access`).get(),
    loadScopeLabeller(db, stakeId),
    activeManagers(db, stakeId),
  ]);

  const byScope = manualGrantsByScope(seatsSnap.docs.map((d) => d.data() as Seat));
  const totalGrants = [...byScope.values()].reduce((sum, rows) => sum + rows.length, 0);
  if (byScope.size === 0) {
    // **The stamp advances, never deletes.** This is a cadence, not a
    // condition: an empty quarter is a quarter that happened. Not
    // stamping would leave `last_manual_seat_review_date` at its old
    // value — already ≥ the interval, since that is why this line was
    // reached — so the very next monthly check would fire again and the
    // first manual seat to appear would be reviewed within a month
    // instead of at the next quarter.
    await stakeRef.update({ last_manual_seat_review_date: today });
    return nothing('nothing-due');
  }

  const accessDocs = accessSnap.docs.map((d) => ({
    id: d.id,
    data: d.data() as Partial<Access>,
  }));
  const managerEmails = managers.map((m) => m.email);

  // The gap below exists solely to stay under Resend's request rate. With
  // the stake kill-switch on, the wrapper short-circuits before Resend is
  // ever called, so a 13-scope stake would otherwise sleep ~12s to send
  // nothing.
  const callsResend = stake.notifications_enabled !== false;
  if (dryRun && !callsResend) {
    // The kill-switch is the kill-switch — a dry run must not bypass it
    // — but an operator who set the flag and then watched an empty
    // inbox would have no way to tell this from a broken feature.
    logger.warn('manualSeatReview: DRY RUN suppressed by notifications_enabled=false — no mail', {
      stakeId,
      dryRun: true,
    });
  }

  let mailsSent = 0;
  let mailsFailed = 0;
  let scopesSkipped = 0;
  let attempted = 0;
  const failedScopes: string[] = [];
  for (const scope of sortScopes([...byScope.keys()])) {
    // The real rule runs either way. Under a dry run its answer is
    // reported — in the outcome, in the log, and in the mail's own body
    // — rather than obeyed.
    const intendedRecipients =
      scope === 'stake' ? managerEmails : bishopricRecipients(accessDocs, scope);
    const recipients = dryRun ? managerEmails : intendedRecipients;
    if (intendedRecipients.length === 0) {
      // No fallback, deliberately: a ward with no qualifying access
      // sends nothing rather than falling back to the managers, who
      // cannot answer "does this person still need it?" for a ward.
      //
      // **A dry run deliberately diverges here and sends anyway.** In
      // production this branch is silent from the operator's side — the
      // scope's manual seats go unreviewed and only a log line says so —
      // which is exactly the failure a dry run exists to surface. Don't
      // "tidy" this back into an unconditional skip.
      scopesSkipped += 1;
      logger.info(
        dryRun
          ? 'manualSeatReview: dry run — no real recipient for scope; mailing the managers instead'
          : 'manualSeatReview: no recipient for scope',
        { stakeId, scope, ...(dryRun ? { dryRun: true } : {}) },
      );
      if (!dryRun) continue;
    }
    if (recipients.length === 0) {
      // Dry run on a stake with no active Kindoo Managers: nobody to
      // show the run to at all. Unreachable in a production run, which
      // already continued above.
      logger.info('manualSeatReview: dry run has no Kindoo Manager to mail', {
        stakeId,
        scope,
        dryRun: true,
      });
      continue;
    }

    // Sequential, with a gap between sends: Resend's default rate is 2
    // requests per second and a large stake fans out to ~13 scopes.
    if (callsResend && attempted > 0) await wait(SEND_GAP_MS);
    attempted += 1;
    const result = await notifyScopeManualSeatReview({
      db,
      stakeId,
      stake,
      scope,
      scopeLabel: labelScope(scope),
      grants: byScope.get(scope) ?? [],
      recipients,
      ...(dryRun ? { dryRun: { intendedRecipients } } : {}),
    });
    if (result === 'failed') {
      mailsFailed += 1;
      failedScopes.push(scope);
    } else mailsSent += 1;
  }

  const partial = {
    stakeId,
    scopes: byScope.size,
    grants: totalGrants,
    mailsSent,
    mailsFailed,
    scopesSkipped,
    ...(dryRun ? { dryRun: true as const } : {}),
  };

  if (attempted === 0) {
    // Nothing was said, so nothing is being deferred: no stamp, and the
    // next month's check tries again. Recurs silently forever if nobody
    // fixes it, so WARN — same reasoning as the send-failed branches
    // below: nothing else surfaces this.
    //
    // The status keeps its meaning under a dry run, but not its cause:
    // "no real recipient" no longer reaches here (that scope mails the
    // managers and is reported in `scopesSkipped`), so the only way to
    // land here is a stake with no active Kindoo Manager to show the run
    // to — still nobody notified, still no quarter consumed.
    logger.warn('manualSeatReview: nobody to notify on any scope', {
      stakeId,
      scopes: byScope.size,
      grants: totalGrants,
      ...(dryRun ? { dryRun: true } : {}),
    });
    return { ...partial, status: 'no-recipients' };
  }

  if (mailsSent === 0) {
    // Every attempt failed — a Resend outage, an unset key, an
    // unbuildable link. Consuming the quarter here would turn a bad
    // afternoon into three months of silence with no retry, so the
    // stamp is withheld and next month's check tries again. WARN
    // because nothing else surfaces this: `email_send_failed` audit
    // rows are written but no alert is routed to them.
    logger.warn('manualSeatReview: every send failed — quarter not consumed', {
      stakeId,
      scopes: byScope.size,
      grants: totalGrants,
      mailsFailed,
      scopesSkipped,
      ...(dryRun ? { dryRun: true } : {}),
    });
    return { ...partial, status: 'send-failed' };
  }

  if (mailsFailed > 0) {
    // Some scopes sent, so the quarter is consumed below and this is the
    // case most likely to go unnoticed: a failed bishopric's only other
    // trace is an `email_send_failed` audit row nothing alerts on, and
    // it now waits a full quarter for the next attempt. WARN, same as
    // the all-failed case, and name the scopes so the line says whose
    // quarter was lost.
    logger.warn('manualSeatReview: some scopes failed — quarter consumed for the rest', {
      stakeId,
      scopes: byScope.size,
      grants: totalGrants,
      mailsSent,
      mailsFailed,
      scopesSkipped,
      failedScopes,
      ...(dryRun ? { dryRun: true } : {}),
    });
  } else {
    logger.info('manualSeatReview: sent', {
      stakeId,
      scopes: byScope.size,
      grants: totalGrants,
      mailsSent,
      mailsFailed,
      scopesSkipped,
      ...(dryRun ? { dryRun: true } : {}),
    });
  }

  // Stamp last, and only because at least one scope's mail landed or was
  // deliberately suppressed by the kill-switch. A fault before this point
  // leaves the review due rather than silently consumed — a duplicate
  // review email is a far better failure than a quarter of silence about
  // seats nobody is watching. Bookkeeping-only: the field is in
  // `BOOKKEEPING_FIELDS`, so the write fans no audit row, and `lastActor`
  // is left alone so the stake doc keeps naming whoever last really
  // edited it.
  await stakeRef.update({ last_manual_seat_review_date: today });

  return {
    ...partial,
    status: 'sent',
    sentOn: today,
    ...(stake.notifications_enabled === false ? { emailSuppressed: true } : {}),
  };
}

/**
 * True when enough days have passed since `lastSent` to review again.
 *
 * No stamp means the stake has never been reviewed, which always sends.
 * An unparseable or future-dated stamp also sends — same failure
 * direction as the sync reminder's `backoffElapsed`: refusing to review
 * on the strength of a stamp we cannot read is the worse of the two
 * failures, and `isoDateSpanDays` answers `NaN` rather than throwing.
 *
 * Pure; exported for unit tests.
 */
export function intervalElapsed(
  lastSent: string | undefined,
  today: string,
  intervalDays: number = MANUAL_SEAT_REVIEW_INTERVAL_DAYS,
): boolean {
  if (!lastSent) return true;
  const days = isoDateSpanDays(lastSent, today);
  if (Number.isNaN(days)) return true;
  return days >= intervalDays || days < 0;
}

/**
 * Every manual grant on every seat, grouped by **the grant's own
 * scope**.
 *
 * A seat carries a primary grant plus zero or more `duplicate_grants[]`,
 * and a duplicate's scope can differ from the primary's — a stake-scope
 * manual duplicate on a ward-scope auto seat is the ordinary shape. The
 * row belongs to the scope that earns it, which is the grant's, so a
 * bishopric's mail lists exactly the manual access on their own roster.
 *
 * `apps/web/src/lib/grants.ts`'s `grantsForDisplay` is the web-side
 * equivalent; it lives in the SPA, so this is the small flattening this
 * side needs rather than a shared abstraction neither side asked for.
 *
 * Rows are sorted by name then address, so a mail's table is stable
 * across quarters and a diff between two of them reads.
 *
 * Pure; exported for unit tests.
 */
export function manualGrantsByScope(seats: readonly Seat[]): Map<string, ManualSeatReviewGrant[]> {
  const byScope = new Map<string, ManualSeatReviewGrant[]>();
  const push = (scope: string, row: ManualSeatReviewGrant): void => {
    const rows = byScope.get(scope);
    if (rows) rows.push(row);
    else byScope.set(scope, [row]);
  };

  for (const seat of seats) {
    const memberName = seat.member_name ?? '';
    const memberEmail = seat.member_email ?? seat.member_canonical;
    const primarySite = normaliseSite(seat.kindoo_site_id);

    if (seat.type === 'manual') {
      push(seat.scope, {
        memberName,
        memberEmail,
        reason: seat.reason ?? '',
        buildingNames: [...(seat.building_names ?? [])],
      });
    }
    for (const dup of seat.duplicate_grants ?? []) {
      if (dup?.type !== 'manual') continue;
      // A within-site duplicate may leave `building_names` unset and
      // inherit the primary's ward buildings. A parallel-site duplicate
      // must not: the primary's buildings are on a different Kindoo
      // site, so rendering them here would be wrong data rather than
      // missing data. Same rule the web's `grantsForDisplay` applies.
      const sameSite = normaliseSite(dup.kindoo_site_id) === primarySite;
      const inherited = sameSite ? (seat.building_names ?? []) : [];
      push(dup.scope, {
        memberName,
        memberEmail,
        reason: dup.reason ?? '',
        buildingNames: [...(dup.building_names ?? inherited)],
      });
    }
  }

  for (const rows of byScope.values()) {
    rows.sort(
      (a, b) =>
        a.memberName.localeCompare(b.memberName) || a.memberEmail.localeCompare(b.memberEmail),
    );
  }
  return byScope;
}

/**
 * Who gets a ward's or branch's review: everyone whose access doc
 * carries at least one **importer-sourced, non-limited** calling for
 * that scope.
 *
 * In practice that is the Bishop, both counselors, the Ward Clerk and
 * the Ward Executive Secretary — or the branch equivalents. Those are
 * the people who know whether a manual seat's reason still holds.
 *
 * Three exclusions, each deliberate:
 *
 *   - **Manual grants confer nothing here.** `manual_grants[scope]` is
 *     how a manager hands someone the app; it is not evidence that they
 *     are answerable for the ward's roster.
 *   - **Limited-tier callings are excluded**, and this one is
 *     load-bearing rather than tidy. The only limited unit calling is
 *     Elders Quorum President (D26), and `canRemoveSeat` refuses a
 *     limited user any non-temp grant — so an EQ President receiving
 *     this mail would open a list of manual seats with no Remove
 *     control on a single row.
 *   - **No fallback.** A scope with nobody qualifying sends nothing.
 *
 * Malformed maps are tolerated the way `scopesFromAccessDoc` tolerates
 * them: garbage never reads as a restriction, so an unreadable
 * `importer_limited_callings` leaves every calling full rather than
 * silencing the scope.
 *
 * Pure; exported for unit tests.
 */
export function bishopricRecipients(
  docs: ReadonlyArray<{ id: string; data: Partial<Access> }>,
  scope: string,
): string[] {
  const recipients: string[] = [];
  for (const doc of docs) {
    const importer = asRecord(doc.data.importer_callings)[scope];
    if (!Array.isArray(importer)) continue;
    const limited = limitedKeys(asRecord(doc.data.importer_limited_callings)[scope]);
    const hasFull = importer.some(
      (calling) => typeof calling === 'string' && !limited.has(normaliseCalling(calling)),
    );
    if (!hasFull) continue;
    recipients.push(doc.data.member_email?.trim() || doc.id);
  }
  return recipients;
}

/**
 * Send order: the stake first, then ward codes alphabetically. Purely
 * for determinism — a run's mails and its logs come out in the same
 * order every time, which is what makes "did the fourth scope send?"
 * answerable.
 */
function sortScopes(scopes: string[]): string[] {
  return scopes.sort((a, b) => {
    if (a === b) return 0;
    if (a === 'stake') return -1;
    if (b === 'stake') return 1;
    return a.localeCompare(b);
  });
}

/** Legacy seats carry the site as absent or empty; both mean home. */
function normaliseSite(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Trim + lowercase, matching the key scheme the tier stamp is written in. */
function normaliseCalling(calling: string): string {
  return calling.trim().toLowerCase();
}

function limitedKeys(value: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!Array.isArray(value)) return keys;
  for (const entry of value) {
    if (typeof entry === 'string') keys.add(normaliseCalling(entry));
  }
  return keys;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
