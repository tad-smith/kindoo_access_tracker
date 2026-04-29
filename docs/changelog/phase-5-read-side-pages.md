# Phase 5 — Read-side pages

**Shipped:** 2026-04-28
**Commits:** see PR [#9](https://github.com/tad-smith/kindoo_access_tracker/pull/9) (4 commits squashed onto `main` as the Phase 5 close commit); predecessor on `main` was `f26bbf6` (PR [#5](https://github.com/tad-smith/kindoo_access_tracker/pull/5), the T-19 caret-floor refresh + clasp 2 → 3 CVE-2026-4092 bump). The intervening cleanup PRs ([#6](https://github.com/tad-smith/kindoo_access_tracker/pull/6) T-01 version-stamper alignment, [#7](https://github.com/tad-smith/kindoo_access_tracker/pull/7) deploy-script test-step removal, [#8](https://github.com/tad-smith/kindoo_access_tracker/pull/8) auditLog redundant-index drop) merged before PR #9 but are not Phase 5 work.

## What shipped

Every read-only page from the Apps Script app now renders on Firebase against real Firestore data. No new features, no UI redesigns. Live updates via the DIY hooks from Phase 3.5 (`useFirestoreCollection`, `useFirestoreDoc`) on shared-attention pages (Roster, MyRequests, Dashboard); Audit Log uses request-response pagination via `useFirestoreOnce` because cursor pagination doesn't compose with `onSnapshot`. Phase 5 is behaviour-preserving — `spec.md` describes Apps Script reality and is unchanged.

Acceptance criteria from `firebase-migration.md` line 789 onward — every Chunk 5 / Chunk 10 read-path criterion passes against Firestore data, filter state survives URL deep-links, Audit Log pagination works, Dashboard cards render across empty / one-ward / all-wards states, mobile usable on every page, live updates on Roster + MyRequests + Dashboard, `tsc -b` clean — all met. Tests: 172 web-side passing (105 baseline + 38 page tests + 29 manager-page tests); e2e refreshed for the new role-default landings.

The four squash-merged commits group naturally into:

### T-18 — Tailwind v4 + shadcn-ui bootstrap

Bootstrap before the first real Phase 5 page. Tailwind v4 via the CSS-driven `@theme` block (no `tailwind.config.js`) — `apps/web/src/styles/tailwind.css` mirrors the design tokens already declared in `tokens.css` so utility classes (`bg-kd-primary`, `text-kd-fg-1`, etc.) compose with the existing component CSS without duplicating values. Imported once from `main.tsx`. `apps/web/vite.config.ts` adds the `@tailwindcss/vite` plugin alongside the existing TanStack Router + React plugins.

shadcn primitives copy-pasted into `apps/web/src/components/ui/`: `Button`, `Badge`, `Card` (+ `CardHeader` / `CardTitle` / `CardContent` / `CardFooter`), `Input`, `Select`, `Skeleton`. Each follows shadcn convention (forwardRef, `asChild`, variant props) but wraps the existing `.btn` family from `base.css` so visual parity with the Apps Script app is preserved. `apps/web/src/lib/cn.ts` adds the `cn()` utility (clsx + tailwind-merge) every primitive uses.

The Phase 4 hand-rolled `Dialog` and `Toast` were intentionally **not** swapped — they already wrap Radix Dialog and have green tests. Swapping to canonical shadcn Tailwind classes would be a no-op behaviour change. Recorded in T-18 close note.

Bundle delta: production CSS grew ~2 kB → ~17 kB (Tailwind utility output for the classes used by Phase 5 pages); JS unchanged because `cn` and Radix Slot tree-shake into existing chunks.

### Read-side pages — seven feature folders

Eight new routes under `apps/web/src/routes/_authed/`, each one thin (just composes hooks + the page component from `features/`). Page bodies live under `apps/web/src/features/`:

- **`features/bishopric/RosterPage.tsx`** — live, ward-scoped. Multi-ward picker rendered when the principal holds bishopric roles in more than one ward.
- **`features/stake/RosterPage.tsx`** — live, `scope == 'stake'`.
- **`features/stake/WardRostersPage.tsx`** — read-only browse over any ward.
- **`features/manager/dashboard/DashboardPage.tsx`** — five live cards (Pending counts, Recent Activity, Utilization, Warnings, Last Operations); each subscribes independently via `useFirestoreCollection`. Deep-links to `/manager/seats` and `/manager/audit` use TanStack Router typed search params. `DashboardPage.tsx` is 350 LoC, the largest Phase 5 page.
- **`features/manager/allSeats/AllSeatsPage.tsx`** — full roster across every scope; ward / building / type filters via URL search params (zod schemas in `validateSearch`); per-scope summary cards with utilization bars; total-utilization bar when scope filter is "All".
- **`features/manager/auditLog/AuditLogPage.tsx`** — cursor-paginated request-response read via `useFirestoreOnce`. Filters: action / entity_type / entity_id / actor_canonical / `member_canonical` / date_from / date_to. The new `member_canonical` filter introduces cross-collection per-user views (per the migration plan). Per-row collapsed summary (the Apps Script `shortSummary()` logic ported into `apps/web/src/features/manager/auditLog/summarise.ts`) plus a `<details>` JSON-pretty diff (`<pre>{JSON.stringify({ before, after }, null, 2)}</pre>`). Pagination uses TanStack Query keyed on a stack of `Timestamp` cursors.
- **`features/manager/access/AccessPage.tsx`** — read-only Phase 5 view per `firebase-schema.md` §4.5: one card per user with importer + manual ownership stripes visually split. Phase 7 will add manual-write affordances.
- **`features/myRequests/MyRequestsPage.tsx`** — live, requester-scoped. Cancel button on pending rows (the one Phase 5 write); rejection reason rendered on rejected rows; multi-role scope filter when the principal has multiple roles.

Per-feature `hooks.ts` files own the Firestore queries; components consume hooks, never the SDK directly (per `apps/web/CLAUDE.md`). Production module total: ~3.5 k LoC of feature code + ~1.6 k LoC of test code across the seven folders.

### Cancel-pending-request mutation

The single Phase 5 write path. `apps/web/src/features/myRequests/cancelRequest.ts` exports `useCancelRequest` (TanStack `useMutation`) which transitions a `pending` request to `cancelled` and writes `lastActor: { email, canonical }` so the Firestore rules' `lastActorMatchesAuth` integrity check passes. Refreshes the ID token before the write so a stale `canonical` claim from a 1-hour-old token is replaced. Confirmation flow uses the existing Phase 4 hand-rolled `Dialog`. On success, invalidates the `['kindoo', 'requests']` query key — the live listener already patches state, but invalidation triggers a refresh for the non-subscribed Audit Log query that may include the cancelled request.

### Nav rewire + role-default landings

`apps/web/src/components/layout/Nav.tsx` exposes role-aware links per the Phase 5 ship-set:

- **Manager:** Dashboard, All Seats, Audit Log, Access, My Requests
- **Stake:** Roster, Ward Rosters, My Requests
- **Bishopric:** Roster, My Requests

Multi-role users see the union with manager-priority ordering. `defaultLandingFor(principal)` in `apps/web/src/lib/routing.ts` updated:

- **manager** → `/manager/dashboard`
- **stake** → `/stake/roster` (Phase 5 leftmost; Phase 6 will re-front-load `/stake/new` per the spec's leftmost-tab rule)
- **bishopric** → `/bishopric/roster` (same Phase 6 follow-up)
- **no role in stake** → `/`, where the auth gate surfaces NotAuthorizedPage

Phase 6 needs to re-flip the stake/bishopric defaults back to `/stake/new` / `/bishopric/new` once those routes land. Worth a one-line note in the Phase 6 prompt.

### Hello placeholder deletion

`apps/web/src/routes/_authed/hello.tsx` removed; the `?p=hello` entry pruned from the `DEEP_LINK_TABLE` in `apps/web/src/lib/routing.ts`. Phase 4's placeholder no longer reachable.

### Shared roster primitive

`apps/web/src/components/roster/RosterCardList.tsx` (171 LoC) + colocated CSS (123 LoC) is the React port of the Apps Script `renderRosterCards` / `rosterCardHtml` stack. Consumed by every roster-shaped page (bishopric / stake / WardRosters / AllSeats). Preserves the row-feel visual density (no gap, shared border, tight padding) per the user's mid-Apps-Script-implementation feedback that cards "still need to look like table rows" — `.roster-card*` CSS family ported verbatim.

### E2E refresh

Phase 4's hello placeholder is gone, so the auth-flow + shell deep-link specs were updated to assert the real role-default landings. New `e2e/tests/seats/role-landing.spec.ts` covers per-role default landing, nav click-through within each role's link set, URL deep-link via `?p=mgr/seats`, and a 375 × 667 mobile viewport check on the manager Dashboard.

## Deviations from the pre-phase spec

Three architectural calls the web-engineer made that differ from the migration plan's letter, plus one small implementation-detail call worth recording.

- **MyRequests collapsed to one shared route** (`/my-requests`) instead of per-role variants. The migration plan implies a per-role page family in the bishopric / stake / manager sub-task lists, but `spec.md` §5.1 already calls MyRequests a shared template. All three nav blocks link to the single route; the page reads the principal and filters accordingly. Less code, faithful to the spec.
- **Audit Log JSON-pretty `<details>` block** instead of the Apps Script field-by-field diff table. The bespoke field-table renderer would need to be rewritten for the new query shapes — the new `member_canonical` filter introduces cross-collection rows (seats + access + requests under one query) where each entity has different fields. JSON-pretty form is honest for any document shape and was the lowest-cost path to a working Audit Log on Firebase. Tracked as **T-21** for a deliberate decision once Phase 11 cutover puts the Audit Log in front of an actual operator workflow; not bound to any phase.
- **Audit Log cursor-based pagination keyed on `timestamp`.** Firestore can't offset cheaply, so prev/next state is a stack of `Timestamp` cursors (`cursorStack`); pushing a cursor pages forward, popping pages back. Mid-history deep-linking isn't supported (e.g., a URL that lands the user on page 7 directly). Phase 6 follow-up if the workflow surfaces a real need.
- **shadcn `Dialog` and `Toast` not swapped.** Phase 4's hand-rolled versions wrap Radix Dialog and have green tests; canonical shadcn Tailwind classes would be a no-op behaviour change. Stays as-is.

## Decisions made during the phase

The load-bearing one is **T-21 — Audit Log diff rendering**. Three options on the table (keep JSON-pretty / hybrid: field-table for single-entity rows, JSON for cross-collection / port the full field-table form), filed unbound to any phase because nobody has used the Audit Log on real data on the new SPA yet. Decision blocker: real operator workflow at Phase 11 cutover. The `diffKeys` helper in `apps/web/src/features/manager/auditLog/summarise.ts` is isolated, so swapping is mechanical.

The MyRequests-shared-route decision is also worth flagging — it's defensible on the spec but cuts against a literal reading of the Phase 5 sub-task list. No new architecture D-number (the spec already covers it).

No new D-numbers earned beyond Phase 4's. The two patterns from Phase 3.5's D11 (sentinel-wrapped `{ value: T | undefined }` cache values, never-resolving `queryFn` for live subs) were exercised heavily across the seven feature folders without surprises.

## Spec / doc edits in this phase

`docs/spec.md` is **not** touched. Phase 5 is behaviour-preserving; `spec.md` describes Apps Script reality until Phase 11 cutover.

- `docs/architecture.md` — unchanged.
- `docs/firebase-migration.md` — unchanged (Phase 5 section already accurate; Phase 6 dependencies line already references Phase 5).
- `docs/firebase-schema.md` — unchanged. No schema or rule changes this phase.
- `docs/changelog/phase-5-read-side-pages.md` — this entry.
- `docs/TASKS.md` — T-18 closed in PR #9 body; T-21 opened in the final PR-#9 commit; T-07 status updated in this close commit (see "Deferred / follow-ups" below).

## Deferred / follow-ups

- **T-21 — Audit Log diff rendering decision.** Filed unbound to any phase; revisit after Phase 11 cutover puts the Audit Log in front of a real operator workflow.
- **Phase 6 default-landing re-flip.** Once `/stake/new` and `/bishopric/new` land in Phase 6, `defaultLandingFor` in `apps/web/src/lib/routing.ts` needs to re-front-load those routes per `spec.md`'s "leftmost nav tab" default-landing rule. Worth a one-line note in the Phase 6 prompt.
- **T-07 — Vite chunk-size warning.** Phase 4's TanStack Router autogen plugin with `autoCodeSplitting: true` already partially resolved the original warning. Phase 5's per-page chunks (each 2–7 KB) further fragment the bundle. The `schemas-*.js` chunk (~352 KB / ~106 KB gz) is now the residual outlier — that's the `@kindoo/shared` zod 4 schemas being bundled in their entirety per route that imports them. Not directly addressable without per-form schema imports, which Phase 6's forms can do (and which the Phase 6 prompt will expect). T-07 status flipped from "fixed by Phase 4" to "partially-resolved across Phase 4 + Phase 5; residual schemas-chunk for future per-form schema imports" in `docs/TASKS.md` as part of this changelog commit.

## Next

Phase 6 — write-side pages, request lifecycle. New Kindoo Request submit (bishopric + stake), manager approve / reject / complete, manual Access add/delete via the UI, and the default-landing re-flip for stake / bishopric. The shadcn primitive set, the role-aware Nav, the shared `RosterCardList`, the cancel-mutation pattern, and the typed-search-params validate-with-zod pattern are all ready for Phase 6 to reuse.
