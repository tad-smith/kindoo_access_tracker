// Pure over-cap detection. Reads counts + caps; returns the array
// the importer persists to `stake.last_over_caps_json`.
//
// Stake portion-cap = `stake_seat_cap - sum(ward seats)`, clamped at 0.
// A ward over-caps when `count > seat_cap` and `seat_cap > 0`.

import type { OverCapEntry, Seat, Ward } from '@kindoo/shared';

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
    const stakeN = counts.get('stake') ?? 0;
    const wardSeatsN = seats.length - stakeN;
    const portionCap = Math.max(0, stakeSeatCap - wardSeatsN);
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
