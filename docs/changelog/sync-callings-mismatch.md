# Sync — `extra-kindoo-calling` → `callings-mismatch` (replace to match Kindoo)

**Shipped:** 2026-06-02
**Commits:** PR #186 (`fix/sync-callings-mismatch`) — backend `d4b9891` + extension `b09ac50` + docs (this commit)

## What shipped

The auto-seat calling-diff fix is now a true sibling of `scope-mismatch` / `buildings-mismatch`: when an auto seat's roster `callings[]` differ from Kindoo's parsed primary calling(s), the Sync drift report proposes an **Update SBA** that **replaces** the seat's `callings[]` with Kindoo's full parsed set. Kindoo is authoritative for the calling label.

This corrects a bug. As first shipped (#178/#179, reclassified review→drift in #184), the code was named `extra-kindoo-calling`, fired only in the **additive** direction (Kindoo names a calling the seat lacks), and the callable **appended** the missing calling(s) to `callings[]`. On a *rename* that append was wrong: a seat labelled `Bishop` whose Kindoo Description had been renamed to `Bishopric Clerk` ended up `[Bishop, Bishopric Clerk]` instead of `[Bishopric Clerk]` — two callings where the member has one, with the stale name sorting and granting access alongside the new one.

The rename + fix:

- **Detector (`detector.ts`).** The code is renamed `extra-kindoo-calling` → `callings-mismatch`. The additive `missingCallings(parenText, seatCallings)` is replaced by `parseKindooCallings(parenText)` (the FULL Kindoo target set — comma-split, trimmed, de-duped, Kindoo's casing preserved) plus a new `callingSetsEqual(a, b)` order-independent, case/whitespace-normalized set compare. The row fires (AUTO seats only) whenever the seat's `callings[]` and Kindoo's parsed set differ as normalized sets in **either direction** — rename, add, or drop — and only when Kindoo's target set is **non-empty**. Ordering / casing / padding differences never fire. The target rides on `KindooBlock.kindooCallings` (was `extraKindooCallings`, was the delta — now the full set).
- **Callable (`syncApplyFix.ts`).** `applyExtraKindooCalling` → `applyCallingsMismatch`, payload `{ memberEmail, callings }` where `callings` is the FULL Kindoo set. It **replaces** `seat.callings` (no longer appends), recomputes `sort_order` from the new set, and **reconciles the scope's `importer_callings`** — because a replace can REMOVE app access (the old callings may have earned a `give_app_access` the new ones don't): `writeAccessForAutoScope` when the new callings still earn a grant, else `clearImporterCallingsForScope` (which deletes the access doc when both maps go empty, `manual_grants` always preserved). It rejects an empty `callings` target.
- **Fix UI (`fix.ts`).** The button label was already "Update SBA"; its `testId` moved `add-callings-sba` → `update-sba`. The dispatch sends `kindooCallings` as the callable's `callings` and fails loud on an empty target (the callable rejects it anyway).
- **Shared types.** `ExtraKindooCallingPayload` → `CallingsMismatchPayload`, `extraCallings` → `callings` (full set, not a delta); the `SyncApplyFixInput` union member, the `DiscrepancyCode` union, and `SYNC_DISCREPANCY_CODES` (`systemActors.ts`) all rename `extra-kindoo-calling` → `callings-mismatch`. Re-exported from `packages/shared/src/types/index.ts` + `packages/shared/src/index.ts`.

## Why

The append was a false invariant: it assumed Kindoo only ever *adds* callings to a seat that already carries a strict subset. A rename violates that — Kindoo replaces a label, it doesn't accrete labels — and the append left the old name behind, polluting the roster sort and (where the stale calling was `give_app_access`) granting access on a calling the member no longer holds. Reframing the discrepancy as a bidirectional set mismatch and the fix as a wholesale replace makes the calling axis converge to Kindoo the same way scope and buildings already do.

Reconciling `importer_callings` on the replace is the load-bearing half: an append can only *add* access, so the old append path never had to consider removal. A replace can drop a `give_app_access` calling, so the callable must recompute the grant set from the NEW callings and clear the scope's entry when nothing earns a grant — otherwise a demotion-by-rename would silently leave stale app access behind.

The AUTO-only restriction (operator decision 2026-05-30) is unchanged. Manual / temp seats record their calling in the free-text `reason`, which is frequently operator prose rather than a calling name; checking them would flood the review list with non-actionable rows.

## What didn't change that you'd expect to

- **AUTO-only still holds.** `callings-mismatch` never fires for manual / temp seats. Only the direction (now bidirectional) and the apply behaviour (now replace) changed.
- **The detector check order is unchanged** — scope-mismatch → type-mismatch → buildings-mismatch → `callings-mismatch` (last); a genuine scope/type/buildings drift still preempts the calling reconciliation, one row per email.
- **`sort_order` is still vestigial.** The callable stamps it (now from the replaced set); the web ignores it (render-time calling-order sort, Sync Stage 1a).

## Spec / doc edits

- `docs/spec.md` — §8 per-discrepancy fix protocol: `extra-kindoo-calling` (append) → `callings-mismatch` (replace to match Kindoo's parsed set; sibling of scope/buildings-mismatch; bidirectional set diff; reconciles the scope's `importer_callings`, add or remove).
- `extension/docs/sync-design.md` — discrepancy table, severity list, fix-action catalogue row, the Stage 1(e) section (historical "SHIPPED #179" fact kept, annotated as superseded by #186), detector check-order + AUTO-only notes, and the skip-reconciliation no-row note all updated to `callings-mismatch` / replace-to-match / `kindooCallings` full set / `testId: update-sba`.
- `docs/firebase-schema.md` — §4.5 (access doc) "Written by" notes `callings-mismatch` replaces `callings[]` and reconciles `importer_callings` in either direction (`writeAccessForAutoScope` / `clearImporterCallingsForScope`).
- `docs/TASKS.md` — T-61 records the cross-workspace shared-type rename (`CallingsMismatchPayload`, the union member, `SYNC_DISCREPANCY_CODES` entry), closed; T-57 (e) annotated with the rename.

## Known issues / deferred

None new. B-7's closed entry retains its historical `applyExtraKindooCalling` / `extra-kindoo-calling` repro text as a record of the moment it was fixed; it is not rewritten.
