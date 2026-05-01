# Phase 10.3 — UI polish (urgent flag, queue sections, sort, contextual utilization)

**Shipped:** 2026-04-29
**Commits:** see PR [#37](https://github.com/tad-smith/kindoo_access_tracker/pull/37) (7 commits on `phase-10.3-ui-polish`).

## What shipped

Six UX polish items across the request and roster surfaces. A new `urgent: boolean` field on requests gives the submitter a checkbox above Submit (with a comment-required gate) and renders a red top-bar marker on pending cards in My Requests and the Queue. The manager Queue is now restructured into three sections — Urgent / Outstanding / Future — driven by a computed `comparison_date` (`start_date` for `add_temp`, `submitted_at` otherwise) with the today+7 cutoff anchored to the user's local midnight. The My Requests Cancel button moved onto the pill row at `size="sm"`. The Configuration label "Notifications enabled" was renamed to "Email Notifications Enabled" (field name `notifications_enabled` unchanged). The All Seats page always renders one `<UtilizationBar>` matching the current scope filter (All / stake / specific ward), replacing the per-scope summary cards that Phase 10.2 #13 removed. A denormalized `sort_order` was introduced on seats and access docs — sourced from calling-template `sheet_order` via the importer's existing `TemplateIndex` — so roster auto sections and All Seats sort by calling priority within scope.

The backend lane on the same branch tightened `firestore.rules` (urgent validation, `add_temp` ISO date enforcement with start ≤ end, terminal-transition `affectedKeys` allowlists made explicit) and taught the importer to denormalize `sort_order` on every write, with the diff planner honouring it for change detection.

The phase shipped over 7 commits: one shared-schema prep, four feature batches, one backend lane, one E2E follow-up.

### Shared schema prep (`b6eece7`)

`packages/shared/` Zod schemas extended:

- `Seat` and `Access` gained an optional `sort_order: number | null` field (null permitted for orphaned-calling seats and manual-only access docs).
- `Request` gained an optional `urgent: boolean` field (treated as `false` when missing on read).

Pure schema work; no behaviour change yet.

### Item #4 — Configuration label rename (`6766aff`)

`apps/web/src/features/configuration/ConfigurationPage.tsx` — the Notifications field label changed from "Notifications enabled" to "Email Notifications Enabled". The underlying field name (`notifications_enabled`) is unchanged so no schema or rules touch was needed; the change is purely surface text.

### Items #3 + #5 — pill-row Cancel + contextual utilization (`f04b86e`)

- **Cancel button placement (#3).** `MyRequestsPage.tsx` — the Cancel button moved out of the card body and onto the pill row, sized `size="sm"` to match pill height. Reads as a row-level affordance instead of a card-footer one.
- **Contextual utilization (#5).** `AllSeatsPage.tsx` — one `<UtilizationBar>` always renders above the table, scoped to the current filter (All / stake / specific ward). Replaces the per-scope summary cards removed in Phase 10.2 #13; the operator decision was that one bar that follows the filter is more useful than three static cards above an unfiltered table.

### Backend lane — rules + importer denormalization (`be93970`)

Backend-engineer's lane on the same branch.

- **Rules — urgent validation.** `firestore.rules` request-create predicate now validates `urgent is bool`. Missing → treated as false on read; non-bool types denied at create. A belt-and-suspenders byte-equal check on `urgent` in the terminal-transition predicates defeats `affectedKeys` allowlist drift (i.e., a future rule edit that loosens the allowlist still can't sneak through a stealth `urgent` mutation on a terminal write).
- **Rules — add_temp date enforcement.** `start_date` and `end_date` must be ISO `YYYY-MM-DD`; `start_date <= end_date` enforced as a cross-field gate.
- **Rules — terminal allowlists.** Cancel / complete / reject transitions now have explicit `affectedKeys` allowlists rather than relying on permit-all-with-state-machine logic. Reduces the surface for accidental field mutation on a terminal write.
- **Importer — `sort_order` denormalization.**
  - **Seats:** MIN of `sheet_order` across the seat's `callings[]` resolved via `TemplateIndex` (which already handles wildcard template names like `Counselor *`). Orphaned callings (no template match) → `sort_order: null`.
  - **Access docs:** MIN of `sheet_order` across all `(scope, calling)` pairs in the doc's `importer_callings`. Manual-only access docs (no `importer_callings`) → `sort_order: null`. Operator-decided: doc-level sort_order (option b), not per-grant.
- **Diff planner.** Change-detection now includes `sort_order`; a single template `sheet_order` reorder produces exactly one update per affected doc on the next import run.
- **Audit trigger.** Handles `sort_order` for free — the parameterized `auditTrigger` writes the full doc shape and never had a field allowlist.

### Items #0 + #1 — urgent flag + queue restructure (`10649a0`)

Items 0 and 1 are paired because the queue sectioning consumes the new `urgent` field.

- **Urgent flag (#0).** `NewRequestForm.tsx` grew a checkbox above the Submit button. When ticked, the comment field becomes required (the helper text reuses the same form-error styling as the rest of the form). On the read side, both `MyRequestsPage.tsx` and `QueuePage.tsx` mark pending cards with a red top-bar — implemented as a shared `.kd-card-urgent` CSS class that composes onto `.kd-queue-card.urgent` and `.kd-myrequests-card.urgent` so there's one source of truth for the marker.
- **Queue restructure (#1).** `QueuePage.tsx` title is now "Request Queue", scope is pending-only, and the pending list is split into three sections — **Urgent**, **Outstanding**, **Future** — by a computed `comparison_date` (`start_date` for `add_temp`, `submitted_at` for everything else) against a today+7 cutoff at user-local midnight. Sections hide when empty. Within each section, oldest-first sort.

### Item #6 — sort by template `sheet_order` (`28c465c`)

New `apps/web/src/features/rosters/sort.ts` helper. The auto section of every roster sorts by `sort_order` ascending (orphaned / null → bottom of the auto section, per operator decision); manual section sorts alpha by name; temp section sorts by `end_date` with soonest-expiring at the bottom. All Seats sorts primarily by scope (Stake first, then wards alpha by `ward_code`), then by `sort_order` within scope.

### E2E follow-up (`a4da749`)

`e2e/tests/` — the Playwright spec exercising the queue heading was asserting on the pre-phase title; updated to expect "Request Queue". No production code change.

## Decisions made during the phase

Three operator-decided departures from the original Phase 10.3 brief, plus a research-time correction to the brief itself.

- **Field name in templates is `sheet_order`, not `order`** (research-time correction). The original brief referenced `order`; verification against the live `wardCallingTemplates` / `stakeCallingTemplates` collections during plan-only research showed `sheet_order`. Used throughout.
- **Template collection paths are `wardCallingTemplates` / `stakeCallingTemplates`**, not `templates/{ward,stake}/callings`. Same source — confirmed during plan-only research.
- **Access-row `sort_order` is doc-level (option b), not per-grant.** The doc carries one MIN-across-`importer_callings` value rather than per-grant arrays. Simpler read-side surface; operator preferred a single integer ordering on the access row.
- **"Today" cutoff for queue sectioning is user-local midnight, not stake-tz-anchored.** Operator accepted one-day timezone drift for UI sectioning; not worth the round-trip through `stake.timezone`.
- **Null `sort_order` placement: bottom of the auto section.** Orphaned callings (no template match for a seat) and manual-only access docs sort below the rest of the auto section rather than at the top.
- **Migration: wait for next importer run.** No backfill script. Existing seats and access docs sort with the null fallback (bottom of auto section) until the next import populates `sort_order`.

## Cross-cutting decisions

- **`.kd-card-urgent` shared CSS class.** Composes onto `.kd-queue-card.urgent` and `.kd-myrequests-card.urgent`. One source of truth for the red top-bar marker; either site can change its base card styling without breaking the marker.
- **Form-error styling reused for urgent helper text.** No new error-text component; the existing styling carries through. Keeps the form surface consistent.
- **`TemplateIndex` reuse for `sort_order` lookup.** Backend-engineer used the importer's existing `TemplateIndex` (not a flat `name → sheet_order` map) because callings can match wildcards (`Counselor *`). This reuses the same source of truth the importer already uses to identify which template matched a given calling — divergent lookup paths would have created drift between "is this calling auto-grant?" and "what's its sort_order?".

No new architecture D-numbers earned. The schema additions (`urgent`, `sort_order`) are field-level and do not change the existing data-model invariants; the backend-rules tightening encodes existing-spec behaviour more strictly rather than introducing a new rule; the CSS class and helper conventions are component-level.

## Spec / doc edits in this phase

`docs/spec.md` is **not** touched. Phase 10.3 polishes the Firebase-only manager and member UI and adds two fields to the Firebase schema; Apps Script reality (which `spec.md` still describes until Phase 11 cutover) is unchanged.

- `docs/architecture.md` — unchanged.
- `docs/firebase-migration.md` — new Phase 10.3 entry slotted between Phase 10.2 and Phase 10.5, marked `[DONE]` and pointing here.
- `docs/firebase-schema.md` — **not** updated in this phase. The new `urgent` (Request) and `sort_order` (Seat, Access) fields are not yet reflected in §4.6 / §4.5 / §4.7 of the schema reference. Captured as a docs-keeper follow-up — see TASKS.md.
- `docs/data-model.md` — **not** updated. Same reason; same follow-up.
- `docs/changelog/phase-10.3-ui-polish.md` — this entry.
- `docs/TASKS.md` — one new entry: schema-doc sync for `urgent` + `sort_order`.

## Test footprint

- **Rules:** 7 `add_temp` date tests + 7 `urgent` validation/immutability tests added to the `firestore/` and `functions/` rules-test suites.
- **Importer integration:** `sort_order` denormalization on seats (single calling, multi-calling MIN, orphaned → null) plus access docs (MIN across `importer_callings`, manual-only → null), plus idempotency on re-run with the same template.
- **Web unit + component:** items 0 / 1 / 3 / 4 / 5 / 6 covered per the original plan.

## Areas worth focused operator review during staging tests

Web-engineer flagged four items where the visual or interaction change is most likely to surface "did this regress?" on first look:

- **Queue sectioning at the today+7 boundary.** A request with `comparison_date` exactly seven days out should fall in Outstanding; eight days out should fall in Future. Verify across user-local midnight rollover.
- **Urgent-checkbox alignment + conditional comment gate.** Tick urgent → comment field becomes required; untick → required state clears. Visual alignment of the checkbox above Submit.
- **Multi-calling auto seat `sort_order` MIN behaviour.** A seat with two callings of differing `sheet_order` should sort by the lower number. Orphaned-calling seats should sit below the rest of the auto section.
- **Contextual utilization bar across all three scope filters.** All / stake / specific ward — bar updates immediately on filter change; matches the per-row data visible in the table below.

## Deferred / follow-ups

- **Schema-doc sync.** `docs/firebase-schema.md` and `docs/data-model.md` need entries for the new `urgent` (Request) and `sort_order` (Seat, Access) fields. Filed as a docs-keeper TASKS entry; will land separately to keep this PR docs-only-and-bounded.
- **No cross-workspace follow-ups beyond what landed in this phase.** Backend, web, and shared schema all closed inside the same branch.

## Next

No "next phase" gating from Phase 10.3 — it's a polish + denormalization phase that doesn't change the contract for any later phase. Phase 10.5 (FCM push) and Phase 11 (data migration + cutover) remain the open lanes; both are independent of this phase's changes. Phase 10.1 (left-rail nav redesign) is still operator-deferred.
