// Compiled `calling → order` table for render-time seat sorting.
//
// Per `extension/docs/sync-design.md` "Grant-derived seat type (Stage 1
// + Stage 2)" part (a): the roster / All Seats sort no longer reads the
// denormalised `seat.sort_order`. Instead it computes order at render
// time from the seat's callings against this canonical, churchwide
// ordering table.
//
// The table is a fixed 72-entry hierarchy (stake callings 1–31, ward
// callings 32–72). The array index is the priority — lower index sorts
// first. The ordering is global: the calling hierarchy is churchwide,
// so there is no per-stake customisation (see Stage 1 open question #3).
//
// Matching is exact, trimmed, case-insensitive — NO wildcards. A
// calling that isn't in the table resolves to `null` ("unknown"), which
// the sort comparator banishes to the bottom of its type band.

/**
 * Canonical calling order. Index = priority (lower sorts first).
 * Treated as the source of truth; the lookup map is derived from it.
 */
const CALLING_ORDER: readonly string[] = [
  // ----- Stake callings (1–31) -----
  'Stake President',
  'Stake Presidency First Counselor',
  'Stake Presidency Second Counselor',
  'Stake Clerk',
  'Stake Executive Secretary',
  'Stake Assistant Executive Secretary',
  'Stake Assistant Clerk',
  'Stake Assistant Clerk--Membership',
  'Stake Assistant Clerk--Finance',
  'Stake High Councilor',
  'Stake Relief Society President',
  'Stake Relief Society First Counselor',
  'Stake Relief Society Second Counselor',
  'Stake Relief Society Secretary',
  'Stake Young Men President',
  'Stake Young Men First Counselor',
  'Stake Young Men Second Counselor',
  'Stake Young Men Secretary',
  'Stake Young Women President',
  'Stake Young Women First Counselor',
  'Stake Young Women Second Counselor',
  'Stake Young Women Secretary',
  'Stake Sunday School President',
  'Stake Sunday School First Counselor',
  'Stake Sunday School Second Counselor',
  'Stake Sunday School Secretary',
  'Stake Primary President',
  'Stake Primary First Counselor',
  'Stake Primary Second Counselor',
  'Stake Primary Secretary',
  'Stake Technology Specialist',
  // ----- Ward callings (32–72) -----
  'Bishop',
  'Bishopric First Counselor',
  'Bishopric Second Counselor',
  'Ward Executive Secretary',
  'Ward Assistant Executive Secretary',
  'Ward Clerk',
  'Ward Assistant Clerk',
  'Ward Assistant Clerk--Membership',
  'Ward Assistant Clerk--Finance',
  'Elders Quorum President',
  'Elders Quorum First Counselor',
  'Elders Quorum Second Counselor',
  'Elders Quorum Secretary',
  'Elders Quorum Assistant Secretary',
  'Relief Society President',
  'Relief Society First Counselor',
  'Relief Society Second Counselor',
  'Relief Society Secretary',
  'Aaronic Priesthood Advisors',
  'Aaronic Priesthood Specialist',
  'Young Women President',
  'Young Women First Counselor',
  'Young Women Second Counselor',
  'Young Women Secretary',
  'Young Women Specialist',
  'Young Women Class Adviser',
  'Sunday School President',
  'Sunday School First Counselor',
  'Sunday School Second Counselor',
  'Sunday School Secretary',
  'Primary President',
  'Primary First Counselor',
  'Primary Second Counselor',
  'Primary Secretary',
  'Ward Mission Leader',
  'Assistant Ward Mission Leader',
  'Ward Temple and Family History Leader',
  'Young Single Adult Adviser',
  'History Specialist',
  'Email Communication Specialist',
  'Technology Specialist',
];

/** Normalisation key: trimmed + lower-cased. Matching is exact on this key. */
function normalize(calling: string): string {
  return calling.trim().toLowerCase();
}

/** `normalized calling → priority index`. Built once from `CALLING_ORDER`. */
const ORDER_BY_CALLING: ReadonlyMap<string, number> = new Map(
  CALLING_ORDER.map((name, index) => [normalize(name), index]),
);

/**
 * Resolve a single calling's sort priority. Trimmed + case-insensitive
 * exact match against the canonical table. Returns the priority index
 * (lower sorts first) or `null` when the calling isn't in the table.
 */
export function callingSortOrder(calling: string): number | null {
  const order = ORDER_BY_CALLING.get(normalize(calling));
  return order === undefined ? null : order;
}

/**
 * Resolve a seat's sort priority from its callings: the MIN order across
 * every calling that matches the table. Returns `null` when the seat has
 * no callings, or none of its callings match (the comparator treats
 * `null` as "unknown" → bottom of the type band).
 */
export function seatCallingOrder(callings: readonly string[]): number | null {
  let min: number | null = null;
  for (const calling of callings) {
    const order = callingSortOrder(calling);
    if (order === null) continue;
    if (min === null || order < min) min = order;
  }
  return min;
}
