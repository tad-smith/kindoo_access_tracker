// Expired temp grants (spec §7).
//
// Kindoo owns temp-seat expiry; SBA runs no expiry scheduler. When
// Kindoo ends a temp user's access the SBA seat stays put until a
// manager's Sync detects it as `sba-only` and removes it. In that gap a
// ward sees a seat whose access has already ended and reads it as
// something to clean up — which is how expired temp seats started
// arriving in the queue as remove requests.
//
// So: an expired grant renders marked and inert on the roster surfaces
// rather than actionable. The row stays visible (a silently absent seat
// would be its own confusion, and SBA's `end_date` is a mirror of what
// was provisioned, not proof of what Kindoo currently holds); it just
// stops offering Remove to anyone who isn't a Kindoo Manager.
//
// The seat is held THROUGH its end date, so expiry begins the day
// after — compared against the stake's calendar day, not the viewer's.
//
// Shared rather than web-local because the rule now has two consumers:
// the roster surfaces that mark the row, and the scheduled reminder
// (`functions/src/scheduled/notifySyncReminders.ts`) that nudges a
// manager to run the Sync which clears it. Two copies of "when is a
// temp grant expired" would let the badge and the reminder disagree.

import type { Seat } from './types/index.js';
import { formatDateInStakeTz } from './stakeTime.js';

/**
 * The two fields expiry reads. Structural on purpose: a `Seat`, a
 * `DuplicateGrant`, and the web's `GrantView` all satisfy it without
 * being reshaped, so no caller has to pick a type the others can't use.
 */
export type ExpirableGrant = { type: string; end_date?: string | undefined };

/**
 * Today's calendar date as `YYYY-MM-DD` in the stake's timezone — the
 * right-hand side of every expiry comparison. `now` is injectable for
 * tests; production callers pass nothing.
 */
export function todayInStakeTz(timezone: string | undefined, now: Date = new Date()): string {
  return formatDateInStakeTz(now, timezone);
}

/**
 * True when `grant` is a temp grant whose end date has passed.
 *
 * Both sides are ISO `YYYY-MM-DD`, so a lexicographic compare is a
 * chronological one. A temp grant with no `end_date` is never expired —
 * there is no date to be past, and treating "unknown" as expired would
 * mute a live seat.
 */
export function isExpiredTempGrant(grant: ExpirableGrant, today: string): boolean {
  if (grant.type !== 'temp') return false;
  if (!grant.end_date) return false;
  return grant.end_date < today;
}

/**
 * True when Sync will actually clear this seat once its grant expires —
 * the precondition for withholding Remove and telling the ward no
 * request is needed.
 *
 * `sba-only` is the only Sync fix that deletes an SBA seat, and the
 * detector emits it only when the member has NO Kindoo user on the site
 * (`extension/src/content/kindoo/sync/detector.ts`, `seat && sbaBlock &&
 * !kuser`). A seat carrying other grants keeps the member present in
 * Kindoo, so no `sba-only` row is ever produced and the expired grant
 * sits in SBA indefinitely.
 *
 * On that shape the promise is false and the withheld Remove is the only
 * remedy there was, which would strand the row on every surface. So the
 * expiry treatment narrows to what it assumed: a seat whose only grant
 * is the expired one. Multi-grant seats keep the `Expired` badge — it is
 * true and worth saying — and keep Remove, because removing that grant
 * is real work someone has to request.
 */
export function syncWillClearSeat(seat: Pick<Seat, 'duplicate_grants'>): boolean {
  return (seat.duplicate_grants ?? []).length === 0;
}
