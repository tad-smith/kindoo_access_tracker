# Tasks

Deferred work items surfaced in session but not yet scheduled into a chunk. These are NOT a chunk backlog (see `build-plan.md` for numbered chunks); they're smaller follow-ups and design questions the user has flagged. Check this file at the start of a session along with the other "start each session by reading" docs so ongoing work isn't dropped.

Format per task: a short imperative title, then **Why / what**, **Decisions to make before coding**, and **Files likely touched**. Mark completed tasks with `[DONE <date>]` and leave them in place for a while as trail, or prune once they're in a commit that's clearly shipped.

---

## 1. Preserve manually-inserted Access rows through imports [DONE 2026-04-23]

**Why / what.** The importer currently owns the entire `Access` tab — any row not produced by the current import run gets deleted (see `spec.md` §3.2 "Not manually edited" and §8 step 5). We want to support manual Access entries that survive imports, so a Kindoo Manager can grant app access to someone whose calling doesn't appear in the templates (or who doesn't hold a calling at all).

**What shipped.** Added `source` as a fourth column to the `Access` tab with values `'importer' | 'manual'`. The importer stamps every insert as `source='importer'` and scopes its delete-not-seen step to `source='importer'` rows only; `source='manual'` rows are invisible to the importer. The insert dedup check still considers ALL rows (regardless of source) so the importer will never create a duplicate composite-key row alongside an existing manual row — the B1 decision. Role resolution (`Auth_resolveRoles` → `Access_getByEmail`) is untouched: a manual row grants the same roles as an importer row.

The manager Access page grew write affordances: source badge column, Delete button on manual rows (rejected server-side for importer rows as defense in depth), and an "Add manual access" form at the bottom with email / scope dropdown / reason free-text. For manual rows the `calling` column holds a free-text reason (A1) rather than a literal calling name — same column, same composite PK, UI labels it "Reason".

Two new endpoints: `ApiManager_accessInsertManual(token, row)` and `ApiManager_accessDeleteManual(token, email, scope, calling)`. Both take `Lock_withLock`, write one AuditLog row with `actor_email = principal.email` (not `'Importer'`), and enforce their invariants: insert rejects composite-key collisions against any existing row; delete rejects non-manual rows with a clean error. Scope is validated against `Wards_getAll()` + `'stake'` on insert so a typo can't create an unreachable role grant.

**Migration.** Zero data-migration. The header bump to 4 columns causes a loud `Access header drift at column 4: expected "source", got "…"` error on first read after deploy. Operator adds `source` as column D header by hand. Existing rows' empty `source` cells map to `'importer'` via `Access_normaliseSource_` at the read boundary. Fresh installs (via `setupSheet`) get the 4-col header seeded directly.

**Decisions locked in.** A1 (free-text reason in the shared `calling` column), B1 (importer no-ops on PK collision with any existing row, preserving manual provenance), C1 (UI allows deleting manual rows only).

**Files touched.** `src/repos/AccessRepo.gs`, `src/services/Importer.gs`, `src/api/ApiManager.gs`, `src/ui/manager/Access.html`, `src/ui/Styles.html`, `src/services/Setup.gs`, `docs/spec.md` (§3.1 Access entry + §8 step 5), `docs/data-model.md` Tab 7, `docs/sheet-setup.md` Tab 7.

---

## 2. Convert wide tables to card layout [DONE 2026-04-23]

**Why / what.** The shared `renderRosterTable` helper in `src/ui/ClientUtils.html` renders narrow columns that wrap text across many lines on realistic data (long names, multiple buildings, long calling names, long audit diffs). Rework five pages to use a card-per-row layout similar to the manager Requests Queue.

**What shipped.** Added a sibling `renderRosterCards(rows, opts)` + `rosterCardHtml(row, opts)` to `src/ui/ClientUtils.html` with the same `opts` shape (`showScope` / `emptyMsg` / `rowActions` / `preview`) so page migrations were a one-line swap. Cards use a compact flex-row layout — badges + member + labeled chips + action strip sit inline on wide viewports, wrap onto a continuation line on narrow ones. The stack has NO gap between cards (shared bottom border, tight vertical padding) so the visual density matches a table row, per the "still look like table rows" constraint the user added mid-implementation.

Migrated four roster pages: `bishopric/Roster.html`, `stake/Roster.html`, `stake/WardRosters.html`, `manager/AllSeats.html`. Each was a one-line swap from `renderRosterTable` → `renderRosterCards` + drop the now-irrelevant `actionsHeader` opt.

Migrated `manager/AuditLog.html` inline: replaced its custom `<tr>`-based `rowHtml` with a `.audit-card` compact flex-row renderer. Kept the `<details>` expansion — it sits inside the card body as a full-width flex child (`flex: 0 0 100%`) so it wraps onto its own line when opened, matching the roster pattern.

**Kept `renderRosterTable` alive.** The five inline preview / duplicate-warning call sites on `manager/RequestsQueue.html` (4) and `NewRequest.html` (1) still use the table renderer. A compact table is less noisy than a nested card-inside-a-card when previewing a single row or a small duplicate-warning list inside an existing card. So `renderRosterTable` + `rosterRowHtml` + `.roster-table` CSS all remain in the codebase — the five primary pages just don't call them anymore.

**CSS cleanup.** Removed `.audit-row-diff`, `.audit-row-summary-inline`, `.audit-row-note` (superseded by `.audit-card-*` family) and dropped `.audit-log-table` / `.roster-table` from the mobile-breakpoint horizontal-scroll rule (cards flex-wrap natively).

**Decisions locked in.**
- Sibling helper (safer than replacing in-place); migrate page-by-page.
- Shared `rowActions` fn matches `renderRosterTable`'s API so callers swapping helpers don't reshape their per-row action wiring.
- AuditLog `<details>` survives inside the card — clicking "details" still reveals the before/after diff inline.
- Row-feel visual density (no gap, shared border, tight padding) per mid-implementation user clarification.

**Files touched.** `src/ui/ClientUtils.html` (new helper), `src/ui/Styles.html` (card CSS + cleanup), `src/ui/manager/AllSeats.html`, `src/ui/manager/AuditLog.html`, `src/ui/stake/Roster.html`, `src/ui/bishopric/Roster.html`, `src/ui/stake/WardRosters.html`.

---

## 3. Drop `ward_code` from All Seats summary cards [DONE 2026-04-23]

**Why / what.** The per-scope summary cards on the manager All Seats page currently display the `ward_code` alongside the ward name. The ward name alone is enough; the code is noise.

**What shipped.** The `scope-sub` line (rendering "ward_code: XX" for wards, "Stake" for the stake pool) is gone from `renderSummaries` in `src/ui/manager/AllSeats.html`; ward_name is the only per-scope label. The orphaned `.all-seats-summary-card .scope-sub` CSS rule was deleted from `src/ui/Styles.html` and the `.scope-label` rule's bottom-margin was bumped from 4px → 6px to keep the spacing to the utilization bar consistent. No server-side change — `summaries[].scope` still carries the ward code, just unused in the card.

**Files likely touched.** `src/ui/manager/AllSeats.html` (and check whether the code surfaces through `ApiManager_allSeats` / `services/Rosters.gs` vs. rendered client-side — the fix goes wherever the card template is).

---

## 4. Rename Config UI labels: calling templates → "Auto ... Callings" [DONE 2026-04-23 — UI labels only]

**Why / what.** On the manager Configuration page, the two calling-template section labels should read:
- "Ward Calling Template" → **"Auto Ward Callings"**
- "Stake Calling Template" → **"Auto Stake Callings"**

**What shipped.** UI-label-only rename in `src/ui/manager/Config.html` (not `Configuration.html` — the file is `Config.html`). The two `config-tab-btn` labels now read "Auto Ward Callings" / "Auto Stake Callings". The `label` argument that `renderTemplate` inlined into "No <label> template rows yet" / "Add a <label> calling" was removed (the new labels made those constructions awkward — "No Auto Ward Callings template rows yet"); the surrounding tab already names the template, so the empty-state now reads "No callings yet. Add one below." and the add-form heading reads "Add a calling." Sheet tab names (`WardCallingTemplate` / `StakeCallingTemplate`) and every server-side callsite (`Setup.gs`, `TemplatesRepo.gs`, `Importer.gs`) are untouched. Spec / data-model / sheet-setup docs still reference the existing tab names, which is consistent with a UI-only rename.

**Decisions made.**
- UI label only (the TASKS.md "safer default"). Full sheet-tab rename was not confirmed by the user and would have been a live-Sheet migration.
- If the user later wants the full rename: update `docs/spec.md` §3.1, `docs/data-model.md` section headings, `docs/sheet-setup.md` tab list, plus `src/services/Setup.gs`, `src/repos/TemplatesRepo.gs`, `src/services/Importer.gs` callsites.

**Files touched.** `src/ui/manager/Config.html` only.

---

## 5. Rebuild the Dashboard screen

**Why / what.** The manager Dashboard (the default landing for the `manager` role) needs a redesign. Today it's five cards per `spec.md` §5.3: pending-request counts, recent activity, per-scope utilization, over-cap warnings, and last-operations timestamps, all driven by a single `ApiManager_dashboard` rpc. The user has flagged this as wanting a rebuild; the *what* of the rebuild is still open.

**Decisions to make before coding.**
- Which cards stay, which go, and what replaces them. Is the goal more-dense (more signals per screen), less-dense (a focused "what needs attention right now" landing), or a different shape entirely (e.g., a feed of events rather than counts + bars)?
- New data the server needs to shape. The current dashboard is one round-trip; a rebuild that needs new aggregates (e.g., request-type breakdown over time, per-requester throughput, expiry forecast) might need additions to `ApiManager_dashboard` or a new endpoint.
- Interaction model. Today every tile deep-links into a filtered downstream page. Keep that pattern? Add inline drill-down / expand-in-place?
- Mobile layout. Current grid is `repeat(auto-fit, minmax(300px, 1fr))` and collapses to single-column at ≤ 640px. If the new design changes card size / count, confirm it still reads at ~375px.

**Files likely touched.** `src/ui/manager/Dashboard.html`, `src/api/ApiManager.gs` (`ApiManager_dashboard` aggregate + any new fields), `src/services/Rosters.gs` (if the new utilization view needs a different summary shape), `src/ui/Styles.html` (`.dashboard-*` rules), `docs/spec.md` §5.3, `docs/architecture.md` (the utilization-math section near the `Rosters_buildContext_` reuse note), and a changelog entry if the rebuild is substantial enough to warrant its own chunk.

---

## 6. Use OAuth to try and get rid of the Apps Script warning [DONE 2026-04-25 — addressed by Chunk 11 iframe wrapper]

The "warning" referred to the *"This application was created by a Google Apps Script user"* banner. Chunk 11 removed it via a different mechanism than the task originally framed: a static GitHub-Pages-hosted wrapper page at `https://kindoo.csnorth.org` containing a full-viewport iframe to the Main `/exec` URL, with `setXFrameOptionsMode(ALLOWALL)` on every `doGet` HtmlOutput permitting the embed. The top frame never loads Apps Script's banner-bearing outer wrapper page, so the banner is gone. See `docs/changelog/chunk-11-custom-domain.md`. OAuth verification submission to Google was not needed and remains optional — it could remove the first-time per-user consent prompt on the Identity project, which is a different concern from the banner.

---

## 7. Fix the remove button on Roster screens

---

# Firebase migration follow-ups

Tasks surfaced during the Firebase monorepo migration (Phases 1+). These follow the agent-spec `[T-NN]` format from `.claude/agents/docs-keeper.md` rather than the numbered Apps Script-era format above. Future migration follow-ups should be appended here in the same shape; pre-migration entries above are kept in their original style.

## [T-01] Reconcile `stamp-version.js` with workspace `version.ts` shape
Status: open
Owner: @backend-engineer (functions side) + @web-engineer (web side)
Phase: 1 → due before Phase 4 staging deploy

`infra/scripts/stamp-version.js` writes `VERSION` + `BUILT_AT`, but the Phase 1 workspace authors created `version.ts` files exporting `KINDOO_WEB_VERSION` / `KINDOO_FUNCTIONS_VERSION` per the migration-plan task spec. No runtime failure today because the stamper only runs at deploy time, which is itself blocked on T-03 (B1). Pick one of: (a) rename per-workspace `version.ts` → `buildInfo.ts` and update the stamper + tests + consumers to align with the existing stamper output, or (b) extend `stamp-version.js` to also emit the per-workspace `KINDOO_*_VERSION` constants. Settle before the first staging deploy under Phase 4 acceptance.

## [T-02] Document `firebase-tools` standalone-binary footgun in deploy runbook
Status: open
Owner: @infra-engineer
Phase: 1 → cross-cutting

The standalone pkg-bundled `firebase` binary at `/usr/local/bin/firebase` (282 MB; embedded old Node) cannot `require()` ESM packages, so `firebase emulators:exec` breaks any ESM script (e.g., Vitest 2.x). The npm-installed firebase-tools is a small Node shim and works. Add a warning section to `infra/runbooks/deploy.md` (and any local-dev runbook the operator follows) telling operators to install firebase-tools via npm and to never `pnpm install -g firebase-tools` with sudo (corrupts `~/.npm`).

## [T-03] Operator setup B1 — Firebase projects, billing, service accounts, IAM
Status: done (2026-04-28)
Owner: @tad
Phase: 1 → due before Phase 4 staging deploy

Real Firebase project creation, billing enablement, service-account provisioning, and IAM. Deferred during Phase 1 by the operator. Blocks the first staging deploy that exercises Phase 1 acceptance criteria; does not block local-emulator dev, which is why Phase 1 closed without it. Spec: `docs/firebase-migration.md` B1.

End-to-end runbook now lives at `infra/runbooks/provision-firebase-projects.md` — click-by-click coverage of both projects (staging then prod), Blaze upgrade + budget alert, all 14 services, Firestore region, Auth + Google sign-in, the `kindoo-app` SA + the default compute SA's IAM bindings, the prod-only PITR enablement, the prod-only weekly Firestore export to a 90-day-lifecycle bucket, plus end-to-end verification commands and a troubleshooting section. Estimated ~90 min for a first-time operator. Mark this task DONE once walked.

Closed 2026-04-28: operator successfully walked `infra/runbooks/provision-firebase-projects.md` end-to-end against both staging and prod projects.

## [T-04] Operator setup B2 — domain registration + Resend domain verification
Status: open
Owner: @tad
Phase: 1 → due before Phase 9

Domain `stakebuildingaccess.org` chosen 2026-04-27 (per F17). Resend chosen as the email vendor (per F16). Operator work: register the domain at any registrar (~$10/year), then verify it in Resend's dashboard (DKIM CNAME + DMARC TXT records added at the registrar's DNS panel; ~5–60 min DNS propagation). Doesn't block Phase 1 emulator-local work; needed before Phase 9 ships email triggers in earnest. Spec: `docs/firebase-migration.md` B2 + F16 + F17.

## [T-05] Operator setup B4 — LCR Sheet sharing protocol for importer
Status: done (2026-04-28)
Owner: @tad
Phase: 1 → due before Phase 8

Grant view access on the LCR callings sheet to the importer service account that lands with Phase 8. Doesn't block earlier phases. Spec: `docs/firebase-migration.md` B4.

Closed 2026-04-28: the importer service account that lands with Phase 8 will have view access to the LCR callings sheet.

## [T-06] Restart Claude Code so named engineering agents become dispatchable
Status: done (2026-04-28)
Owner: @tad
Phase: 1 → cross-cutting

The new `.claude/agents/{web-engineer,backend-engineer,infra-engineer,docs-keeper}.md` definitions plus the Definition-of-Done update only load at session start. Until Tad restarts Claude Code, the Agent tool can't dispatch them by name (Phase 1's parallel agents had to use `general-purpose`). Phase 2 onward expects the named agents.

Closed 2026-04-28: the named agents (`web-engineer`, `backend-engineer`, `infra-engineer`, `docs-keeper`) have been dispatched repeatedly across Phases 2 / 3 / 3.5 / 4 — proven dispatchable.

## [T-07] Vite `apps/web` chunk-size warning >500 KB
Status: partially-resolved (Phase 4 close, 2026-04-28)
Owner: @web-engineer
Phase: 1 → revisit in Phase 5

Phase 4 wired the `@tanstack/router-plugin/vite` autogen plugin with `autoCodeSplitting: true`, so per-route components ship as separate chunks. Post-Phase-4 build output: main `index-*.js` ~293 KB / 92 KB gz, route chunks `_authed-*.js` ~5 KB, `hello-*.js` ~1 KB. The `schemas-*.js` chunk (the `@kindoo/shared` zod-4 schemas) is now the >500 KB outlier at ~352 KB / 106 KB gz. Phase 5 onwards adds real pages that import only the schemas they need — once enough pages exist, the per-page code-split will naturally fragment the schemas chunk too. Worth revisiting Phase 5 close to confirm. No action required during Phase 4 close.

## [T-08] Consolidate web-side `principal.ts` onto `@kindoo/shared`
Status: done (2026-04-28)
Owner: @web-engineer
Phase: 2

`packages/shared/src/principal.ts` exports `principalFromClaims(claims, typedEmail): Principal` plus the `CustomClaims` / `Principal` / `StakeClaims` types from `packages/shared/src/types/auth.ts`. Backend-engineer's Phase 2 work (sync triggers + onAuthUserCreate) builds against these. The web-engineer's parallel Phase 2 work currently has its own `apps/web/src/lib/principal.ts` + `principal-derive.ts`; before Phase 2 closes, consolidate by importing `principalFromClaims` and the types from `@kindoo/shared`, so the SPA's `usePrincipal()` hook and the trigger code use the same derivation. Catches the common drift surface where claims-shape changes accidentally only land on one side.

Closed 2026-04-28: `apps/web/src/lib/principal-derive.ts` imports `CustomClaims`, `Principal`, and `principalFromClaims` from `@kindoo/shared`; the local module re-exports the shared types and decorates the shared `Principal` with web-only helpers (`firebaseAuthSignedIn`, `hasAnyRole`, `wardsInStake`). The derivation logic itself is sourced from `@kindoo/shared`, matching the trigger code.

## [T-09] Add `hosting.predeploy` hook to `firebase.json`
Status: done (2026-04-28, Phase 2 close)
Owner: @infra-engineer
Phase: cross-cutting

`firebase.json` has no `hosting.predeploy` to rebuild `apps/web/dist` automatically before `firebase deploy --only hosting`. The Functions side has a predeploy hook (esbuild bundle); Hosting does not. Today the operator must remember to run `pnpm --filter @kindoo/web build` before each Hosting deploy or stale assets ship. Add a `hosting.predeploy` entry that runs the build, mirroring the Functions hook. Polish pass; not deploy-blocking.

Closed 2026-04-28: `firebase.json` `hosting.predeploy` is `["pnpm --filter @kindoo/web build"]`, matching the Functions predeploy hook shape.

## [T-10] Document Firebase Hosting "Get Started" console step in B1 runbook
Status: done (2026-04-28, Phase 2 close)
Owner: @infra-engineer
Phase: cross-cutting

`gcloud services enable firebasehosting.googleapis.com` enables the API but does not provision a default Hosting site for serving — the operator must click "Get Started" once in the Firebase Hosting console after first deploy or the deployed URL 404s. Surfaced on the first Phase 2 staging deploy. `infra-engineer` is updating `infra/runbooks/provision-firebase-projects.md` in parallel with this Phase 2 close commit.

Closed 2026-04-28: `infra/runbooks/provision-firebase-projects.md` contains the Hosting "Get Started" wizard step in both the staging and production walkthroughs.

## [T-11] Document the esbuild-bundling deploy approach for Cloud Functions
Status: open
Owner: @docs-keeper
Phase: cross-cutting

Cloud Build's `npm install` cannot resolve pnpm's `workspace:*` protocol, so `@kindoo/shared` as a workspace dep blocks Cloud Functions deploy. Phase 2 worked around this with esbuild bundling: `functions/scripts/build.mjs` bundles `@kindoo/shared`'s source into `functions/lib/index.js` and writes a clean `functions/lib/package.json` containing only real npm deps; `firebase.json`'s `functions.source` points at `functions/lib`. This is architecturally significant — the workaround shape (clean `lib/package.json` + symlinked `node_modules` for the local emulator) is non-obvious and easy to break. Document it in `infra/CLAUDE.md` and consider promoting to a numbered architecture decision (next D-number) so future agents don't re-derive the trap. See the Phase 2 changelog "Deviations" section for the full rationale.

## [T-12] Document failed-deploy half-state recovery in B1 runbook
Status: done (2026-04-28, Phase 2 close)
Owner: @infra-engineer
Phase: cross-cutting

A failed first-deploy attempt can leave Cloud Functions in a half-registered state where the platform sees a function as an HTTPS function even though the source declares it as a Firestore-document trigger. Symptom: subsequent deploys fail with a trigger-type-mismatch error. Recovery: `firebase functions:delete <name>` against the affected functions, then redeploy. Add a troubleshooting entry to `infra/runbooks/provision-firebase-projects.md`.

Closed 2026-04-28: `infra/runbooks/provision-firebase-projects.md` covers the half-state recovery via `firebase functions:delete <function-names...>` followed by redeploy.

## [T-13] `STAKE_IDS` hardcoded to `['csnorth']` in functions
Status: open
Owner: @backend-engineer
Phase: 12

`functions/src/lib/constants.ts` exports `STAKE_IDS = ['csnorth']` and `seedClaimsFromRoleData` walks this list when seeding claims for brand-new users on first sign-in. The `syncAccessClaims` / `syncManagersClaims` triggers extract `stakeId` from the doc path directly, so they are stake-ID-agnostic; only the seed path is hardcoded. Implication: if the v1 stake's actual document ID isn't `csnorth`, new users will sign in cleanly but won't get claims seeded automatically — operators can work around by manually editing a `kindooManagers` doc to fire the sync trigger. Phase 12 (multi-stake) makes this dynamic by deriving the list at runtime.

## [T-14] Local Node 20 vs production Node 22 mismatch produces emulator warning
Status: done (2026-04-28, Phase 3.5 close)
Owner: @infra-engineer
Phase: 3.5

Resolved by pinning Node 22 project-wide. Root `package.json` carries `"volta": { "node": "22.22.2" }` so Volta auto-installs and resolves the right Node when the operator (or any contributor with Volta) `cd`s into the repo. `.nvmrc` (`22`) covers nvm/fnm contributors as defense-in-depth. `.npmrc` adds `engine-strict=true` so npm/pnpm refuses to install on a mismatched runtime. Root `engines.node` bumped from `>=20` to `>=22`. Functions still pin `engines.node: "22"` (matches Cloud Functions v2 runtime). Emulator no longer emits the version-mismatch warning. Closed at Phase 3.5 close — see `docs/changelog/phase-3-5-infra-refresh.md`.

## [T-15] Configure Firestore TTL on auditLog collection-group
Status: open
Owner: @infra-engineer (operator runs gcloud) + @tad
Phase: 3 → due before Phase 8 importer ships (or any earlier deploy that writes auditLog rows)

`firebase-schema.md` §5.2 specifies a 365-day TTL on `auditLog.ttl`, configured once via `gcloud` per project. Firestore TTL policies are not declared in source — they're a project-level configuration applied via:

```
gcloud firestore fields ttls update ttl \
  --collection-group=auditLog \
  --enable-ttl \
  --project=<staging-project>
```

Repeat for the production project. Optionally also for `platformAuditLog` (Q20 — defaulted 365 days, may warrant longer for superadmin records). Add the command to `infra/runbooks/provision-firebase-projects.md` under a "Phase 3 — TTL configuration" subsection.

Note for `infra-engineer`: the rules + indexes are in source as of Phase 3 close (`firestore/firestore.rules`, `firestore/firestore.indexes.json`); only TTL is a console / gcloud step. The Phase 3 changelog flags this as deferred.

## [T-16] Web-side typed-doc helper (`apps/web/src/lib/docs.ts`)
Status: done (2026-04-28, Phase 4 close)
Owner: @web-engineer
Phase: 4

`firebase-migration.md` Phase 3 §"Per-doc shape verification" calls for a thin typed-doc-helper layer in `apps/web/src/lib/docs.ts` that exports typed `doc(...)` and `collection(...)` references with the correct path for each collection. Shipped in Phase 4: `apps/web/src/lib/docs.ts` exports `<Entity>Ref(stakeId, id)` and `<entities>Col(stakeId)` for every collection in `firebase-schema.md` §§3–4 (UserIndex, PlatformSuperadmin, PlatformAuditLog, Stake, Ward, Building, KindooManager, Access, Seat, Request, WardCallingTemplate, StakeCallingTemplate, AuditLog) using `withConverter` against the shared types in `@kindoo/shared`. First consumer lands in Phase 5.

## [T-17] Switch to TanStack Router autogen plugin once Node 20.11+ is on dev machines
Status: done (2026-04-28, Phase 4 close)
Owner: @web-engineer
Phase: 4

Phase 4 originally planned to ship TanStack Router via a hand-rolled `apps/web/src/routeTree.ts` because the `@tanstack/router-plugin/vite` autogen plugin's transitive `unplugin@3` dependency reads `import.meta.dirname` at module-load time, which is `undefined` under Node 20.9.0 (added in 20.11). T-14 (Node 22 pin) closed in Phase 3.5 unblocked this. Done at Phase 4 close: `TanStackRouterVite({ routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts', autoCodeSplitting: true })` is wired into `apps/web/vite.config.ts`; per-route modules use the autogen-friendly `Route = createFileRoute('/path')({...})` form; the hand-rolled `src/routeTree.ts` is gone; `main.tsx` imports from `./routeTree.gen`. `src/routeTree.gen.ts` is generated by the plugin on every dev/build, committed for stable typecheck-without-build, and excluded from prettier via `apps/web/.prettierignore`. Bundle is now route-code-split: `_authed` and `hello` ship as separate chunks (`_authed-*.js` ~5KB, `hello-*.js` ~1KB) plus the main `index-*.js` (~293KB) and the shared schemas chunk (~352KB). Resolves T-07 (>500KB chunk warning) implicitly.

## [T-18] Tailwind + shadcn-ui install for Phase 5+ pages
Status: open
Owner: @web-engineer
Phase: 5 → before first real page form

Phase 4 deferred Tailwind setup and the shadcn-ui CLI bootstrap because the shell + dialog primitives could be done with plain CSS + Radix Dialog (which is already shadcn-ui's underlying primitive). Phase 5+ pages will benefit from Tailwind's utility classes for form layout density and from shadcn-ui's pre-built `Button` / `Input` / `Select` / `Checkbox` / `Toast` components. Bootstrap path:

1. `pnpm --filter @kindoo/web add -D tailwindcss postcss autoprefixer` and run `npx tailwindcss init -p`.
2. Configure `tailwind.config.js` to scan `src/**/*.{ts,tsx}` and to define the design tokens from `src/styles/tokens.css` as Tailwind theme colors (so existing component CSS keeps working alongside utility classes).
3. `npx shadcn-ui@latest init` then `npx shadcn-ui add button input select checkbox dialog toast` — copies into `src/components/ui/`. Replace the hand-rolled `Toast.tsx` and `Dialog.tsx` with the shadcn copies (the shadcn Dialog wraps Radix Dialog + adds Tailwind classes; behaviour is identical so the Phase 4 callers don't change).
4. The hand-rolled CSS in `src/lib/render/*.css` and `src/components/layout/*.css` stays — it's shell-level styling that Tailwind utilities don't replace cleanly.

Defer-rationale: shadcn-ui requires Tailwind, and the Phase 4 acceptance criteria didn't need utility classes. Adding both at the same time as Phase 5's first real page is cleaner than splitting across phases.

## [T-19] Refresh stale caret-floor pins across workspaces
Status: open
Owner: @infra-engineer
Phase: cross-cutting

A 2026-04-28 dependency audit found several caret floors lagging current by many minors: `firebase-admin ^13.0.2` (latest 13.8.0), `@playwright/test ^1.49.1` (latest 1.59.1), `@tanstack/react-router ^1.95.5` and `@tanstack/router-plugin ^1.95.5` (latest 1.168.x / 1.167.x), `@tanstack/react-query ^5.62.10` (latest 5.100.x), plus smaller drift on `prettier`, `vite`, `jsdom`, `concurrently`, `@vitejs/plugin-react`, `@testing-library/*`, `firebase-functions-test`, `zod`. Carets would catch these on a fresh install but the lockfile holds. Bump the floors and refresh `pnpm-lock.yaml` in one pass; one PR, all workspaces. Separate concern: **`@google/clasp ^2.4.2` is in the affected range for CVE-2026-4092** (path traversal → arbitrary file write); bump to `^3.3.0` and verify push/deploy scripts still work — clasp 3.x is a major. Track that bump under this task or split it out, operator's choice. Hold `@types/node` at `^22` deliberately to track the Node 22 runtime; if upgraded, leave a comment noting the deliberate pin. Out of scope: TypeScript / Vite / Vitest / Firebase / esbuild, all already at-latest.

## [T-20] Bundle THIRD_PARTY_LICENSES artifact in production build
Status: open
Owner: @infra-engineer
Phase: 11 (cutover) → due before public DNS flip

Apache-2.0 dependencies in the production bundle (TypeScript, firebase, firebase-admin, @google/clasp, @playwright/test, @firebase/rules-unit-testing) require preserving the LICENSE + NOTICE text in the distributed artifact. MIT deps require preserving the copyright + license notice. Today nothing in the Hosting build assembles this. Add a build step (e.g., `pnpm-licenses` / `license-checker-rseidelsohn` / similar) that emits `apps/web/dist/THIRD_PARTY_LICENSES.txt` covering every runtime dep in the SPA bundle, and surface a link from a footer or About page so users can find it. Functions side does not ship to end-users so no equivalent artifact is needed. Verify the build runs in CI and the file is non-empty before Phase 11 close.
