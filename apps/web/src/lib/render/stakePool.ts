// Display-facing stake pool size: stake_seat_cap minus what HOME-site
// wards have pre-reserved via their own seat_cap. Represents the stake
// presidency's headroom AFTER home-site wards have taken their
// reservations. Foreign-site wards (those with `kindoo_site_id` set)
// are excluded — their seats come out of a different Kindoo site's
// pool, not the home stake's, so they don't subtract from this
// denominator (spec §15, §244).
//
// This is NOT the importer's over-cap math — that uses the live ward
// seat counts (dynamic) per spec §7. Don't conflate.
//
// Wards with no seat_cap contribute 0 to the sum (don't poison the
// total). When stake_seat_cap is unset, returns null so callers can
// pass through to UtilizationBar's "(cap unset)" path. Negative results
// (sum of home-site ward caps exceeds stake cap — misconfiguration)
// flow through unchanged; UtilizationBar treats cap <= 0 as cap-unset.

import type { Ward } from '@kindoo/shared';

export function stakeAvailablePoolSize(
  stakeSeatCap: number | null | undefined,
  wards: ReadonlyArray<Ward>,
): number | null {
  if (typeof stakeSeatCap !== 'number') return null;
  let reserved = 0;
  for (const w of wards) {
    if (w.kindoo_site_id != null) continue;
    reserved += typeof w.seat_cap === 'number' ? w.seat_cap : 0;
  }
  return stakeSeatCap - reserved;
}
