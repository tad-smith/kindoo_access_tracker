// Temp-window span math for the limited-app-access cap (spec §6.1). A
// limited user may only request temp seats whose window is at most
// `MAX_LIMITED_TEMP_WINDOW_DAYS` long. The Firestore rules enforce the
// same bound with a `duration.value(90, 'd')` compare; this module is
// the client-side and Cloud Function copy of that comparison, kept here
// so the three sites can't drift.
//
// All arithmetic runs on UTC midnights. Parsing `YYYY-MM-DD` with
// `new Date(str)` or `new Date(y, m, d)` anchors to the runtime's local
// zone, and a window that straddles a DST transition is then 89.96 or
// 90.04 days long — enough to flip the cap for a user in Denver but not
// for the same request evaluated in the rules. `Date.UTC` has no such
// transition, so every caller gets the same answer.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Longest temp window, in whole days, a limited user may request. */
export const MAX_LIMITED_TEMP_WINDOW_DAYS = 90;

/**
 * ISO `YYYY-MM-DD` → UTC-midnight millis; `NaN` when the string isn't
 * in ISO shape.
 *
 * The shape gate is the same regex `isoDateSchema` (zod) and the
 * Firestore rules apply, so any date arriving from a validated path
 * parses here. Out-of-range components inside an ISO-shaped string
 * (`2026-02-30`) roll over the way `Date.UTC` does; real calendar dates
 * are unaffected by that normalisation.
 */
function isoDateToUtcMs(iso: string): number {
  if (!ISO_DATE.test(iso)) return Number.NaN;
  const parts = iso.split('-');
  const year = Number.parseInt(parts[0] ?? '', 10);
  const month = Number.parseInt(parts[1] ?? '', 10);
  const day = Number.parseInt(parts[2] ?? '', 10);
  return Date.UTC(year, month - 1, day);
}

/**
 * Whole days from `startIso` to `endIso` (end minus start). Both args
 * are ISO `YYYY-MM-DD`. Same day → `0`; an end before the start → a
 * negative count; either arg unparseable → `NaN`.
 */
export function isoDateSpanDays(startIso: string, endIso: string): number {
  const start = isoDateToUtcMs(startIso);
  const end = isoDateToUtcMs(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return Number.NaN;
  // Both operands are UTC midnights, so the difference is an exact
  // multiple of a day — there is no stray DST hour to round away.
  return (end - start) / MS_PER_DAY;
}

/**
 * True when the window runs longer than the limited-access cap.
 * Mirrors the rules' `duration.value(90, 'd')` compare: exactly 90 days
 * is allowed, 91 is not.
 *
 * Unparseable input answers `false`. Rejecting a malformed date is the
 * job of `isoDateSchema` and the matching regex in the rules, both of
 * which run ahead of this cap; answering `true` here would surface
 * "window too long" for what is really "not a date". Nothing real slips
 * past — a genuine over-90-day window is two valid calendar dates, and
 * those always parse.
 */
export function exceedsLimitedTempWindow(startIso: string, endIso: string): boolean {
  const days = isoDateSpanDays(startIso, endIso);
  if (Number.isNaN(days)) return false;
  return days > MAX_LIMITED_TEMP_WINDOW_DAYS;
}
