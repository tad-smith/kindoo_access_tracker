// Pure sort logic for roster + All Seats surfaces. Used by:
//
//   - features/bishopric/RosterPage.tsx       (single-ward sort)
//   - features/stake/RosterPage.tsx            (stake-scope sort)
//   - features/stake/WardRostersPage.tsx       (any-ward sort)
//
// Within a single scope the ordering is type-banded:
//
//   1. auto    — by CALLING ORDER. Auto seats carry the matched
//                calling(s) in `seat.callings`; order = MIN across them
//                via the compiled churchwide `calling → order` table in
//                @kindoo/shared (`seatCallingOrder`). Lower order first.
//   2. manual  — by CALLING ORDER too, but manual seats store the
//                calling in the free-text `seat.reason` (convention:
//                `seat.callings` stays `[]` — spec §13). So the manual
//                band matches `seat.reason` against the same table via
//                `callingSortOrder` (single value, trimmed + case-
//                insensitive).
//   3. temp    — by `end_date` descending; soonest-expiring at the
//                bottom of the band (per the operator brief). Temps
//                carry a free-text reason, not a roster calling, so
//                calling order does NOT apply. Missing end_date sorts
//                to the very bottom (the request lifecycle requires
//                end_date for add_temp once the rules tightening lands;
//                a null in transit shouldn't crash the sort).
//
// In both the auto and manual bands a row that doesn't match the table
// ("unknown") sorts to the bottom of its band, ordered by `created_at`
// ascending (oldest first), then `member_name`. We no longer read the
// denormalised `seat.sort_order` — sort is derived from the seat's
// observed callings / reason. (Per `extension/docs/sync-design.md`
// Stage 1(a).)
//
// For All Seats (cross-scope), an outer sort runs first: Stake band,
// then ward bands alpha by ward_code; within each band the same
// type-banded ordering applies.

import { callingSortOrder, seatCallingOrder, type Seat } from '@kindoo/shared';

const TYPE_BAND: Record<Seat['type'], number> = {
  auto: 0,
  manual: 1,
  temp: 2,
};

function scopePrimaryRank(scope: string): number {
  // Stake first; everything else (ward codes) comes after, with the
  // alpha sort happening on the secondary key.
  return scope === 'stake' ? 0 : 1;
}

function nameKey(seat: Seat): string {
  return (seat.member_name || seat.member_email || '').toLowerCase();
}

/**
 * `created_at` in millis for the tiebreak among unknown-calling seats.
 * `created_at` is a structural `TimestampLike` (has `toMillis()`), but
 * we guard defensively: a missing / malformed value sorts to the very
 * bottom (POSITIVE_INFINITY) so a row in transit can't crash the sort.
 */
function createdAtMillis(seat: Seat): number {
  const ts = seat.created_at as { toMillis?: () => number } | null | undefined;
  if (ts && typeof ts.toMillis === 'function') {
    const ms = ts.toMillis();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Resolve a seat's calling order for the auto / manual bands:
 *   - auto:   MIN over `seat.callings` (auto seats record matched callings);
 *   - manual: `seat.reason` (manual seats store the calling there, with
 *             `callings: []` — spec §13);
 *   - other:  null (unknown).
 * `null` ("unknown") → bottom of the band.
 */
function seatBandOrder(seat: Seat): number | null {
  if (seat.type === 'auto') return seatCallingOrder(seat.callings);
  if (seat.type === 'manual') return seat.reason ? callingSortOrder(seat.reason) : null;
  return null;
}

/**
 * Comparator for the auto + manual bands. Both order by calling order
 * (resolved per `seatBandOrder` — `callings` for auto, `reason` for
 * manual), then fall through to a shared tiebreak. Order:
 *   1. calling order ascending; unknown (no match) → bottom of the band;
 *   2. `created_at` ascending (oldest first; missing → very bottom);
 *   3. `member_name` alpha.
 *
 * The `created_at` key only separates rows the calling order leaves
 * tied (two rows sharing the same calling, or two unknown rows).
 */
function callingOrderCompare(a: Seat, b: Seat): number {
  // null (unknown) → bottom of the band. POSITIVE_INFINITY so any
  // matched order wins.
  const aOrder = seatBandOrder(a) ?? Number.POSITIVE_INFINITY;
  const bOrder = seatBandOrder(b) ?? Number.POSITIVE_INFINITY;
  if (aOrder !== bOrder) return aOrder - bOrder;
  const aCreated = createdAtMillis(a);
  const bCreated = createdAtMillis(b);
  if (aCreated !== bCreated) return aCreated - bCreated;
  return nameKey(a).localeCompare(nameKey(b));
}

function tempCompare(a: Seat, b: Seat): number {
  // Soonest-expiring at the bottom of the band → descending end_date.
  // ISO YYYY-MM-DD lexical compare matches calendar order, so flip
  // the sign. Missing end_date sentinels sort to the very bottom (a
  // dated row beats an undated row in either direction); ties broken
  // by name.
  const aMissing = a.end_date === undefined || a.end_date === null;
  const bMissing = b.end_date === undefined || b.end_date === null;
  if (aMissing && !bMissing) return 1;
  if (!aMissing && bMissing) return -1;
  if (!aMissing && !bMissing) {
    const cmp = (b.end_date ?? '').localeCompare(a.end_date ?? '');
    if (cmp !== 0) return cmp;
  }
  return nameKey(a).localeCompare(nameKey(b));
}

/** Intra-band comparator dispatch once both seats share a type band. */
function withinBandCompare(a: Seat, b: Seat): number {
  if (a.type === 'temp') return tempCompare(a, b);
  // auto + manual share the calling-order comparator (different source
  // field, same ordering — see `seatBandOrder`).
  return callingOrderCompare(a, b);
}

/**
 * Sort one scope's seats: type-banded auto / manual / temp; intra-band
 * sort per the rules above. Pure — caller passes the slice already
 * filtered to a single scope.
 */
export function sortSeatsWithinScope(seats: readonly Seat[]): Seat[] {
  const sorted = [...seats];
  sorted.sort((a, b) => {
    const bandA = TYPE_BAND[a.type];
    const bandB = TYPE_BAND[b.type];
    if (bandA !== bandB) return bandA - bandB;
    return withinBandCompare(a, b);
  });
  return sorted;
}

/**
 * Sort cross-scope seats (manager All Seats). Primary sort by scope
 * (stake first; wards alpha by ward_code); secondary by the
 * within-scope rules above.
 */
export function sortSeatsAcrossScopes(seats: readonly Seat[]): Seat[] {
  const sorted = [...seats];
  sorted.sort((a, b) => {
    const rankA = scopePrimaryRank(a.scope);
    const rankB = scopePrimaryRank(b.scope);
    if (rankA !== rankB) return rankA - rankB;
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    const bandA = TYPE_BAND[a.type];
    const bandB = TYPE_BAND[b.type];
    if (bandA !== bandB) return bandA - bandB;
    return withinBandCompare(a, b);
  });
  return sorted;
}
