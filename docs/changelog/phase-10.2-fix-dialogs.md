# Phase 10.2 — Fix dialogs and UX issues

**Shipped:** 2026-04-29
**Commits:** see PR [#36](https://github.com/tad-smith/kindoo_access_tracker/pull/36) (6 commits on `phase-10.2-fix-dialogs`).

## What shipped

UX polish across the manager surface and New Request flow. 17 items grouped into five implementation batches: a single Radix-based `Dialog` primitive now backs every modal site (App Access add-grant, Configuration Wards / Buildings / Templates / Managers / Stake forms — both add and edit); layout was normalised left-aligned with per-page max-width helpers (`.kd-page-narrow` 600px, `.kd-page-medium` 800px, `.kd-page-wide` 1023px); audit log moved from "Show more" pagination to IntersectionObserver-driven infinite scroll on TanStack `useInfiniteQuery`; Access page picks between `<AccessTable>` and stacked cards at a 899px breakpoint; ward-scope New Request now auto-populates the building checkboxes from the ward's configured buildings; Configuration tabs renamed + reordered + Triggers tab removed; roster pill colours match the Apps Script source.

The phase shipped over 6 commits: five batched milestones plus one E2E follow-up.

### Batch 1 — tab cleanup + remove AllSeats summary cards (`7b852cd`)

Items 7, 11, 13. Configuration tab surface trimmed: `Triggers` tab deleted (was Phase 7 scaffolding for a feature that didn't survive review); the route enum in `apps/web/src/routes/_authed/manager/configuration.tsx` was narrowed to drop the value. Tabs reordered + renamed in `ConfigurationPage.tsx` to match Apps Script ordering (TABS array reorder; route enum order updated to mirror). AllSeats per-scope summary cards (`.kd-scope-summaries`) removed from `AllSeatsPage.tsx` and `pages.css` — the summary numbers were duplicated by the per-row table data and added vertical noise above the fold.

### Batch 2 — layout polish + roster pill colours + sheet hyperlink (`f7fb911`)

Items 8, 10, 14, 15, 16.

- **Sheet hyperlink (#8):** `ImportPage.tsx` line ~111 — the Sheet ID display now wraps in an anchor with `target="_blank" rel="noopener noreferrer"` so operators can click through.
- **Pill colours (#10):** `Badge.tsx` — `auto` / `manual` / `temp` variant colours now match Apps Script `Styles.html` lines 813–818 (auto: blue, manual: green, temp: amber).
- **Page max-widths (#14, #15, #16):** new `.kd-page-narrow` (600px) wraps `NewRequestPage.tsx`; `.kd-page-medium` (800px) wraps `ImportPage.tsx`; `.kd-page-wide` (1023px) wraps `ConfigurationPage.tsx`. All three are left-aligned, not centred — same posture as the existing AllSeats / AuditLog pages.

### Batch 3 — modal dialogs replace inline forms (`cd43743`)

Items 1, 2, 17. The whole reason for this phase. A single Radix-based `Dialog` primitive (already established in `apps/web/src/components/ui/`) now backs:

- **App Access (#1):** `AccessPage.tsx` — the add-grant form moved out of the page body into a modal triggered by a button placed to the right of the count, so the page header now reads as "App Access · N grants · [Add]" instead of stacking a long form above the table.
- **Configuration tabs (#2):** all five remaining tabs (Wards, Buildings, Templates, Managers, Stake) get a section-header Add button (`.kd-config-section-header`) opening a per-feature form dialog. Replaces the always-visible inline forms.
- **Edit dialogs (#17):** WardsTab + BuildingsTab grew an Edit row button per item; their per-feature `WardFormDialog` / `BuildingFormDialog` use a discriminated `mode: 'closed' | 'add' | { kind: 'edit', ... }` so the same dialog component handles both flows.

The shared cross-cutting decisions in this batch — single Dialog primitive reused across 7+ modal sites, shared `.kd-config-section-header` styling, shared `.kd-page-*` width helpers — keep the surface coherent for future operators landing similar polish.

### Batch 4 — Access page table-vs-card responsive view (`725105c`)

Item 5. `AccessPage.tsx` now renders `<AccessTable>` at viewport ≥899px and stacked cards below. The 899px breakpoint matches the Apps Script app's existing breakpoint exactly — operator chose this over `navigation-redesign.md`'s 1024px desktop boundary because the Apps Script number was already calibrated against the real content width and changing it for one page would have inconsistencies vs. the eventual Phase 10.1 redesign anyway. `pages.css` carries the media-query split.

### Batch 5 — audit infinite scroll + ward-scope auto-building (`28256c3`)

Items 3, 4, 6, 9.

- **Audit infinite scroll (#6):** `auditLog/hooks.ts` ports `useAuditLogInfinite` onto TanStack's `useInfiniteQuery`. `AuditLogPage.tsx` mounts an IntersectionObserver sentinel with `rootMargin: 300px` so the next page fetches a screen ahead of the user. `PAGE_SIZE` bumped from 25 to 50 — at 50 rows the observer fires noticeably less often on a fast scroll, and the Firestore read cost scales with totalrows-fetched not pages-fetched.
- **Ward-scope auto-building (#9):** `NewRequestForm.tsx` gained a new `wards` prop and an effect that auto-populates the building checkboxes from the selected ward's configured buildings on ward selection. `NewRequestPage.tsx` passes `wards` down. The selected list is still editable — auto-population is a sensible default, not a lock.
- **Queue card (#3):** `QueuePage.tsx` + `pages.css` — new `.kd-queue-card` styling; the page now uses the `.kd-page-medium` 800px wrapper.
- **Last-manager UI guard (#4):** `ConfigurationPage.tsx` ManagersTab — the Remove button is `disabled={isLastManager}` with a native `title` tooltip explaining why. Operator chose UI-only over server-side rule enforcement because a manager removing the last manager still leaves the system recoverable via the bootstrap-admin path; tightening this further would risk lockout in legitimate edge cases (e.g., re-adding the same canonical with a corrected display name).
- **Test-only change (#12):** `NewRequestPage.test.tsx` updated to match the new `wards` prop wiring; no production change.

### E2E follow-up (`6515b8b`)

The bishopric-lifecycle Playwright spec under `e2e/tests/` had been clicking a building checkbox to select it. After #9 the matching ward's building is pre-ticked automatically; the click was un-ticking it. Replaced the click with a `toBeChecked()` assertion. No production code change.

## Deviations from the pre-phase brief

Three operator-decided departures from the original Phase 10.2 brief, plus one discovered side-effect that's worth recording even though it isn't a deviation per se.

- **Breakpoint 899px, not 1024px** (#5). The original brief pointed at `navigation-redesign.md`'s 1024px desktop boundary. Operator chose Apps Script's existing 899px to keep the table-vs-card cutover consistent with the still-running production app; consistency-with-current beat consistency-with-future-redesign.
- **Server-side last-manager enforcement dropped** (#4). UI-only `disabled` + tooltip. Rationale: a stuck-out admin can still be re-added via the bootstrap-admin path, so the cost of accidental lockout from a tighter rule outweighed the marginal protection. Revisit if a real lockout is observed.
- **PAGE_SIZE 25 → 50** for audit infinite scroll (#6). The brief didn't specify; web-engineer chose 50 because at 50 rows the IntersectionObserver fires noticeably less often during a fast scroll and the Firestore read cost scales with rows, not pages.
- **AccessPage importer-source badge moved from `auto` to `default`** (discovered side-effect, not in the brief). #10 changed `auto` from grey to blue across all roster surfaces. The Access page's "this row came from the importer" badge had been using `variant="auto"` precisely because it was grey-on-white and matched Apps Script. Switching `auto` to blue would have made the importer-source row read as "auto-grant" everywhere — wrong semantic. The badge was switched to `variant="default"` (still grey) so the importer-source visual stays grey-on-white and matches Apps Script. Recorded as the load-bearing reason `auto` and `default` now both render grey on the Access page.

## Decisions made during the phase

- **Single Radix-based Dialog primitive** for every modal site in this phase. App Access add-grant + Configuration Wards / Buildings / Templates / Managers / Stake forms (both add and edit) all reuse the same `Dialog` component from `apps/web/src/components/ui/`. Keeps the modal-close, focus-trap, and overlay behaviour consistent — a divergent dialog stack was the alternative and would have multiplied keyboard-trap bugs across seven sites.
- **`.kd-page-narrow` / `.kd-page-medium` / `.kd-page-wide` CSS helpers.** Three named max-widths (600 / 800 / 1023 px), all left-aligned, applied per-page. Rationale: each manager page has a content density that wants a different cap; one global content-width was wrong for both the New Request form (cramped at 1023, nice at 600) and Configuration (the table grids want all 1023). Three named helpers beat per-page magic numbers.
- **`.kd-config-section-header`** for the per-tab Add buttons in Configuration. The button-position-and-styling pattern is shared across all five tabs; the helper class gives every tab the same visual rhythm without inline styles.
- **AccessPage importer-source semantic preserved** by switching that one badge from `variant="auto"` to `variant="default"` after #10 redefined `auto` as blue. See deviations §4 above. The "grey-on-white means this is from the importer" affordance is load-bearing for operators reviewing the Access page; preserving it across the colour-system change is the minimum viable fix.

No new architecture D-numbers earned. The Dialog primitive, the `.kd-page-*` helpers, and the `.kd-config-section-header` helper are all CSS / component-level conventions that don't rise to architecture decisions; the pill-colour change matches an already-canonical Apps Script source (`Styles.html` lines 813–818); the breakpoint and PAGE_SIZE picks are tuning, not architecture.

## Spec / doc edits in this phase

`docs/spec.md` is **not** touched. Phase 10.2 polishes the Firebase-only manager UI; Apps Script reality (which `spec.md` still describes until Phase 11 cutover) is unchanged.

- `docs/architecture.md` — unchanged.
- `docs/firebase-migration.md` — new Phase 10.2 entry slotted between Phase 10.1 and Phase 10.5, marked `[DONE]` and pointing here.
- `docs/firebase-schema.md` — unchanged. No schema or rule changes; this phase is pure UI / state-shape polish.
- `docs/changelog/phase-10.2-fix-dialogs.md` — this entry.
- `docs/TASKS.md` — no new entries. None of the 17 items spawned cross-workspace follow-ups.

## Test footprint

- 491 unit / component tests passing on `6515b8b` (was 470 baseline before Phase 10.2).
- 53 Playwright specs passing on `6515b8b` (the pre-existing bishopric-lifecycle spec was rewritten to use `toBeChecked()` after #9 changed the auto-tick behaviour; no new specs added).
- All green on the final commit.

## Areas worth focused operator review during staging tests

Web-engineer flagged eight items where the visual or interaction change is most likely to surface "did this regress?" on first look:

- **App Access add-grant modal (#1).** Verify the Add button sits to the right of the count, opens a modal on click, dismisses on Escape and overlay click, and traps focus.
- **Configuration tab modals + Edit flows (#2, #17).** All five tabs: Add button placement, dialog open/close, Edit row button only on Wards + Buildings (not Templates / Managers / Stake at this point), per-feature `mode` discriminator behaves correctly when reopening from `edit` to `add` to `closed`.
- **Access page responsive cutover at 899px (#5).** Resize the viewport across the breakpoint; table appears at ≥899, cards below. No flash on initial load.
- **Audit infinite scroll (#6).** Scroll fast on the audit log; the next page should load before the user hits the visible end. PAGE_SIZE 50 is the new fetch unit.
- **Ward-scope auto-building (#9).** Pick a ward in New Request; building checkboxes for that ward should pre-tick. Editable after auto-population.
- **Roster pill colours (#10).** Auto = blue, manual = green, temp = amber. Cross-check against Apps Script.
- **Configuration tab order + Triggers removal (#7, #11).** Tabs ordered to match Apps Script; Triggers tab gone; URL `?tab=triggers` should redirect / 404 cleanly.
- **AccessPage importer-source badge.** Should still render grey-on-white (variant `default`) — distinguishes "from importer" from the now-blue `auto` semantic. Verify the visual semantic still reads correctly.

## Deferred / follow-ups

None requiring cross-workspace coordination — no new TASKS.md entries surfaced from this phase. The deferred items below are forward-looking only:

- **Server-side last-manager enforcement** (deviation §2). Revisit if a real lockout is observed at scale.
- **Edit dialogs on Templates / Managers / Stake** (extension of #17). Wards + Buildings got Edit row buttons; the other three Configuration tabs still rely on delete-and-re-add. Add when operator surfaces a need.

## Next

No "next phase" gating from Phase 10.2 — it's a polish phase that doesn't change the surface contract for any later phase. Phase 10.5 (FCM push) and Phase 11 (data migration + cutover) remain the open lanes; both are independent of this phase's UI changes.
