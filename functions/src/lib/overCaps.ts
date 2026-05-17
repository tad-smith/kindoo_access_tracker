// Pure over-cap detection. Reads counts + caps; returns the array
// the importer persists to `stake.last_over_caps_json`.
//
// Home stake portion-cap = `stake_seat_cap - sum(home-site ward seats)`,
// clamped at 0. Foreign-site wards (those with `kindoo_site_id` set)
// don't contribute to either side of the home-stake calculation — their
// seats come out of a foreign Kindoo site's pool, not ours. Per-ward
// over-cap is unaffected: each ward's `seat_cap` reflects what its own
// Kindoo site allotted it.
//
// T-42: a seat's home/foreign status reads `Seat.kindoo_site_id`
// directly when populated (importer / `markRequestComplete` / migration
// stamp it); falls back to the seat's `scope` → ward `kindoo_site_id`
// for legacy / pre-migration seats. The uniform missing-ward policy
// (skip-with-warning everywhere) means a seat that references an
// unknown ward never gets `kindoo_site_id` written — the ward-fallback
// here returns `undefined` for that case, and the caller excludes the
// seat from `homeWardSeatsN`. That preserves the pre-T-42 behaviour
// where unknown-ward seats didn't count against the home-stake
// portion-cap (they simply weren't in any ward's seat_cap bucket
// either).
//
// A ward over-caps when `count > seat_cap` and `seat_cap > 0`.

import type { OverCapEntry, Seat, Ward } from '@kindoo/shared';

/**
 * Classify a seat's site for the home-stake portion-cap calculation.
 * Returns one of:
 *   - `'home'`    — counts toward `homeWardSeatsN`.
 *   - `'foreign'` — does NOT count toward `homeWardSeatsN` (foreign
 *                   wards draw against another Kindoo site's pool).
 *   - `'unknown'` — seat references a ward that's not in the catalogue;
 *                   excluded from `homeWardSeatsN`. Matches pre-T-42
 *                   behaviour (an unknown-ward seat was never in any
 *                   ward's seat_cap bucket and never contributed to
 *                   home-stake math).
 *
 * Stake-scope seats are excluded by the caller before calling this.
 */
function seatSiteClassification(
  seat: Seat,
  homeWardCodes: Set<string>,
  foreignWardCodes: Set<string>,
): 'home' | 'foreign' | 'unknown' {
  if (seat.kindoo_site_id !== undefined) {
    return seat.kindoo_site_id === null ? 'home' : 'foreign';
  }
  // Field absent — fall back to ward lookup.
  if (homeWardCodes.has(seat.scope)) return 'home';
  if (foreignWardCodes.has(seat.scope)) return 'foreign';
  return 'unknown';
}

export function computeOverCaps(opts: {
  seats: Seat[];
  wards: Ward[];
  stakeSeatCap: number;
}): OverCapEntry[] {
  const { seats, wards, stakeSeatCap } = opts;

  const counts = new Map<string, number>();
  for (const s of seats) {
    if (!s.scope) continue;
    counts.set(s.scope, (counts.get(s.scope) ?? 0) + 1);
  }

  const out: OverCapEntry[] = [];
  for (const w of wards) {
    const cap = w.seat_cap;
    if (!Number.isFinite(cap) || cap <= 0) continue;
    const n = counts.get(w.ward_code) ?? 0;
    if (n > cap) {
      out.push({ pool: w.ward_code, count: n, cap, over_by: n - cap });
    }
  }

  if (Number.isFinite(stakeSeatCap) && stakeSeatCap > 0) {
    const homeWardCodes = new Set(
      wards.filter((w) => w.kindoo_site_id == null).map((w) => w.ward_code),
    );
    const foreignWardCodes = new Set(
      wards.filter((w) => w.kindoo_site_id != null).map((w) => w.ward_code),
    );
    const stakeN = counts.get('stake') ?? 0;
    let homeWardSeatsN = 0;
    for (const s of seats) {
      if (!s.scope || s.scope === 'stake') continue;
      const cls = seatSiteClassification(s, homeWardCodes, foreignWardCodes);
      if (cls === 'home') homeWardSeatsN += 1;
    }
    const portionCap = Math.max(0, stakeSeatCap - homeWardSeatsN);
    if (stakeN > portionCap) {
      out.push({
        pool: 'stake',
        count: stakeN,
        cap: portionCap,
        over_by: stakeN - portionCap,
      });
    }
  }

  return out;
}
