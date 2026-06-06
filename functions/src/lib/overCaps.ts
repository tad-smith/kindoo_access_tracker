// Pure over-cap detection. Reads counts + caps; returns the array
// persisted to `stake.last_over_caps_json` by `markRequestComplete`
// and `removeSeatOnRequestComplete` (spec §8).
//
// Home stake portion-cap = `stake_seat_cap - sum(home-site ward seats)`,
// clamped at 0. Foreign-site wards (those whose building points at a
// foreign Kindoo site) don't contribute to either side of the home-stake
// calculation — their seats come out of a foreign Kindoo site's pool,
// not ours. Per-ward over-cap is unaffected: each ward's `seat_cap`
// reflects what its own Kindoo site allotted it.
//
// T-42: a seat's home/foreign status reads `Seat.kindoo_site_id`
// directly when populated (`markRequestComplete` / migration stamp it);
// falls back to the seat's `scope` → ward site for legacy / pre-migration
// seats. A ward's site is no longer stored on the ward — it derives from
// the ward's building. The caller resolves `wardSites` (`ward_code →
// site`) and passes it in. A seat referencing an unknown ward classifies
// as `'unknown'` (its scope isn't in `wardSites`) and is excluded from
// `homeWardSeatsN`, preserving the pre-T-42 behaviour where unknown-ward
// seats didn't count against the home-stake portion-cap.
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
  /**
   * `ward_code → kindoo_site_id` (`null` = home), resolved by the caller
   * through each ward's building. Wards absent from this map (or mapping
   * to `null`) classify as home.
   */
  wardSites: ReadonlyMap<string, string | null>;
}): OverCapEntry[] {
  const { seats, wards, stakeSeatCap, wardSites } = opts;

  // INTENTIONAL DIVERGENCE FROM UI BARS: per-ward over-cap warnings
  // count primary scope only (`s.scope`). The UI's per-ward bars
  // (`AllSeatsPage.utilizationTotal`, `DashboardPage.countSeatsForScope`)
  // widen via `duplicate_scopes` for visibility, so a ward bar can
  // render "over cap" without firing `over_cap_warning`. The warning
  // represents actual Kindoo-license-pool consumption, which the
  // primary represents — a within-site (same-`kindoo_site_id`)
  // duplicate doesn't consume a second license.
  //
  // The ONE exception is the home-stake pool: a parallel-site stake
  // grant (a `scope === 'stake'` entry in `duplicate_grants`) on a
  // seat whose PRIMARY is a FOREIGN ward DOES consume a home stake
  // license that primary-scope counting can't see — the primary is
  // foreign (drawn from a foreign site's pool) and the stake count
  // reads primary scope only. That single missed home license is
  // folded into `stakeN` below. Within-site duplicates stay excluded;
  // so do stake duplicates on seats already counted in the home pool
  // (stake-primary → already in `stakeN`; home-ward-primary → already
  // in `homeWardSeatsN`). Net invariant: each member contributes at
  // most one unit to the home pool (`stakeN + homeWardSeatsN`). If you
  // change one side, change the other or document why. Spec §15.
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
      wards.filter((w) => (wardSites.get(w.ward_code) ?? null) == null).map((w) => w.ward_code),
    );
    const foreignWardCodes = new Set(
      wards.filter((w) => (wardSites.get(w.ward_code) ?? null) != null).map((w) => w.ward_code),
    );
    // Stake-primary seats (already counted by primary scope).
    let stakeN = counts.get('stake') ?? 0;
    let homeWardSeatsN = 0;
    for (const s of seats) {
      if (!s.scope || s.scope === 'stake') continue;
      const cls = seatSiteClassification(s, homeWardCodes, foreignWardCodes);
      if (cls === 'home') {
        homeWardSeatsN += 1;
        continue;
      }
      // Foreign-ward-primary seat carrying a parallel-site stake grant:
      // the stake duplicate consumes a home license invisible to primary
      // counting (primary is foreign, not 'stake'). Add exactly one. A
      // home-ward-primary seat with a stake duplicate is skipped here —
      // it's already in `homeWardSeatsN` — so each member contributes at
      // most one unit to the home pool.
      if (cls === 'foreign' && s.duplicate_grants.some((d) => d.scope === 'stake')) {
        stakeN += 1;
      }
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
