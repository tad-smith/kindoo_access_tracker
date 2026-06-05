# T-67 — immutable `building_id` + ward references the building by slug

**Shipped:** 2026-06-05
**Commits:** PR #205 (branch `feat/immutable-building-id-ward-slug`)

## What shipped

The ward → building foreign key moved off the mutable display name and onto the immutable building slug. `building_id` is now genuinely immutable: building **create** derives `building_id = buildingSlug(name)` once, and building **edit** writes the same doc on the frozen slug and never re-slugs. Wards reference their building by `building_id` (preferred) with a `building_name` fallback, resolved id-first. The change is additive and backward-compatible — `building_name` stays required and populated on both wards and buildings — so un-migrated wards and stale browser bundles keep resolving across the migration window. The Buildings UI now also enforces unique display names.

## Why

Building edit re-derived the slug from the (possibly renamed) display name on every save. Renaming a building therefore wrote to a *new* doc id and orphaned the old one — along with every ward and seat reference keyed on the original slug. That was the core defect. The display name is the wrong thing to key a foreign key on: it is the field most likely to change, and slugging it on each edit makes the doc id itself mutable. The fix freezes the slug at create time and makes it the FK target.

`building_name` was not dropped. The reference is additive precisely so the deploy is safe against (a) stale bundles that still read the name-only FK and (b) wards not yet backfilled. Resolution prefers `building_id` and falls back to `building_name`; a stale slug that matches nothing also falls through to the name path, keeping mid-migration data legible. Dropping `building_name` from wards is a deliberate later follow-up, not part of this PR — doing it now would break exactly the stale-bundle / un-migrated-ward cases the additive design protects.

Unique display names became necessary because the name decoupled from the slug on edit. Without the guard, two buildings could share a display name, making the wards' legacy `building_name` FK (and every grant-array display name) ambiguous. The guard is client-side (`duplicateBuildingNameBlocker`) — Firestore rules can't iterate the sibling buildings collection.

## Shared API (the contract everything else codes against)

- `Ward` gained `building_id?: string` (preferred slug FK; optional during the transition, always written by new code). `building_name` stays required.
- `resolveWardBuilding(ward, buildings)` — id-first building resolution with a name fallback; `undefined` when neither resolves.
- `resolveWardSite(ward, buildings)` — **signature changed** from the old `(ward, buildingsByName: Map)` form to the `buildings` array form; now `resolveWardBuilding(ward, buildings)?.kindoo_site_id ?? null`.
- `buildingNameById(buildings, building_id)` — renders a slug FK as the building's current display name.

The old pre-built `buildingsByName` Map helper was removed from every consumer (`functions/src/lib/wardSites.ts`, the extension's `provision.ts` and `sync/detector.ts`) — callers now pass the `buildings` array directly.

## Migration

`functions/scripts/backfill-ward-building-id.mjs` (operator-run, `--dry-run` + apply, ADC auth, `GOOGLE_CLOUD_PROJECT=kindoo-staging|kindoo-prod`) populates `building_id` from `building_name` per stake. Wards whose `building_name` matches no building are logged `UNMATCHED` + counted and left untouched. **Not required for runtime correctness** — id-first-with-name-fallback means un-migrated wards keep resolving — it only promotes the slug FK to primary. Idempotent: re-runs skip wards that already carry `building_id`. Operator runs staging, eyeballs the summary, then prod.

## What didn't change (load-bearing non-changes)

- **Grant arrays stay display-name arrays.** `seat.building_names` / `request.building_names` carry `building_name` values, not slugs, and were not touched. The id-first FK is the ward → building reference only.
- **Firestore rules for `wards` needed no change.** The `match /wards/{wardCode}` block does role + `lastActorMatchesAuth` checks with no field-shape allowlist, so the additive optional `building_id` writes freely. A pinning test in `firestore/tests/wards.test.ts` guards against a future field-shape rule silently rejecting the slug FK.
- **`building_name` retained on wards and buildings.** Required + populated; dropping it from wards is a separate later follow-up.

## Spec / doc edits

- `docs/spec.md` — §3.2 ward/building doc bullets (id-first FK; slug immutable post-create; display name mutable + unique); §3.2 building-doc-ID bullet (~spec.md:95) reconciled — fixed the stale claim that cross-collection refs "carry the slug" by distinguishing the ward → building slug FK from the display-name grant arrays; Configuration bullet (building edit never re-slugs, unique names, ward Select carries `building_id`); bootstrap Ward step; the parallel-site duplicate `building_names` derivation note.
- `docs/firebase-schema.md` — §4.2 wards (`building_id?` field; id-first resolution paragraph; array-form helpers); §4.3 buildings (slug immutable post-create; display name mutable + unique-name guard; ward-inherits-site cross-ref updated to id-first).
- `docs/architecture.md` — D18 added, refining D17(b): immutable slug, id-first ward FK + `resolveWardSite` signature change, unique display names, additive backfill. D17 left verbatim (historical record).
- `docs/TASKS.md` — T-67 item (c) checked off; overall status → done.

## Deferred

- Drop `building_name` from wards once every ward carries `building_id` and no stale bundle reads the name FK → future follow-up (file as a task when the migration window closes).
