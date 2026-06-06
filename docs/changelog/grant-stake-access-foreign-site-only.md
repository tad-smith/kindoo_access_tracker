# Give Access To Stake Buildings (foreign-site-only members)

**Shipped:** 2026-06-06
**Commits:** [PR #223](https://github.com/tad-smith/kindoo_access_tracker/pull/223) (`feat/grant-stake-access`)

## What shipped

A Kindoo Manager can now grant a foreign-site-only ward member access to the home-site stake buildings directly from the manager **All Seats** page, without waiting for that member (or their bishopric) to submit their own request. A per-member **"Give Access To Stake Buildings"** button opens `GrantStakeAccessDialog`, which submits an ordinary `add_manual` / `scope: 'stake'` request through the existing submit path. On completion the stake grant lands as a parallel-site `duplicate_grant` on the member's existing seat, and applying it from the extension on the home Kindoo environment invites the (foreign-only) member there — consuming an additional home-environment Kindoo license, which the dialog's red banner warns about up front.

## Why

Foreign-site-only members have a seat that only resolves to a foreign Kindoo environment; they can badge into foreign-site buildings but have no access to this stake's home buildings. The pre-existing path to give them home access was to wait for a stake-scope request the member can't initiate (they're not stake leadership) — leaving the manager with no direct lever. This affordance gives the manager that lever while keeping the audited request pipeline intact: it is not a direct seat write, it is a normal `add_manual` request that flows through `markRequestComplete` and the extension's Provision & Complete flow like any other.

The license-consumption cost is real and irreversible-feeling to operators, so the dialog states it verbatim ("Giving this user access to these buildings will consume an additional Kindoo license.") rather than burying it.

## The carve-outs this required

Two narrow exceptions, both scoped as tightly as possible so nothing else loosens:

- **Firestore rule (B-3 / T-36 carve-out).** The role-for-scope create gate (T-36, PR #52) blocks a manager-only user from creating any stake-scope request. The new third branch lets a manager create a stake-scope request **only** when `type == 'add_manual'`. Manager creation of stake-scope `add_temp`, `edit_auto`, `edit_manual`, `edit_temp`, and `remove` stays blocked exactly as before. T-36's tightening is not reverted — it is punctured with a single hole the size of this one flow.
- **Extension queue gate.** The "Provision & Complete" guard previously sent every add-onto-an-existing-seat to Reject-only (`isAdd && memberHasSeat`). It now permits a stake-scope `add_manual` for a member with no existing stake grant — `markRequestComplete` → `planAddMerge` appends a cross-scope `duplicate_grant` and succeeds. The gate is `applyableStakeAdd = type === 'add_manual' && scope === 'stake' && !memberHasStakeGrant`. It is **broader than the web button by design**: it also permits a home-ward member who has a seat but no stake grant (that member's existing home Kindoo user just gains the stake buildings), not only a foreign-site-only member. The web "Give Access To Stake Buildings" button is the foreign-site-only entry point, but other request-creation paths can produce the same `add_manual` / stake shape and `planAddMerge` handles them all. `memberHasStakeGrant` (derived in `QueuePanel` from the seat's primary + duplicate grants) is the backstop: if a stake grant already exists, the add can't apply cleanly and the card stays Reject-only.

## Why no new architecture D-number

The role-for-scope gate (B-3 / T-36) was never recorded as a numbered architecture decision — it lives in `spec.md` §6.1 and `firebase-schema.md` §6.1. The carve-out is a refinement of that non-D rule, documented in the same two places, so it earns no new D-number. The over-cap refinement below is likewise a refinement of existing §244 home-stake-cap semantics, not a new decision — no D-number.

## Post-review refinements (PR #223)

Three changes landed after the first review round:

- **Over-cap accounting — parallel-site stake grants count against the home stake pool (the behavioural one).** `computeOverCaps` (`functions/src/lib/overCaps.ts`) previously counted only primary-scope stake seats for `stakeN` (`counts.get('stake')`). That missed a real home Kindoo license: a member whose **primary** is a foreign ward and who carries a `scope: 'stake'` entry in `duplicate_grants[]` (exactly the grant this feature creates) consumes a home stake license the primary-scope count can't see — the primary classifies as foreign and is drawn from a foreign site's pool, not `'stake'`. `computeOverCaps` now folds one unit into `stakeN` for each such foreign-ward-primary seat carrying a stake duplicate. Double-counting is avoided: stake duplicates on seats already in the home pool are skipped (stake-primary is already in `stakeN`; home-ward-primary is already in `homeWardSeatsN`). The invariant — stated in the rewritten "INTENTIONAL DIVERGENCE" comment — is that **each member contributes at most one unit to `stakeN + homeWardSeatsN`**. Without this, a manager could grant stake access to N foreign-site members and silently blow past `stake_seat_cap` with no over-cap warning. The UI utilization bars still read primary scope only and don't reflect the fold; the over-cap warning does — a deliberate divergence (the warning tracks license consumption, the bars track visible per-scope load).
- **Extension carve-out is broader than first documented.** The earlier pass framed the extension's `applyableStakeAdd` carve-out around foreign-site-only members. Corrected here and in `spec.md` §15: the gate is `add_manual && scope: 'stake' && !memberHasStakeGrant`, which also permits a **home-ward member without a stake grant**. `planAddMerge` handles both shapes; the web "Give Access To Stake Buildings" button is just the foreign-site-only entry point, not the only way to produce the shape the extension applies.
- **Buildings-hydration gate on the dialog.** `GrantStakeAccessDialog` now renders a `LoadingSpinner` while the building catalogue hydrates (`buildingsResult.isLoading || data === undefined`) instead of briefly flashing the "No home-site buildings configured." empty state during the initial subscribe. Cosmetic; no spec change.

## What didn't change that you'd expect to

- **No new request type.** The flow reuses `add_manual` / `scope: 'stake'`. The whole point of the carve-out is that the existing pipeline already does the right thing; a bespoke type would have duplicated the lifecycle.
- **No client-side seat write.** The dialog submits a request and stops. Seat mutation happens server-side in `markRequestComplete` (`planAddMerge`), same as every other add.
- **The web Requests Queue duplicate-error chip (§209) is untouched.** That surface is read-only and was not modified by this PR; its "member already has a seat" chip still renders for stake-scope adds. The actionable gate lives in the extension, which is where the carve-out applies.
- **`planAddMerge` itself is unchanged.** It already stamped `kindoo_site_id` on appended duplicates (T-42 era); a stake-scope add merges to a home (`null`) parallel-site grant with no new server code.

## Spec / doc edits

- `docs/spec.md` §6.1 — added the manager `add_manual` stake carve-out to the "Who can submit" passage, plus a new paragraph describing the "Give Access To Stake Buildings" affordance, its visibility conditions, the foreign-site-only / no-stake-grant predicate, and `GrantStakeAccessDialog`.
- `docs/spec.md` §212 (All Seats) — noted the manager-only button as the page's one additional (non-seat-mutating) affordance.
- `docs/spec.md` §15 — added "Manager-granted stake access — parallel-site grant on completion" (the home `null`-site `duplicate_grant` append and the license-consumption mechanics); rewrote the extension queue panel's "Add for an existing user → Reject-only" bullet to document the stake-scope carve-out and the `memberHasStakeGrant` backstop. Post-review: corrected the carve-out bullet to state the gate is broader than the web button (also permits a home-ward member with no stake grant); updated "Cap interaction" (§244) and "Home-stake utilization" to describe `stakeN` folding parallel-site stake grants from foreign-ward-primary seats, with the at-most-one-unit invariant; softened the parallel-site-grant section's closing line from "the one case" to "an instance of" the permitted class.
- `docs/firebase-schema.md` §6 — added the third (`add_manual` + manager) branch to the embedded `requests.allow create` predicate listing.
- `docs/firebase-schema.md` §6.1 notes — added a "Manager `add_manual` stake carve-out" bullet under the role-for-scope gate note.
- `docs/firebase-schema.md` §4.7 — added a request-shape invariant bullet for the manager `add_manual` stake carve-out.
- `docs/firebase-schema.md` §4.1 — annotated the `last_over_caps_json` field comment to note the `pool: 'stake'` count now folds parallel-site stake grants (cross-ref spec §244). The persisted shape is unchanged.

## Code touched

- `apps/web/src/lib/foreignSiteOnly.ts` — new `isForeignSiteOnly` / `hasStakeScopeGrant` helpers (site resolution mirrors `siteLabelForGrant`).
- `apps/web/src/features/requests/components/GrantStakeAccessDialog.tsx` — new dialog: locked Stake scope, home-site building checklist, required reason, optional comment, `.kd-danger-banner` license warning. Post-review: gates the checklist on building-catalogue hydration with a `LoadingSpinner` so the empty state doesn't flash on first subscribe.
- `functions/src/lib/overCaps.ts` — post-review: `stakeN` folds one unit per foreign-ward-primary seat carrying a `scope: 'stake'` duplicate grant; rewritten "INTENTIONAL DIVERGENCE" comment states the at-most-one-unit-per-member home-pool invariant.
- `apps/web/src/features/requests/schemas.ts` — new `grantStakeAccessSchema`.
- `apps/web/src/features/manager/allSeats/AllSeatsPage.tsx` — per-seat (primary-row) manager affordance, gated on manager claim + `isForeignSiteOnly` + `!hasStakeScopeGrant`.
- `apps/web/src/styles/pages.css` — `.kd-danger-banner`.
- `firestore/firestore.rules` — manager `add_manual` stake carve-out on the requests-create predicate.
- `extension/src/panel/RequestCard.tsx` / `QueuePanel.tsx` — `memberHasStakeGrant` plumbing and the `applyableStakeAdd` carve-out on the provision guard; manifest bumped to 1.0.47. Post-review: the `RequestCard` carve-out comment was corrected to state the gate covers both foreign-site-only and home-ward members (not foreign-site-only alone).
- Tests extended across `apps/web/src/lib/foreignSiteOnly.test.ts`, `GrantStakeAccessDialog.test.tsx`, `AllSeatsPage.test.tsx`, `extension/src/panel/RequestCard.test.tsx` / `QueuePanel.test.tsx`, and `firestore/tests/requests.test.ts`.

## Acceptance

Manager sees the button only on a foreign-site-only member's All Seats row; the dialog locks scope to Stake, lists home-site buildings only, requires a reason and ≥1 building, and shows the license banner. Submitting creates an `add_manual` / stake request. In the extension queue, that request offers Provision & Complete (not Reject-only); completing it appends a home-site stake `duplicate_grant` and, on apply against the home Kindoo environment, invites the member and consumes a license.
