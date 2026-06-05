# Config simplification — fixed app-access list, ward site from building, buildings-first tabs

**Shipped:** 2026-06-04
**Commits:** PR #192 (`feat/simplify-stake-config`); architecture decision D17.

## What shipped

Three coupled simplifications to stake configuration. (1) The manager Configuration page orders tabs **Config → Managers → Kindoo Sites → Buildings → Wards** — Buildings now precede Wards, and "Add Ward" is disabled with an "Add a building first." hint until at least one building exists (the bootstrap wizard already required this). (2) A ward no longer stores `kindoo_site_id`; its Kindoo site is **derived from its assigned building**. (3) In-app access is no longer per-stake-configurable: the calling-template collections and their Configuration tabs are deleted, and access is granted iff a member's calling is in a **hard-coded churchwide list**.

## Deviations from the pre-change spec

The spec was updated in the same PR; these are the behavioural deltas it now reflects.

- **A ward's Kindoo site is derived, not stored.** `Ward.kindoo_site_id` is removed (type, schema, form, reads). A ward inherits its site from its building (`ward.building_name → building.kindoo_site_id`; `null` / absent = home) via `resolveWardSite()` (`packages/shared`) and the `wardSiteMap` server helper (`functions/src/lib/wardSites.ts`). Buildings still carry `kindoo_site_id`. Seat docs are stamped with the site resolved through the ward's building. Spec: §3.2, §5.3, §8, §10, §15; schema §4.2 / §4.6 / §4.11.
- **App access from a fixed list.** The `wardCallingTemplates` / `stakeCallingTemplates` collections, their two Configuration tabs, the `give_app_access` / `auto_kindoo_access` / `sheet_order` fields, the `callingTemplate` shared type + zod schemas, `functions/src/lib/parser.ts`, the template audit triggers, and the extension's template classifier are all deleted. `syncApplyFix` now populates `access.importer_callings[scope]` from `filterAppAccessCallings(scope, callings)` against the hard-coded list (`packages/shared/src/appAccessCallings.ts`). The list is exclusive — no wildcards, no per-stake config. Ward callings: Bishop; Bishopric First/Second Counselor; Ward Clerk; Ward Executive Secretary. Stake callings: Stake President; Stake Presidency First/Second Counselor; Stake Clerk; Stake Executive Secretary; Stake High Councilor. Spec: §5.3, §8; schema §4.5 / §4.8.
- **Sort from the canonical churchwide table.** Seat / access `sort_order` and roster ordering use `seatCallingOrder()` / `callingSortOrder` instead of the removed template `sheet_order`. Spec: §8 "Roster sort order"; schema §4.5 / §4.6.
- **Configuration tab order + Add-Ward gate.** Tabs Buildings-before-Wards; "Add Ward" disabled until ≥1 building exists. Bootstrap already ordered Building (step 2) before Ward (step 3) and required ≥1 building — unchanged, now affirmed in §10. Spec: §5.3, §10.

## Decisions made during the phase

- **App-access callings are a fixed churchwide list; a ward's site derives from its building.** Recorded as **D17**, superseding the relevant clauses of D13 ("Buildings and wards carry `kindoo_site_id`") and D14 ("`wardCallingTemplates` + `stakeCallingTemplates` stay"). The calling hierarchy is the Church's, not the stake's, so per-stake app-access config encoded no realized variation; and a ward sits in exactly one building, so a separate `ward.kindoo_site_id` was a second place to set the same fact and a drift hazard. See `architecture.md` D17 for the full rationale and alternatives.

## What didn't change (load-bearing non-changes)

- **Seat type is still role + door-grant derived** (`DepartmentType` + church-direct grants — D14 / Sync Stage 1). It was never template-derived after Sync Stage 1c, so removing templates does not touch type classification.
- **Buildings keep `kindoo_site_id`.** Only the ward lost the field. Building docs, the seat / duplicate-grant `kindoo_site_id`, and the home-vs-foreign site model are unchanged.
- **The bootstrap wizard's step order is unchanged** — it already put Building before Ward and required ≥1 building. §10 only affirms the dependency.
- **`importer_callings` keeps its historical field name** (predates the LCR importer removal — D14). Renaming it stays out of scope.

## Spec / doc edits in this PR

- `docs/spec.md` — §3.2 ward/building bullets (ward site derived; template-collection bullets removed); access/seat `sort_order` from canonical order; §5.3 Configuration tab order + Add-Ward gate + no calling-template tabs; §6.1 dropped a dead `wardCallingTemplates` reference; §8 new "App access" subsection (hard-coded list, templates gone), `callings-mismatch` / `kindoo-unparseable` access reconciliation reworded off templates, "Roster sort order" off `sheet_order`; §10 bootstrap order affirmed; §15 ward-site references reworded to building-derived.
- `docs/architecture.md` — added **D17**; cites the superseded clauses of D13 and D14.
- `docs/firebase-schema.md` — §4.2 removed `Ward.kindoo_site_id`, added site-from-building note; §4.3 building note; §4.5 `importer_callings` from the hard-coded list + `sort_order` from `callingSortOrder`; §4.6 seat `kindoo_site_id` via ward→building, "Sort order" off `sheet_order`; §4.8 / §4.9 template collections replaced with a REMOVED tombstone; §4.10 audit sub-entity list; §4.11 delete-guard description (buildings only, wards transitive) + ward-has-no-site invariant; §5.1 index note; §6 rules reference copy (removed the two template `match` blocks + the KindooSites comment); bootstrap §6.1 not-covered list.
- `docs/changelog/config-simplification.md` — this entry.
- `docs/TASKS.md` — added T-65 (post-merge data cleanup).

## Migration note

No data migration blocks the merge — both changes self-heal:

- **Access self-heals on the next Sync.** `syncApplyFix` rewrites `access.importer_callings[scope]` from the hard-coded list on the next run that touches each seat; off-list grants drop then. Stale `importer_callings` values linger only until that run.
- **Ward site self-heals at read time.** Resolvers (`resolveWardSite` / `wardSiteMap`, the seat ward-fallback) ignore any stale `ward.kindoo_site_id` still on disk and read the building instead.

Two pieces of orphaned data are left in place deliberately and cleaned up post-merge: the `wardCallingTemplates` / `stakeCallingTemplates` docs in existing stakes (no longer read or writable) and the stale `kindoo_site_id` field on existing ward docs (no longer read). Purging both is **T-65** (cross-cutting; not merge-blocking).

## Known issues / deferred work

- **T-65** — purge orphaned `wardCallingTemplates` / `stakeCallingTemplates` docs and strip stale `ward.kindoo_site_id` from existing ward docs.
