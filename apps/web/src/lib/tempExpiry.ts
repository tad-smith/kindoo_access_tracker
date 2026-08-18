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

import { formatDateInStakeTz } from './datetime';
import type { GrantView } from './grants';

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
export function isExpiredTempGrant(
  grant: Pick<GrantView, 'type' | 'end_date'>,
  today: string,
): boolean {
  if (grant.type !== 'temp') return false;
  if (!grant.end_date) return false;
  return grant.end_date < today;
}
