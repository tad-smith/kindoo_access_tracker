# Phase 12.2 — Stake List page + Superadmin nav section

**Shipped:** 2026-05-19
**Commits:** see PR [#155](https://github.com/tad-smith/kindoo_access_tracker/pull/155) on `feat/12.2-stake-list`.

## What shipped

The second implementation atom of Phase 12 (multi-stake). 12.1 made the `isPlatformSuperadmin` claim operationally seedable; 12.2 ships the first reader of that claim — a Stake List page at `/superadmin/stakes` that lets a platform superadmin see every stake in the platform. Three lanes in this PR:

- **Rules expansion (`45708d3`).** `firestore/firestore.rules` `stakes/{stakeId}` `allow read` predicate gains `isPlatformSuperadmin()`. The same `isPlatformSuperadmin()` helper that already gates `platformSuperadmins` and `platformAuditLog` reads now also gates the per-stake parent doc. No subcollection widening: `wards`, `buildings`, `access`, `seats`, `requests`, `kindooManagers`, `kindooSites`, `auditLog`, and the calling-template collections all remain member-gated. A zero-role superadmin can list stakes but cannot read any stake's per-stake data without an explicit role on that stake. Three additive rules tests in `firestore/tests/stakes.test.ts`: superadmin positive (home stake), superadmin positive (cross-stake), authed non-superadmin negative companion.
- **SPA page + nav section (`ee85dce`).** New `/superadmin/stakes` route gated on `useRequireRole('platformSuperadmin')`. `apps/web/src/features/superadmin/StakeListPage.tsx` reads the top-level `stakes/` collection via a new `useStakes()` hook, sorts by `created_at` ascending, and renders each stake's `stake_name`, slug, formatted `created_at` (per-stake timezone), `setup_complete` pill, and a deep-link. The "Superadmin" nav section in `apps/web/src/components/layout/navModel.ts` carries the entry and is emitted only when `principal.isPlatformSuperadmin === true`. `holdsAnyRole` was tightened so the manager-superset no longer admits a `platformSuperadmin`-only gate — defence-in-depth, affects only the new route since every other call site passes `'manager' | 'stake' | 'bishopric'`.
- **Schema-doc reconcile (`f765a0c`).** Pre-existing drift between `docs/firebase-schema.md` §6 and `firestore/firestore.rules` for the `stakes/{stakeId}` predicate (the doc was missing `isSetupInProgressReadable(stakeId)`). Reconciled to mirror the live rule verbatim. Not introduced by 12.2, but the PR claimed §6 was updated; making good on that claim.

## Out of scope

- **No `createStake` callable / Create Stake form.** That is 12.3's deliverable. Until it ships, the Stake List page renders the single existing stake (`csnorth`).
- **No active-stake selector / multi-stake routing.** That is 12.4's deliverable. `landingPathFor()` deep-links every row to `/manager/dashboard` for v1; the comment in `StakeListPage.tsx` flags this as a 12.4 placeholder. At 12.2 only one stake exists so this is harmless; sequencing of 12.3 vs 12.4 is the operator's call (reviewer flagged the regression window between them).
- **No `defaultLandingFor()` change.** A zero-role superadmin still routes to `/manager/dashboard` post-sign-in. That is a 12.4-era concern (only matters once multi-stake routing is in play); `spec.md` §2.1 already names it as 12.4 work.

## Decisions made during the phase

- **Parent doc only, not subcollections.** The rules expansion is deliberately narrow: a zero-role superadmin can read the stake parent doc but cannot read any per-stake data without an explicit role on that stake. Listing stakes is a platform-level action; per-stake reads remain role-gated. If a future superadmin surface needs broader read access, it adds the claim to the specific subcollection's predicate, not as a blanket override.
- **`holdsAnyRole` tightened against the manager-superset shortcut.** A `useRequireRole('platformSuperadmin')` gate must not admit a non-superadmin manager. The previous behaviour leaked superset roles into specific gates; this is fine for `manager` / `stake` / `bishopric` (managers do hold those operationally) but wrong for `platformSuperadmin`, which is orthogonal. Now strict by claim.
- **Stake-table sort key is `created_at` ascending.** Stable order, smallest stake-list scale, and matches the operator-by-time mental model. No need for pagination or filter UI at this scale.

No new architecture D-numbers earned. The rules expansion follows the existing claim-gate pattern; the page follows the existing `features/<feature>/Page.tsx` + `hooks.ts` + `tests/` pattern; the nav-section change is data-driven via `navModel.ts`.

## Spec / doc edits in this phase

- `docs/firebase-schema.md` — §6 rules-summary mirrors the live `stakes/{stakeId}` predicate verbatim.
- `docs/spec.md` and `docs/navigation-redesign.md` — already described the Stake List page + Superadmin section accurately (written forward-looking for 12.2+12.3). No drift to reconcile.
- `docs/changelog/phase-12.2-stake-list.md` — this entry.

## Test footprint

- Rules: 3 new tests in `firestore/tests/stakes.test.ts` (28 in that file, 327/327 across 14 files).
- SPA: 7 new cases in `apps/web/src/features/superadmin/tests/StakeListPage.test.tsx` (loading, empty, populated, sort ascending, both pill states, per-stake-tz date format).
- Nav model: 4 new section-visibility cases in `apps/web/src/components/layout/Nav.test.tsx`.
- Role hook: 4 new cases in `apps/web/src/lib/useRequireRole.test.tsx` covering the strict `platformSuperadmin` predicate.
- Web suite total: 1141/1141 passing across 91 files.

## Reviewer notes worth carrying forward

- **`landingPathFor()` deep-link** hardcodes `/manager/dashboard` per row as a 12.4 placeholder. Reviewer flagged that this becomes a real UX regression in the **12.3-only window** — after `createStake` exists but before the active-stake selector ships, every non-`csnorth` row deep-links to the `csnorth` dashboard. Mitigation: sequence 12.4 immediately after 12.3, or pull the stake-aware piece of `landingPathFor` forward into 12.3. Decision deferred to the operator at 12.3 kickoff.

## Next

12.3 — `createStake` callable + Create Stake form. The callable is gated on `isPlatformSuperadmin`, slugs `stake_name` into a doc ID (collision-checked via transactional read), writes the parent doc per F19 (notably `bootstrap_admin_email` stored typed-form, not canonicalized), and emits a `platformAuditLog` `create_stake` row. The Stake List page grows a Create Stake form that calls the callable and re-renders. After 12.3 ships, the deep-link regression flagged above becomes user-visible; sequencing 12.4 immediately after is the recommended next step.
