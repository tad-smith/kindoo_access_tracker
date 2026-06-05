# T-68 — prevent building rename while active seats / pending requests reference it

**Shipped:** 2026-06-05
**Branch:** `feat/buildings-block-rename-when-referenced`

## What shipped

A building's display name (`building_name`) is editable in place on a frozen `building_id` slug (T-67), but `seat.building_names` / `request.building_names` are display-name snapshots (§3.2) — renaming a building leaves those arrays pointing at the old name. Per the operator-chosen approach (**option D**), the Buildings UI now **prevents the rename while references exist** rather than repairing the stale arrays. This mirrors the existing `buildingDeleteBlocker`, which already blocks deleting a building that wards reference.

- **`buildingRenameBlocker(currentName, seats, pendingRequests)`** — a pure guard next to `buildingDeleteBlocker` in `apps/web/src/features/manager/configuration/hooks.ts`. Returns a human-readable block message when the building's current display name appears in any active seat's `building_names` or any non-terminal (pending) request's `building_names`, or `null` when free. Match is exact (the arrays store the display name verbatim).
- **Wired into the edit flow.** `useUpsertBuildingMutation` now accepts `previousBuildingName` + live `seats` / `pendingRequests` snapshots. The rename guard runs **only when the display name is actually changing** (`name !== previousBuildingName`) AND the blocker fires; address / `kindoo_site_id`-only edits and name-unchanged saves still go through. On a block it throws, the page surfaces the message via toast (same style as `duplicateBuildingNameBlocker`), and nothing is written.
- **Live subscriptions + hydration gate.** The Buildings tab subscribes to seats + requests (`useSeats` / `useRequests`) so the guard runs against live data, and gates the Edit button until both snapshots hydrate (reuses the `…Ready` pattern from the Delete guard) so it never runs against `[]` on a fast first click.

## What counts as a reference

- **Active seats** — any `seat.building_names` containing the current name.
- **Non-terminal (pending) requests** — any pending `request.building_names` containing the current name. Completed / rejected / cancelled requests are historical and do **not** block (their arrays are frozen records; a rename does not break them).
- **Wards do not count.** The ward → building FK is the immutable slug (T-67), not the display name, so renames don't affect wards. Only the display-name grant arrays need guarding.

## Message

Counts and pluralizes, e.g.:

> Can't rename "Black Forest" — 12 seats and 1 pending request reference it. Remove or reassign them first.

## Why prevent, not cascade

The cascade (rewriting every stale `building_names` array across seats / requests, plus the extension's building-name → Kindoo-rule maps) is the heavier option and was not chosen for this follow-up. Preventing the rename is the same mental model the operator already understands from the Delete guard, needs no Cloud Function / rules / data rewrite, and keeps grant-array semantics (display-name arrays) unchanged. The cascade (**option A**) remains the documented upgrade path if seamless in-use renames are ever needed (T-68 in `docs/TASKS.md`).

## Why client-side

Firestore Security Rules can't iterate a sibling collection, so — like `buildingDeleteBlocker` — this guard lives in the SPA. No rules change, no Cloud Function, no composite index.

## Tests

- **Unit** (`hooks.test.tsx`, `buildingRenameBlocker`): referenced-by-seat → blocked; referenced-by-pending-request → blocked; referenced only by a completed / rejected / cancelled request → allowed; no-refs → allowed; counts + pluralization in the message; tolerates absent `building_names`.
- **Hook-level** (`hooks.test.tsx`, `useUpsertBuildingMutation`): blocks a rename while a seat / pending request references the old name (no write); allows an address-only edit while a seat references the name (name unchanged → guard skipped); allows a rename of an unreferenced building.
- **Component** (`ConfigurationPage.test.tsx`): editing a referenced building + changing the name → blocked with the toast message; changing only the address → saves; renaming an unreferenced building → saves; Edit gated (disabled "Loading…") until seats + requests snapshots hydrate.

## Spec / doc edits

- `docs/spec.md` — Configuration Buildings bullet: renaming a building is blocked while active seats / pending requests reference it (mirrors the Delete guard); names the counts; only non-terminal references block; name-unchanged / address-only edits pass; client-side + Edit-gated-until-hydrated.
- `docs/TASKS.md` — T-68 → done (resolved via option D), with the cascade (option A) retained as the upgrade-path note.

## Out of scope

No Cloud Function, no rules change, no data rewrite / cascade. No change to `seat.building_names` / `request.building_names` semantics — they stay display-name arrays.
