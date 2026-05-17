# Phase 2 — Kindoo Sites form filtering + roster labels

**Shipped:** 2026-05-16
**Commits:** see PR [#125](https://github.com/tad-smith/kindoo_access_tracker/pull/125) on branch `feat/kindoo-sites-phase-2-form-filtering`.

(Filename note: this is Phase 2 of the Kindoo Sites feature [spec §15]; not to be confused with the Firebase migration's Phase 2 — see `phase-2-auth-and-claims.md`. The Kindoo Sites rollout is a four-phase plan inside §15, not a top-level migration phase.)

## What shipped

Both the New Request form and the Edit Seat dialog filter their building checklists by the scope's Kindoo site so a manager editing or submitting against a foreign-site ward sees only that site's buildings (and vice versa). Roster pages render a small foreign-site badge alongside any ward seat whose ward sits on a non-home Kindoo site, so the operator can spot cross-site seats at a glance. Pre-checked defaults are clamped to the visible (site-filtered) set so a legacy seat whose `building_names` overlap a hidden building doesn't silently ship that building back on submit.

The phase also ratifies the universal `building_names ≥ 1` requirement on every `add_*` and `edit_*` request — both client-side (form schema + disabled Submit button) and rule-side. This closes a legacy gap where ward-scope submits used to be permitted to ship `building_names: []` and let a Mark Complete default fill in the ward's own building. The data model has expected explicit buildings on every request for a while now; the spec and rules just hadn't caught up.

## Deviations from the pre-phase spec

- **Universal `building_names ≥ 1` on requests** — Pre-phase §5.1 said "buildings (stake scope only — at least one required client-side and rule-side). Bishopric submits leave `building_names` empty and let the ward default kick in at completion time." Operator decision 2026-05-16: that path is dead. Every `add_*` / `edit_*` request now carries the buildings the requester chose. Spec: §5.1, §5.3 (Mark Complete pre-tick description), §6 (Submit step).
- **Submit button on Edit Seat dialog disabled when no buildings checked** — mirrors the existing gate on the New Request form for UX consistency. Schema-level rejection is still the second defense. No spec change (this is form-UX wording).

## Decisions made during the phase

- **Stake-scope New Request shows home-site buildings only.** Operator decision 2 (recorded inline in spec §15). The alternative — render every building including foreign — would let a stake-scope submit ship cross-site buildings that the orchestrator would then reject at provision time. Filtering at the form keeps the submit shape valid up-front. Recorded in spec §15.
- **Pre-checked defaults clamped to the visible (site-filtered) set.** A legacy ward whose `building_name` field disagrees with its `kindoo_site_id` (mid-migration state) would otherwise pre-check an invisible-and-uncheckable building, which would then ship back on submit with no UX surface for the user. Clamp drops anything outside the visible set silently; user can only check / uncheck what they can see. Same clamp applies in EditSeatDialog (where seat.building_names from prior site assignments would also be invisible).
- **Empty-state direction to Configuration.** When the site filter narrows the catalogue to zero (foreign-site ward whose foreign building hasn't been configured yet) both forms render an explicit message pointing the manager at Configuration rather than presenting an empty checklist + an unexplained disabled Submit.
- **Universal `building_names ≥ 1` is the new contract** (this dispatch). Wards originally couldn't request buildings — members got the ward's building automatically via Mark Complete defaults. That changed a while ago; the data model now expects explicit buildings on every request. This phase closes the loop on the spec / rules that still described the legacy behavior.

## Spec / doc edits in this phase

- `docs/spec.md` — §5.1 (New Kindoo Request form) rewritten to require ≥ 1 building regardless of scope; removed the "leave `building_names` empty" sentence and the default-on-completion path. §5.3 (Requests Queue → Mark Complete dialog) reworded — the pre-tick now comes from the request's own `building_names`, not a ward-default fallback. §6 (Submit step) reworded — rule now enforces non-empty `building_names` for every `add_*` and `edit_*` type. §15 Phase 2 entry covers the site filter, the clamp behavior, and the empty-state direction.
- `firestore/firestore.rules` — `requests` create predicate tightened. The old `scope != 'stake'` exemption is removed; the rule now requires `building_names.size() > 0` on every type except `remove`. Inline comment documents the operator decision.
- `docs/changelog/phase-2-kindoo-sites.md` — this entry.

## Files touched

- `apps/web/src/features/requests/components/NewRequestForm.tsx` — site filter applied via `filterBuildingsBySite` + `siteIdForScope`; pre-checked defaults clamped to the visible set; Submit disabled when `watchedBuildings.length === 0`.
- `apps/web/src/features/requests/components/EditSeatDialog.tsx` — same site filter + clamp; Submit disabled when `watchedBuildings.length === 0` (matches NewRequestForm).
- `apps/web/src/features/requests/schemas.ts` — `newRequestSchema.building_names` requires `>= 1` for every scope (was: stake-scope only via cross-field refinement); `editSeatSchema.building_names` already required `>= 1`.
- Roster pages — small foreign-site badge alongside ward seats whose ward sits on a non-home Kindoo site.
- `firestore/firestore.rules` — tightened `requests` create predicate; see above.
- Tests:
  - `apps/web/src/features/requests/tests/NewRequestForm.test.tsx` — flipped the bishopric-empty-buildings test to assert disabled Submit (was: asserted submission with empty `building_names`); added site-filter coverage; added Risk-2 clamp test; added stake-scope zero-buildings rejection test.
  - `apps/web/src/features/requests/components/EditSeatDialog.test.tsx` — site-filter coverage (foreign / home / clamp / empty-state); flipped no-buildings test to assert disabled Submit.
  - `apps/web/src/features/requests/tests/schemas.test.ts` — ward-scope zero-buildings schema rejection.
  - `firestore/tests/requests.test.ts` — ward-scope empty-buildings denied tests for every `add_*` and `edit_*` type; ward-scope happy-path tests reconfirmed.

## Deferred

- **Phase 3 — extension orchestrator EID validation.** Phase 3 of §15 lands on the companion Chrome extension; the orchestrator's Provision & Complete will validate that the active Kindoo session's EID matches the building's `kindoo_site_id` before writing. Out of scope here.
- **Backfill / data migration.** Existing requests with empty `building_names` (rare/none in prod per operator) stay as-is. The universal rule kicks in for new requests only.

## Next

Phase 3 of §15 (extension orchestrator enforcement) is the next §15 lane. Backend / functions surface is unchanged in this phase — the form + rule tightening lives entirely in web + rules.
