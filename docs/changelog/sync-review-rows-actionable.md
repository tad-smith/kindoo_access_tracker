# Sync — review rows made actionable

**Shipped:** 2026-06-02
**Commits:** PR #184 (`feat/sync-review-types-actionable`) — backend `f1be9b7`, extension `bf74505`, docs (this commit)

## What shipped

The extension's Sync drift report no longer surfaces dead-end "review" rows that offer no action. Sync is Kindoo-authoritative (it never writes SBA → Kindoo), so a `review`-severity row used to be a dead end: there was no Update Kindoo (authoritative) and no Update SBA either. Two of the three review codes now carry an Update-SBA action, and the third is the one remaining display-only case. After this change, **the only review-severity Sync row is a blank Kindoo Description** — every other discrepancy code offers an SBA-side fix.

Three buckets:

- **`extra-kindoo-calling`** (auto seat whose Kindoo Description lists calling(s) the seat lacks): reclassified `review → drift`. The action's user-facing label moved from **"Add to SBA seat"** to **"Update SBA"** to match the other Update-SBA buttons. The underlying behaviour — `syncApplyFix` with `code: 'extra-kindoo-calling'` de-dupes and appends the missing calling(s) to the seat's `callings[]` — is unchanged, and the dispatch `testId` stays `add-callings-sba`.
- **`kindoo-unparseable`** is split on the parser's blank-vs-present distinction (`parsed.segments.length === 0`):
  - **present-but-unparseable** (Description present but doesn't match `Scope (Calling)`): now `drift` with an **"Update SBA"** action. A new callable path `applyKindooUnparseable` (payload `{ memberEmail, calling }`, `calling` = the raw Kindoo Description text) treats the Description as a **church-wide calling**: it sets the seat to `scope='stake'`, **preserves the existing `type`**, and writes the calling per the §13 seat-shape convention (auto → `callings[]`; manual/temp → free-text `reason`, callings cleared, temp dates preserved). For an **auto** seat it also reaps the OLD scope's `importer_callings` via `clearImporterCallingsForScope` (the same Kindoo-authoritative reap as `sba-only` / `type-mismatch` demote, #183) and creates **no** new grant — an unparseable church-wide calling matches no `give_app_access` template, so no SBA app access is granted automatically; that would flow through a manual grant.
  - **blank Description** (empty / whitespace): a new code **`kindoo-no-description`**, `severity: 'review'`, **no action**. This is the one remaining display-only Sync row.
- A defensive **"resolved segments but no primary"** fallback in the detector also moved `review → drift` (emitting `kindoo-unparseable`), so it offers Update SBA for consistency — text is present, so it's treated like present-but-unparseable.

Shared types gained `KindooUnparseablePayload` (`{ memberEmail, calling }`) and a `{ code: 'kindoo-unparseable' }` member on the `SyncApplyFixInput` union, re-exported from `packages/shared/src/types/index.ts` + `packages/shared/src/index.ts`. `SYNC_DISCREPANCY_CODES` (`packages/shared/src/systemActors.ts`) gained `'kindoo-unparseable'` so the seat write stamps `SyncActor:kindoo-unparseable` and renders with the automated-actor chip. `kindoo-no-description` deliberately has **no** payload and is **not** in `SYNC_DISCREPANCY_CODES` — it never reaches the callable.

## Why

Sync converges drift between SBA and Kindoo in one direction (Kindoo authoritative, locked PR #183). A `review`-severity row that offered no button was a genuine dead end after the Kindoo-write path was removed: the operator saw drift but had no way to act on it in the panel. The fix is to derive an SBA-side action wherever one can be derived, and to keep `review` only for the genuinely underivable case.

A **present** but unparseable Description does carry intent — it's some calling text that doesn't fit the `Scope (Calling)` convention. The agreed reading is "a church-wide (stake-scope) calling," so the action moves the seat to stake scope and stores the raw text as its calling. A **blank** Description carries nothing: no scope, no calling, nothing to reconcile to. That's the only case left for manual operator judgment, hence the dedicated `kindoo-no-description` review code.

The auto-seat reap mirrors the just-shipped #183 reaping behaviour rather than `applyScopeMismatch`'s scope-only update: moving an auto seat off its old scope without reaping `importer_callings[oldScope]` would strand stale calling-derived access under the abandoned scope. No new stake-scope `importer_callings` entry is written because `writeAccessForAutoScope` would no-op — an unparseable calling matches no `give_app_access` template — so skipping it keeps the transaction's reads strictly before its writes and avoids a dead write.

## What didn't change that you'd expect to

- **The `extra-kindoo-calling` backend path is byte-for-byte unchanged.** Only the button label and the discrepancy's severity moved; the append-to-`callings[]` callable and the dispatch `testId` (`add-callings-sba`) are the same.
- **`kindoo-unparseable` does not write a new grant.** Despite moving the seat to stake scope, it grants no SBA app access — an unparseable calling matches no `give_app_access` template, and the church-wide-calling-needs-access case is a deliberate manual grant, not a Sync side-effect.
- **The Sync read/detection path is otherwise intact.** Parser, derived-buildings enrichment, active-site scoping, and every other discrepancy code are unchanged; only the unparseable bucket's severity + actions and the `extra-kindoo-calling` label moved.

## Spec / doc edits

- `docs/spec.md` — §8 per-discrepancy fix protocol: `extra-kindoo-calling` is now **Update SBA** (drift); `kindoo-unparseable` (present) is **Update SBA** = move seat to stake scope + set calling from the raw Description (auto-seat reap, no new grant); new `kindoo-no-description` (blank) is review-only with no action, called out as the only remaining display-only Sync row.
- `extension/docs/sync-design.md` — discrepancy detector table + severity list updated (`kindoo-no-description` added; `kindoo-unparseable` and `extra-kindoo-calling` moved to drift; `kindoo-no-description` is the sole review code). Fix-action catalogue rewritten for the three codes. Locked-in decision #5 annotated as superseded. Active-site filter note now lists `kindoo-no-description` among the home-kept rows.
- `docs/firebase-schema.md` — §4.5 (access doc) "Written by" notes that `kindoo-unparseable` (auto seat moving to stake scope) reaps the old scope's `importer_callings` and writes no new entry.
- `docs/TASKS.md` — T-60 records the cross-workspace shared-type addition (`KindooUnparseablePayload` + `kindoo-unparseable` union member + `SYNC_DISCREPANCY_CODES` entry), closed.

## Known issues / deferred

None new. The `kindoo-no-description` row is intentionally display-only — a blank Description yields nothing for Sync to reconcile, so the operator decides manually.
