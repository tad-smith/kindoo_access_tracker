// Pure sort logic for roster + All Seats surfaces. Used by:
//
//   - features/bishopric/RosterPage.tsx       (single-ward sort)
//   - features/stake/RosterPage.tsx            (stake-scope sort)
//   - features/stake/WardRostersPage.tsx       (any-ward sort)
//   - features/manager/allSeats/AllSeatsPage.tsx
//
// Within a single scope the ordering is type-banded:
//
//   1. auto    — sorted by `sort_order` ascending; null `sort_order`
//                (orphan auto seats whose calling no longer matches a
//                template) lands at the bottom of the auto band.
//                Ties broken by `member_name` alpha.
//   2. manual  — alpha by `member_name`.
//   3. temp    — by `end_date` descending; soonest-expiring at the
//                bottom of the band (per the operator brief). Missing
//                end_date sorts to the very bottom (the request
//                lifecycle requires end_date for add_temp once the
//                rules tightening lands; a null in transit shouldn't
//                crash the sort).
//
// For All Seats (cross-scope), an outer sort runs first: Stake band,
// then ward bands alpha by ward_code; within each band the same
// type-banded ordering applies.

import type { Seat } from '@kindoo/shared';

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

function autoCompare(a: Seat, b: Seat): number {
  // null / missing sort_order → bottom of the auto band per operator
  // decision. Use POSITIVE_INFINITY so any number wins.
  const aOrder = typeof a.sort_order === 'number' ? a.sort_order : Number.POSITIVE_INFINITY;
  const bOrder = typeof b.sort_order === 'number' ? b.sort_order : Number.POSITIVE_INFINITY;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return nameKey(a).localeCompare(nameKey(b));
}

function manualCompare(a: Seat, b: Seat): number {
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
    if (a.type === 'auto' && b.type === 'auto') return autoCompare(a, b);
    if (a.type === 'manual' && b.type === 'manual') return manualCompare(a, b);
    return tempCompare(a, b);
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
    if (a.type === 'auto' && b.type === 'auto') return autoCompare(a, b);
    if (a.type === 'manual' && b.type === 'manual') return manualCompare(a, b);
    return tempCompare(a, b);
  });
  return sorted;
}
