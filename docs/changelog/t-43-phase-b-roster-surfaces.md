# T-43 — Phase B: roster surfaces for parallel grants

**Shipped:** 2026-05-17
**Commits:** PR #134 (branch `feat/t-43-phase-b-implementation`)

## What shipped

T-43 closes the visibility gap left by T-42 Phase A: managers can now see and act on parallel-site grants across every Manager-facing roster surface. Multi-site duplicate grants surface as their own rows on AllSeats and as broadened inclusion on Bishopric / Stake / Ward Rosters and Manager Dashboard rollups, and the Remove path correctly splices a single parallel-site duplicate without touching the primary.

## Surface-by-surface

- **AllSeats (`apps/web/src/features/manager/allSeats/AllSeatsPage.tsx`)** — one row per grant. Primary first, then each `duplicate_grants[]` entry in array order. Each row's columns (scope, callings, type, building_names, foreign-site badge, reason / dates) reflect the rendered grant, not the seat's primary alone. Edit on a duplicate row is disabled with a per-case tooltip (parallel-site vs within-site loser). Remove on a duplicate row submits a `remove` request carrying the grant's `(scope, kindoo_site_id)` and only that entry is spliced when the request completes. Reconcile button + `ReconcileDialog` + `useReconcileSeatMutation` deleted.
- **Bishopric Roster, Stake Roster, Ward Rosters** — single row per person, broadened inclusion. A seat appears under a scope when its primary OR any `duplicate_grants[]` entry's scope matches. Row columns reflect the matched grant. Hook implementation: two-query union (KS-10 Option b) — `where('scope', '==', X)` plus `where('duplicate_scopes', 'array-contains', X)`, deduped client-side by `member_canonical` via the shared `mergeSeatsByCanonical` helper.
- **Manager Dashboard rollups** — `countSeatsForScope` widens inclusion the same way; same-scope within-site dupes collapse to one count.
- **Per-row foreign-site badge** — new `siteLabelForGrant(grant, wards, sites)` resolves the badge from the rendered grant's own `kindoo_site_id` (Phase A populates it on every writer), falling back to the ward catalogue when the grant's site is null (legacy / pre-migration).
- **Pending-removal badge** — `partitionPendingForRoster` discriminates by composite key `(member_canonical, scope, kindoo_site_id)` via the exported `pendingRemoveKey` helper, so a pending remove on the East-Stake-Cordera row doesn't dim the home-Cordera row.
- **`removeSeatOnRequestComplete.planRemove`** — keys on `(scope, kindoo_site_id)` when the request carries the field; falls back to scope-only matching for legacy / primary-row removes.
- **`packages/shared`** — `AccessRequest` gains optional `kindoo_site_id?: string | null` (zod + TS type) for remove-on-duplicate-row payloads.
- **`firestore/firestore.rules`** — `seats.read` bishopric clause widens against `duplicate_scopes.hasAny(bishopricWardOf(stakeId))`, guarded by an `'duplicate_scopes' in resource.data` presence check (defense-in-depth for any seat-write path that missed the Phase A mirror).
- **Shared roster primitive** — `apps/web/src/components/roster/PerGrantRosterCard.tsx` extracted so Bishopric / Stake / Ward Rosters share the rendering layer.

## Deviations from the pre-phase spec

None. The Phase B subsection of spec §15 was rewritten from future to present tense in this PR; the design matches the spec.

## Decisions made during the phase

- **KS-10 — roster-hook query shape resolved as Option (b) two-query union.** Couples to the `duplicate_scopes` denormalisation Phase A shipped; no incremental schema cost; the Firestore single-field index auto-creates on first `array-contains` query. Recorded as KS-10 [RESOLVED] in open-questions.md.
- **Per-scope roster pages omit the Edit affordance on duplicate-matched rows.** The spec's "Edit disabled with tooltip" treatment is scoped to AllSeats; on per-scope roster pages, `canEditSeat` already keys off `seat.scope` (the primary's), so a bishopric viewing a stake-primary duplicate row has no authority over the primary and the Edit affordance simply doesn't render. No Edit button on duplicate-matched rows on Bishopric / Stake / Ward Rosters — consistent with today's primary-only edit semantics.
- **Within-site same-scope priority-loser Remove.** The button is rendered only on rows whose `(scope, kindoo_site_id)` discriminator is unique against the primary; for the same-scope same-site case the button is hidden (KS-9 resolution: `(scope, kindoo_site_id)` is sufficient — same-scope same-site collisions are surfaced visually but Remove on the primary covers them).

## Spec / doc edits in this phase

- `docs/spec.md` — §15 "Phase B" subsection rewritten in present tense; heading dropped "(planned)"; six "Open questions" / "Server-side surface" / "Acceptance criteria" subsections compressed into a single landing-state narrative; KS-9 / KS-10 footnotes removed (now resolved).
- `docs/open-questions.md` — KS-10 flipped from `[OPEN]` to `[RESOLVED 2026-05-17 — Option (b) two-query union]` with the implementation link.
- `docs/TASKS.md` — T-43 flipped from `Status: open` to `Status: done (2026-05-17 — PR #134)` with a one-paragraph closing note.
- `docs/changelog/t-43-phase-b-roster-surfaces.md` — this entry.

## Deferred

Same out-of-scope items as the Phase B spec subsection: Edit Seat multi-grant editing, Mark Complete callout for parallel-grant creation, Dashboard "same person on two ward bars" hint, Audit Log grouping across rows. All future work.

## Next

Operator runs the T-42 Phase A migration callable on production (`migration_backfill_kindoo_site_id`) before rolling Phase B out. Without it, the broadened-inclusion / per-grant badge work degrades to a no-op (graceful — no misclassification — but Phase B is meaningless until the data is populated).
