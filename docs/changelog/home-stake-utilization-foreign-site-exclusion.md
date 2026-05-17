# Home-stake utilization excludes foreign-site wards

**Shipped:** 2026-05-16
**Commits:** PR `feat/home-stake-utilization-excludes-foreign-site-wards`

## What shipped

Behaviour fix to the home-stake utilization / over-cap math: wards on a foreign Kindoo site (those with `kindoo_site_id !== null`) no longer contribute to either side of the home-stake calculation. Their seats are excluded from home-stake used counts, and their `seat_cap` is excluded from the home stake portion-cap. Per-ward over-cap and per-ward utilization are unchanged — each ward's bar still reflects its own seat_cap regardless of site.

## Why

Foreign-site wards draw against another Kindoo environment's seat pool, not the home stake's. Counting their seats / caps against `stake_seat_cap` was double-counting the home stake's budget and producing spurious over-cap signals once foreign-site wards had been configured (Kindoo Sites Phase 2 era).

## Spec / doc edits

- `docs/spec.md` §15 — added a "Home-stake utilization" subsection codifying the exclusion on both sides.
- `docs/spec.md` §244 — rewrote the cap-interaction rule: "home stake portion-cap = `stake_seat_cap - sum(home-site ward seats)`"; called out that foreign-site ward over-cap fires normally against its own cap.
- `docs/spec.md` §135 — Dashboard stake bar clarified as home-site only.
- `docs/spec.md` §137 — All Seats "Seat utilization" bar clarified as home-site only.
- `docs/spec.md` §51 — clarified `stake_seat_cap` is the home-site stake seat cap specifically.

## Code touched

- `functions/src/lib/overCaps.ts` — the canonical importer + callable + trigger calculation now filters `wardSeatsN` to home-site wards.
- `apps/web/src/lib/render/stakePool.ts` — `stakeAvailablePoolSize` skips wards with `kindoo_site_id != null`.
- `apps/web/src/features/manager/allSeats/AllSeatsPage.tsx` — the "All" scope full-width bar numerator filters out foreign-site ward seats.
- Tests extended in `functions/src/lib/overCaps.test.ts`, `apps/web/src/lib/render/stakePool.test.ts`, `apps/web/src/features/manager/allSeats/AllSeatsPage.test.tsx`, `apps/web/src/features/stake/RosterPage.test.tsx`, `apps/web/src/features/manager/dashboard/DashboardPage.test.tsx`, plus `functions/tests/markRequestComplete.test.ts` and `functions/tests/removeSeatOnRequestComplete.test.ts` for the inline-recompute call sites.

## Acceptance

Operator confirms that adding a foreign-site ward with its own seats no longer inflates home-stake utilization (numerator) nor shrinks home-stake portion-cap (denominator) on the Dashboard, All Seats, and Stake Roster surfaces.
