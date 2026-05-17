# T-42 Phase A — multi-site parallel grants

**Shipped:** 2026-05-17
**Commits:** PR #131 (branch `feat/t-42-phase-a-implementation`)

## What shipped

Phase A of T-42 lands the data-model + behavioural changes across `packages/shared/`, `functions/`, `extension/`, and `apps/web/` to surface a Kindoo user whose callings straddle home + foreign sites on every site that owns one of those callings. The eight acceptance criteria from `docs/TASKS.md` T-42 are all met.

## Why

The Phase 4 sync detector resolved a Kindoo user's site by collapsing the parsed `Description` to a single primary segment via `pickPrimarySegment`. A Description like `'Cordera Ward (Bishop) | Foothills Ward (Stake Clerk)'` (Cordera home, Foothills foreign) has both segments resolve to real wards on different sites, but the picker chose one and the unpicked side lost visibility of the user entirely. Per-site provisioning was similarly broken — the orchestrator unioned every seat grant against the active session, polluting Kindoo with buildings from another environment.

## packages/shared

- `Seat.kindoo_site_id?: string | null` and `DuplicateGrant.kindoo_site_id?: string | null` added to `src/types/seat.ts` and mirrored in `src/schemas/seat.ts`. Same convention as ward / building: `null` (or field absent) means home; a string is a doc id under `stakes/{stakeId}/kindooSites/`.
- `AuditAction` enum gains `'migration_backfill_kindoo_site_id'` (audit-action + zod schema).
- New schema tests cover top-level + per-duplicate field shapes (null / string / absent), reject non-string non-null values, and round-trip a migration audit row.

## functions

- **Importer fan-out** (`src/lib/diff.ts`, `src/services/Importer.ts`). The diff planner now emits one `duplicate_grants[]` entry per `(scope, kindoo_site_id)` combo other than the primary. Parallel-site duplicates (different site from primary) carry their own `building_names`; within-site duplicates leave the field unset and inherit at runtime. `Seat.kindoo_site_id` is stamped at the top level on every importer-written seat. Stake-scope auto seats default to the home-site building list (per Phase 1 policy).
- **`markRequestComplete`** (`src/callable/markRequestComplete.ts`). `planAddMerge` stamps `kindoo_site_id` on a newly-appended duplicate (derived from the request's scope and ward lookup); the new-seat-create path stamps it too.
- **One-shot migration** (`src/callable/backfillKindooSiteId.ts`, new). Per-stake callable that walks every seat + every duplicate, resolves the expected `kindoo_site_id` from each scope → ward, and writes only when the derived value differs from what's stored. Missing-ward duplicates skipped with a logged warning. Migration writes stamp `lastActor='Migration'` and the `auditTrigger` emits each row under the dedicated `migration_backfill_kindoo_site_id` action.
- **`overCaps.ts`** reads `Seat.kindoo_site_id` directly when populated; falls back to the seat's `scope` → ward `kindoo_site_id` for legacy seats. Externally-observable behaviour is unchanged.
- **`auditTrigger`** recognises `lastActor.canonical === 'Migration'` on seat updates and emits the dedicated action.

## extension

- **Sync detector** (`src/content/kindoo/sync/detector.ts`). `pickPrimarySegment`'s collapse is dropped for the per-site path. For each active Kindoo site, the detector projects each seat onto the active site (primary if its `kindoo_site_id` matches, plus every same-site `duplicate_grants[]` entry) and picks the parsed Description segment whose scope resolves to the active site. Both home and foreign views now see multi-site users, with each side comparing only the site-relevant grants and the site-relevant segment.
- **Provision orchestrator** (`src/content/kindoo/provision.ts`, `sync-provision.ts`). The per-site write unions only those grants whose `kindoo_site_id` resolves to the request's target site (or, for the sync-provision path, the active session's site). Parallel-site grants no longer pollute the active environment. The Phase 3 EID check at orchestrator entry already gates the active session against the request's target site; the union narrowing is purely about the write payload.
- **Manifest version** bumped `0.10.6` → `0.11.0` (significant behaviour change).

## apps/web

- **AllSeatsPage** utilization total prefers `Seat.kindoo_site_id` when populated; falls back to ward-derived `foreignWardCodes` for legacy seats. No visible UI change.
- New helper `seatSiteId(seat, wards)` in `src/lib/kindooSites.ts` codifies the field-preferred-with-ward-fallback resolution for future callers.

## Spec / doc edits

- `docs/spec.md` §15 "Multi-site grants — data model" rewritten in present tense (the `(planned, T-42)` qualifier and forward-tense paragraph are gone). All previously-future-tense paragraphs now describe running behaviour.
- `docs/TASKS.md` T-42 marked `done (2026-05-17 — PR #131)` with a closing note; original body preserved for history.

## Migration plan

The migration callable (`backfillKindooSiteId`) is operator-invoked once per stake. The operator runs it manually against staging first, verifies the audit-row count and warnings, then runs against production. Re-runs are safe — skip-if-equal idempotence means a fully-migrated stake produces zero writes on subsequent invocations.

## What's NOT in this PR (Phase B)

Manager UI rendering of parallel grants — the All Seats / roster card surfaces still show only the primary scope's badge. Phase B will add a multi-site visual indicator and reconcile-dialog support for parallel-site duplicates.
