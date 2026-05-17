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
// otherwise. Externally observable behaviour matches the pre-T-42 path
// — the field is just a denormalisation.
//
// A ward over-caps when `count > seat_cap` and `seat_cap > 0`.

import type { OverCapEntry, Seat, Ward } from '@kindoo/shared';

/** Resolve a seat's `kindoo_site_id`. T-42: prefer the seat's own
 *  field; fall back to ward-lookup. Stake-scope is always home. */
function seatSiteId(
  seat: Seat,
  homeWardCodes: Set<string>,
  foreignWardCodes: Set<string>,
): string | null {
  if (seat.kindoo_site_id !== undefined && seat.kindoo_site_id !== null) {
    return seat.kindoo_site_id;
  }
  if (seat.kindoo_site_id === null) return null;
  // Field absent — fall back to ward lookup.
  if (seat.scope === 'stake') return null;
  if (homeWardCodes.has(seat.scope)) return null;
  if (foreignWardCodes.has(seat.scope)) {
    // We can't return the exact id from here without a separate map,
    // but for the home/foreign question a non-null sentinel suffices.
    return '__foreign__';
  }
  // Unknown ward (legacy / drift) — treat as home so the seat still
  // counts somewhere; matches the pre-T-42 default behaviour.
  return null;
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
      const site = seatSiteId(s, homeWardCodes, foreignWardCodes);
      if (site === null) homeWardSeatsN += 1;
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
