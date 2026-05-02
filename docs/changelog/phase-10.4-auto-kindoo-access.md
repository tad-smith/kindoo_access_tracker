# Phase 10.4 — Auto Kindoo Access overhaul

**Shipped:** 2026-04-29
**Commits:** see PR [#38](https://github.com/tad-smith/kindoo_access_tracker/pull/38) (6 commits on `phase-10.4-auto-kindoo-access`).

## What shipped

A new `auto_kindoo_access: boolean` field on calling-template docs decouples "auto-seat creation" from "matched-a-template." The importer's seat-creation gate is now `template-match AND auto_kindoo_access === true`; the access-row gate (`give_app_access`) is unchanged. The Auto Ward Callings + Auto Stake Callings tabs are rebuilt as table views with three columns (Calling Name, Auto Kindoo Access, Can Request Access) and drag-to-reorder (mouse) / tap-and-hold + arrows (touch). The legacy `give_app_access` Firestore field is renamed to "Can Request Access" in the UI only — the field name is preserved on disk.

The phase shipped over six commits: one shared-schema prep, one backend importer-gate, one combined UI rebuild + drag-and-drop, one tests batch, one operator runbook, and one E2E locator fix.

### Sub-change A — schema (`396ba44`)

`packages/shared/` — `auto_kindoo_access: boolean` added as a required field on the `CallingTemplate` Zod schema, the form schema, and the TypeScript type. No backfill: absent on read is treated as `false` everywhere. Pure schema work; no behaviour change in this commit.

### Sub-change B — importer gate (`e5f4cd9`)

Backend-engineer's lane.

- **Filter point.** `functions/src/lib/diff.ts` filters at the `groups` build step: only callings whose template carries `auto_kindoo_access === true` populate `g.callingsByScope`. The access-row gate (`give_app_access`) is unchanged.
- **Defensive read.** `functions/src/Importer.ts` `loadCallingTemplates` reads `data.auto_kindoo_access === true` (mirrors the `give_app_access` defensive pattern — coerces non-bool / missing to false rather than trusting Zod alone).
- **Parser surface.** `functions/src/lib/parser.ts` `TemplateRow` and `ParsedRow` now carry `auto_kindoo_access` / `autoKindooAccess` through the import pipeline.
- **Diff-delete reuse.** No new branch was added to handle "calling's template now `auto_kindoo_access=false`." The existing diff-delete branch already handles it: dropping the calling out of `g.callingsByScope` walks the same path as removing it from the template tab.
- **Audit trigger.** Handles `auto_kindoo_access` for free — the parameterized `auditTrigger` writes the full doc shape and never had a field allowlist.
- **Tests.** 4-case flag-combo matrix (both off / both on / each one alone) + stale-deletion (template flips from true to false → existing auto seat deleted on next import) + mixed-callings (one gated calling alongside one ungated calling on the same person) + sort_order MIN invariant preserved across the new filter + idempotency on re-run.

### Sub-changes C + D — table rebuild + drag-and-drop (`0830229`)

Both UI sub-changes ship together because the new table is the surface that drag-and-drop attaches to.

- **`CallingTemplatesTable.tsx` (new).** Three columns: Calling Name, Auto Kindoo Access, Can Request Access. Per-row Edit / Delete buttons + grip handle + arrow buttons + Done pill (touch reorder mode). Renders `<table>` at all viewport widths with the Calling Name column ellipsizing at narrow widths — no card-stack break.
- **`CallingTemplateFormDialog.tsx` (extracted).** Single modal, mode-driven (`closed` / `add` / `edit`). Add → "Add Calling"; Edit → "Save Changes". `calling_name` is read-only when editing (matches the Wards `ward_code` constraint — calling name is the doc id, so renaming = delete + re-add).
- **Drag-and-drop library.** `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` added to `apps/web/package.json` (3 packages). PointerSensor + KeyboardSensor only — no TouchSensor.
- **`useLongPress` hook (new).** 500ms threshold, 10px scroll-vs-hold discrimination, suppresses iOS context menu via `preventDefault()` and `-webkit-touch-callout: none`.
- **Mouse vs touch branching.** Routes on `pointerType` (the input that started the gesture), not viewport width. Mouse → drag the grip handle; touch → tap-and-hold opens the arrow-button reorder mode with a Done pill to dismiss.
- **Grip handle visibility.** Gated by `@media (hover: hover) and (pointer: fine)` — touch-only devices never see the handle and fall through to long-press.
- **Reorder dismissal.** Tap-elsewhere or tap the small "Done" pill. No inactivity timer.
- **Persistence.** Reorder via Firestore `writeBatch` of `{ref, sheet_order}` for changed rows only. Optimistic UI with snapshot rollback on write failure. Add-at-end (`sheet_order = max + 1`); delete-with-resequence (contiguous `1..N-1`).

### Tests (`8916f0e`)

`useLongPress` hook + reorder/resequence planner unit tests + a table-flow component test. Three pure planners (`nextSheetOrder`, `planReorderWrites`, `planDeleteResequenceWrites`) were extracted from the in-hook batch builders and exported for unit testability — a deviation from the original plan that turned out cleaner. The in-hook builders compose them.

### Post-deploy operator runbook (`f9e4ff5`)

`docs/runbooks/post-10.4-deploy.md` (written by web-engineer, ships in this PR). Audience: the operator at manager level. Sections: why-this-exists, pre-flight (staging rehearsal first), step-by-step (review each template; tick Auto Kindoo Access where current behaviour should be preserved), trigger import, expected behaviour, verify checklist, two rollback paths (cheap re-tick + re-import; heavy PITR), sign-off checklist. Captures the "tick everything to preserve current behaviour" safest-mass-action tip.

### E2E locator fix (`3861aec`)

`getByLabel('Auto Kindoo Access')` substring-matched the per-row `aria-label`s on the table (e.g. `"Auto Kindoo Access — Bishop"`) and tripped Playwright strict-mode. Scoped the assertion to `getByTestId('config-ward-callings-form')` with `{ exact: true }`. Single re-push, green.

## Decisions made during the phase

Operator-decided departures from the original brief, plus discoveries during implementation.

- **`@dnd-kit` chosen** as the drag library over HTML5 native or alternatives (better keyboard accessibility, less DOM acrobatics, three-package footprint acceptable).
- **"Auto Callings" tab name preserved.** The rename happened in Phase 10.2 #11; not revisited here.
- **Mobile rendering: same `<table>` at all sizes.** Calling Name ellipsizes at narrow widths rather than reflowing into a card stack. Simpler surface; consistent semantics across viewports.
- **Reorder dismissal: tap-elsewhere + Done pill.** No inactivity timer.
- **Grip handle gated by `@media (hover: hover) and (pointer: fine)`.** Touch-only devices never see the affordance — they take the long-press path.
- **Pure planners exported.** `nextSheetOrder`, `planReorderWrites`, `planDeleteResequenceWrites` extracted from in-hook batch builders for unit testability. Cleaner than the originally planned in-hook-only structure.
- **`calling_name` read-only on edit.** Matches the `ward_code` constraint on Wards: the field is the doc id, so the only path to "rename" is delete + re-add.
- **No backfill.** Existing calling-template docs have no `auto_kindoo_access` field. The defensive read coerces missing → false, and the operator runbook walks the manager through ticking the templates that should preserve current behaviour before triggering the next import.

## Cross-cutting decisions

- **Single Radix `<Dialog>` primitive reused** — continues the Phase 10.2 modal-dialog convention; no new primitive introduced.
- **Mouse vs touch on `pointerType`, not viewport.** A laptop with a touchscreen routes correctly per the input that started the gesture rather than per viewport size.
- **Reorder writes are change-only.** `planReorderWrites` emits one batch entry per row whose `sheet_order` actually changed, not for every row. Keeps audit-row volume proportional to the actual change.
- **`useLongPress` closure-ordering bug caught by unit tests.** During implementation, `cancel()` was being called *after* setting `startRef.current`, but `cancel()` nulls `startRef.current`. Reordered to `cancel(); startRef.current = ...; setTimeout(...)`. No production exposure — caught in the unit-test layer before merge.

No new architecture D-numbers earned. The schema addition (`auto_kindoo_access`) is field-level; the importer gate is a stricter version of an existing predicate; the drag-and-drop UI is component-level.

## Spec / doc edits in this phase

`docs/spec.md` is **not** touched. Phase 10.4 polishes the Firebase-only manager UI and adds one field to the Firebase calling-template schema; Apps Script reality (which `spec.md` still describes until Phase 11 cutover) is unchanged.

- `docs/architecture.md` — unchanged.
- `docs/firebase-migration.md` — new Phase 10.4 entry slotted between Phase 10.3 and Phase 10.5, marked `[DONE]` and pointing here. Carries the destructive-on-first-import warning + runbook pointer.
- `docs/firebase-schema.md` — **not** updated in this phase. The new `auto_kindoo_access` field on `CallingTemplate` is not yet reflected in the schema reference. Same follow-up bucket as the Phase 10.3 schema-doc-sync entry in TASKS.md.
- `docs/data-model.md` — **not** updated. Same reason.
- `docs/runbooks/post-10.4-deploy.md` — operator runbook (web-engineer wrote it; ships in this PR).
- `docs/changelog/phase-10.4-auto-kindoo-access.md` — this entry.

## Test footprint

- **Web:** 551 tests passed (was 532 baseline; +19 covering calling-templates flow, `useLongPress`, and reorder/resequence planners).
- **Shared:** 72 tests (`callingTemplate` schema additions).
- **E2E:** 55 passed (2 new specs: table render + Edit modal flow).
- **Backend (functions + rules):** all green; 4-case flag-combo matrix + stale-deletion + mixed-callings + `sort_order` MIN invariant + idempotency.

## Areas worth focused operator review during staging tests

- **Drag round-trip via real mouse on the Auto Callings tabs.** Reorder a row up/down; refresh; confirm persistence.
- **Add-at-end semantics.** Add a row, verify `sheet_order = max + 1`.
- **Delete-with-resequence.** Delete a row, verify remaining rows re-sequence to contiguous `1..N-1`.
- **Tap-and-hold on iOS Safari (real device, not emulator).** Long-press fires at 500ms; arrows render; tap up/down moves the row; tap-elsewhere or Done pill dismisses. Confirm no iOS context menu intrusion.
- **Edit modal pre-population.** Open Edit on an existing row → Auto Kindoo Access + Can Request Access reflect persisted values; `calling_name` is read-only.
- **Rehearse `post-10.4-deploy.md` in staging against a snapshot of prod data before triggering prod import.** This is the deploy-day gate.

## Deferred / follow-ups

No cross-workspace follow-ups beyond what landed in this phase. Schema-doc sync for `auto_kindoo_access` rolls into the existing Phase 10.3 docs-keeper TASKS entry covering `urgent` + `sort_order`.

## Next

No "next phase" gating from Phase 10.4 — it's a behaviour-narrowing + UI-rebuild phase that doesn't change the contract for any later phase. Phase 10.5 (FCM push) and Phase 11 (data migration + cutover) remain the open lanes; both are independent of this phase's changes. Phase 10.1 (left-rail nav redesign) is still operator-deferred.
