# A building rename rewrites its wards instead of blocking on them

**Shipped:** 2026-08-09
**Task:** T-74 · **PR:** #273

## What shipped

Renaming a building now sets the new `building_name` on every ward that resolves to it, inside the same `runTransaction` that renames the building. A legacy ward matching only by name — no `building_id` — also gets its slug backfilled.

`buildingRenameBlocker`'s seat and pending-request behaviour is **unchanged**, message included.

## Why write-through and not a block

T-74 offered both. Adding wards to the blocker is the superficially consistent move and it would have been a mistake twice over.

It buys nothing: a ward carries `building_id` alongside the name snapshot, and every consumer resolves **id-first** (`resolveWardBuilding` on the client, `limitedWardBuildingName` in rules). A rename does not break such a ward; it leaves a stale string that nothing reads.

And it costs the feature: every ward references some building, so at target scale (~12 wards over ~3 buildings) any rename would be blocked, with no way forward short of reassigning wards first.

Seats and pending requests are different **in kind**, which is why the block stays for them: `building_names` is their only reference, with no id, so a rename genuinely orphans them.

**This supersedes `t-68-prevent-building-rename-when-referenced.md`**, which recorded "Wards do not count … renames don't affect wards. Only the display-name grant arrays need guarding." That was true of the guard as built and is no longer true of the system. T-68's entry stays as written — a changelog is a record of what shipped then, not a live document.

## Details worth keeping

**Matching runs against the pre-rename buildings snapshot.** `input.existingBuildings` is the live catalogue the duplicate-name guard already reads, and at save time it still carries the old display name — so the old name resolves. Reusing `resolveWardBuilding` rather than comparing strings gets three cases right without special-casing any of them:

- a ward whose slug points at a **different** live building is skipped, even when its stale name matches
- a ward with a **dangling** slug falls through to the name path and is matched
- a **name-only** ward matches

**`building_id` is backfilled only when absent.** A dangling slug is renamed but deliberately not rebound: `resolveWardBuilding`'s soft fallback should not harden into stored data.

**A save that leaves the name untouched writes no ward updates.** Patches for unchanged wards are dropped before the transaction.

## Testing note

The E2E asserts the **stored Firestore docs**, not the rendered UI. The UI resolves id-first, so it shows the new name correctly even with a stale snapshot — a UI assertion would have passed against the bug it was written to catch.
