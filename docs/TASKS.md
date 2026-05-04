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
Status: done (2026-04-28)
Owner: @infra-engineer
Phase: 1 → due before Phase 4 staging deploy

`infra/scripts/stamp-version.js` wrote `VERSION` + `BUILT_AT`, but the Phase 1 workspace authors created `version.ts` files exporting `KINDOO_WEB_VERSION` / `KINDOO_FUNCTIONS_VERSION` per the migration-plan task spec. The mismatch surfaced when the operator ran `pnpm deploy:staging` for the first time: the stamper clobbered the placeholder files and `pnpm typecheck` failed because Shell.tsx, version.test.ts, functions/src/index.ts, and functions/src/index.test.ts all imported the per-workspace named constants.

Closed 2026-04-28 (option b): `infra/scripts/stamp-version.js` now emits per-workspace named exports — `KINDOO_WEB_VERSION` + `KINDOO_WEB_BUILT_AT` for `apps/web/src/version.ts`, `KINDOO_FUNCTIONS_VERSION` + `KINDOO_FUNCTIONS_BUILT_AT` for `functions/src/version.ts`. Consumer-side files unchanged. See PR #fix/t-01-version-stamper-shape.

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
Status: done (2026-05-02)
Owner: @tad
Phase: 1 → due before Phase 9

Domain `stakebuildingaccess.org` chosen 2026-04-27 (per F17). Resend chosen as the email vendor (per F16). Operator work: register the domain at any registrar (~$10/year), then verify it in Resend's dashboard (DKIM CNAME + DMARC TXT records added at the registrar's DNS panel; ~5–60 min DNS propagation). Doesn't block Phase 1 emulator-local work; needed before Phase 9 ships email triggers in earnest. Spec: `docs/firebase-migration.md` B2 + F16 + F17.

Closed 2026-05-02: domain `mail.stakebuildingaccess.org` registered and Resend confirmed verification (DKIM CNAME + DMARC TXT records propagated). Phase 9 (email triggers via Resend) is unblocked.

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
Status: partially-resolved across Phase 4 + Phase 5 (2026-04-28); residual schemas-chunk for future per-form schema imports
Owner: @web-engineer
Phase: 1 → revisit when Phase 6 forms land

Phase 4 wired the `@tanstack/router-plugin/vite` autogen plugin with `autoCodeSplitting: true`, so per-route components ship as separate chunks. Phase 5 added seven feature folders, each landing as its own per-page chunk (2–7 KB), which further fragmented the bundle. Post-Phase-5 build output: main `index-*.js` is now in the 90–100 KB gz range (down from Phase-4-close's 92 KB but with substantially more app surface inside it), per-page route chunks 2–7 KB each, and the `schemas-*.js` chunk holds steady around ~352 KB / ~106 KB gz.

The `schemas-*.js` chunk is now the residual outlier — it's the `@kindoo/shared` zod 4 schemas being bundled in their entirety per route that imports them. Not directly addressable without per-form schema imports: each form pulls only the schemas it actually validates against, rather than the whole `@kindoo/shared` schema barrel. Phase 6's write-side forms (New Kindoo Request, manager approve / reject / complete, manual Access add/delete) are the natural place to introduce that pattern — they're the first phase that materially exercises the schemas chunk for forms rather than as a transitive read-side dep.

Revisit at Phase 6 close to confirm whether per-form schema imports actually shrank `schemas-*.js`. If the residual stays in the 100 KB gz range after per-form imports land, the pragmatic close is to bump Vite's `build.chunkSizeWarningLimit` past the current 500 KB default rather than chase further fragmentation.

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
Status: done (2026-04-29)
Owner: @infra-engineer (operator runs gcloud) + @tad
Phase: 3 → due before Phase 8 importer ships (or any earlier deploy that writes auditLog rows)

Closed 2026-04-29: operator configured Firestore TTL on the `auditLog` collection-group on both staging and production projects via `gcloud firestore fields ttls update ttl --collection-group=auditLog --enable-ttl`. The optional `platformAuditLog` TTL remains at the operator's discretion.

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
Status: done (2026-04-28, Phase 5 close)
Owner: @web-engineer
Phase: 5

Bootstrap path took the Tailwind v4 route (no `tailwind.config.js`; CSS-driven `@theme` block in `apps/web/src/styles/tailwind.css`) which is the current upstream-recommended setup.

Shipped:

1. `tailwindcss@^4` + `@tailwindcss/vite@^4` added to `@kindoo/web` devDeps; the Vite plugin wires CSS scanning automatically (no `content: [...]` glob needed). `apps/web/vite.config.ts` adds the `tailwindcss()` plugin alongside the existing TanStack Router + React plugins.
2. `apps/web/src/styles/tailwind.css` declares a `@theme` block mirroring the design tokens from `tokens.css` so utility classes (`bg-kd-primary`, `text-kd-fg-1`, etc.) compose with the existing component CSS without duplicating values. Imported once from `main.tsx`.
3. shadcn-ui primitives copy-pasted into `apps/web/src/components/ui/`: Button, Badge, Card (+ CardHeader / CardTitle / CardContent / CardFooter), Input, Select, Skeleton. These wrap Radix Slot / use the existing `.btn` family from `base.css` so visual parity with the Apps Script app is preserved while the API surface follows shadcn convention (forwardRef, `asChild`, variant props).
4. Hand-rolled `Dialog.tsx` and `Toast.tsx` from Phase 4 stay — they already wrap Radix Dialog and have working tests. Swapping to canonical shadcn Tailwind classes would be a no-op behaviour change; deferred until / unless a future need surfaces.
5. `apps/web/src/lib/cn.ts` adds the `cn()` utility (clsx + tailwind-merge) every shadcn primitive uses.

Bundle delta: production CSS grew from ~2 kB to ~17 kB (the Tailwind utility output for the classes used by the Phase 5 pages); JS is unchanged because `cn` and Radix Slot are tree-shaken into the existing chunks.

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

## [T-21] Decide Audit Log diff rendering: JSON-pretty `<details>` vs field-by-field diff table
Status: done (2026-04-29)
Owner: @web-engineer
Phase: not bound to any phase

Closed 2026-04-29 via PR `feat/audit-log-field-diff` — operator picked **option 3** (port the full Apps Script field-table form). The JSON-pretty `<details>` block is gone; the expansion now renders a Field / Before / After table sourced from a new `computeFieldDiff(before, after)` helper sitting next to the existing `diffKeys` in `apps/web/src/features/manager/auditLog/summarise.ts`. Three header shapes (create / update / delete) plus an "(empty payload)" placeholder; only changed fields appear; an unchanged-fields trailer surfaces the count so the reader knows the table isn't truncated. Cross-collection rows (`member_canonical`-filtered view) render transparently because the helper walks each row's own `before` ∪ `after` keys with no per-entity branching. Special-cased value rendering: ISO-timestamp strings + Firestore Timestamps fold to `YYYY-MM-DD HH:MM:SS UTC`, primitive arrays render comma-separated, nested maps / arrays fall back to JSON, nullables render as `(empty)`, fields absent on the other side render `(absent)` and tag the cell muted. Comprehensive unit tests in `summarise.test.ts` and `AuditDiffTable.test.tsx`.

**Original options memo (preserved as trail):**

- **JSON-pretty form.** Faithful to the data. Handles cross-collection rows cleanly because JSON renders any document shape. Less scannable for a single-entity audit row where the operator wants to see "calling: 'X' → 'Y'" at a glance.
- **Field-by-field form (Apps Script reality).** More readable for canonical seat/access/request changes. Gets awkward for cross-collection rows because each entity has different fields. The Apps Script app handled this by limiting the audit log to per-collection views.

Phase 5 went with JSON-pretty because (a) the new `member_canonical` filter introduced cross-collection views per the migration plan, (b) the bespoke field-table renderer would need to be rewritten for the new query shapes, (c) JSON was honest for any shape. Operator's verdict on real data: "the new diffing logic sucks." Picked option 3.

**Files touched:** `apps/web/src/features/manager/auditLog/summarise.ts`, `apps/web/src/features/manager/auditLog/AuditDiffTable.tsx` (new), `apps/web/src/features/manager/auditLog/AuditLogPage.tsx`, `apps/web/src/features/manager/auditLog/summarise.test.ts` (new), `apps/web/src/features/manager/auditLog/AuditDiffTable.test.tsx` (new), `apps/web/src/features/manager/auditLog/AuditLogPage.test.tsx`, `apps/web/src/styles/pages.css`.

## [T-22] Bootstrap-wizard rules: allow bootstrap-admin writes when `setup_complete=false`
Status: open
Owner: @backend-engineer
Phase: 7 (current — was discovered during Phase 7 wizard wiring)

The Phase 7 bootstrap wizard (in `apps/web/src/features/bootstrap/`) writes to:

- `stakes/{sid}/kindooManagers/{canonical}` — auto-adds the bootstrap admin on first wizard load.
- `stakes/{sid}` parent doc — Step 1 (stake_name, callings_sheet_id, stake_seat_cap) and the final `setup_complete=true` flip.
- `stakes/{sid}/buildings/{slug}` — Step 2.
- `stakes/{sid}/wards/{ward_code}` — Step 3.

The current rules (firestore/firestore.rules) gate every one of these writes on `isManager(stakeId)` — but the bootstrap admin doesn't yet hold a manager claim until the `syncManagersClaims` trigger fans the auto-added kindooManagers doc into a custom claim. That auto-add itself requires a write to kindooManagers, which the rule denies. **Chicken-and-egg.**

Two clean ways out — backend-engineer's call:

1. **Add a bootstrap-admin escape hatch** keyed off the parent stake doc:
   ```
   function isBootstrapAdmin(sid) {
     let stake = get(/databases/$(database)/documents/stakes/$(sid));
     return isAuthed()
       && stake.data.setup_complete == false
       && stake.data.bootstrap_admin_email == request.auth.token.email;
   }
   ```
   Add `|| isBootstrapAdmin(stakeId)` to the write predicate on every collection the wizard touches. Note the `setup_complete=false` clause makes this strictly time-bounded: once the wizard flips that field, the predicate goes silent and the manager claim (already minted by `syncManagersClaims` after the auto-add) takes over.

2. **Wrap wizard writes in a Cloud Function** (`runBootstrapWizardStep` callable). Functions bypass rules via Admin SDK; the callable verifies `auth.email == stake.bootstrap_admin_email && stake.setup_complete == false`. Keeps the rules clean but adds a network round-trip per step.

Either fix needs the **one-shot wizard** invariant from `firebase-migration.md` Phase 7: every wizard mutation has a rule-level (or callable-level) check that `stake.setup_complete === false`. Once flipped, the wizard's writes are denied. Phase 7 acceptance test: hand-crafted POST after `setup_complete=true` is denied.

Tests to add (in `firestore/tests/`):
- Bootstrap admin write to kindooManagers when `setup_complete=false` → allowed.
- Bootstrap admin write to kindooManagers when `setup_complete=true` → denied.
- Non-admin authed user write to any wizard-managed collection during bootstrap → denied.
- Bootstrap admin write to stake doc (`setup_complete: true`) is allowed and is a one-way flip (subsequent `setup_complete: false` write by bootstrap admin alone is denied — they need to be a manager for that, which they are post-flip via the kindooManagers auto-add).

The web side is already wired to fail gracefully (each wizard mutation surfaces server errors as toast), so this is purely a server-side gap. Phase 7 SPA pushed the UI against a bare staging env in good faith; once the rules update lands, a fresh `setup_complete=false` stake walks through the wizard end-to-end.

## [T-23] Bootstrap wizard: silent delete failures + 6 small UX issues from staging [DONE 2026-04-28]
Status: done
Owner: @web-engineer

Operator surfaced 7 issues during manual staging of the bootstrap wizard. Shipped in `fix/bootstrap-wizard-issues`:

- **Building / ward / manager delete failed silently.** Root cause: `firestore.rules` used `allow write: if … && lastActorMatchesAuth(request.resource.data)` for wards / buildings / kindooManagers. On delete, `request.resource.data` doesn't exist, so the integrity check evaluated false and the delete was denied. Optimistic-update reverted on the next snapshot; toast wasn't surfacing because the wizard's `.catch` chain only ran on a thrown error and the rule denial was thrown but the toast wiring was correct — verified during repro. Fix: split the three match blocks into `allow create, update: if (…) && lastActorMatchesAuth(request.resource.data)` plus a separate `allow delete: if (…)` predicate without the integrity check (no resource data to check). Added 4 tests in `firestore/tests/bootstrap.test.ts` covering delete-allowed during setup + delete-denied post-setup. Audited every wizard mutation hook to confirm `onError`/`.catch` surfaces the error message via `toast(..., 'error')` — already correct.
- **Configuration → Managers + wizard Step 4 had a stray "Active" checkbox.** Removed both. New managers default `active: true` on doc create. Schema field retained (claim-sync trigger keys off it; Configuration deactivate / activate row buttons remain).
- **"Deactivate" on bootstrap admin row was a no-op.** Bootstrap admin can't be deactivated (would lock themselves out). Hid both the deactivate and the delete buttons on the bootstrap admin row.
- **Step indicator restyled.** Chevron-arrow stepper with labels-only (no numbers); steps turn green when their validation passes, neutral otherwise, ring-highlighted for the current step. Hand-rolled with Tailwind utilities + a CSS-triangle chevron — ~50 lines, no shadcn-ui stepper primitive needed.
- **"Complete Setup" disabled with no indication.** Helper text below the button lists which prerequisites are missing (e.g., "Add at least one building").

## [T-24] Audit-and-fix unscoped `qc.invalidateQueries()` calls (DIY-hook placeholder-queryFn footgun)
Status: open
Owner: @web-engineer
Phase: cross-cutting

The DIY Firestore hooks (`useFirestoreDoc`, `useFirestoreCollection`) at `apps/web/src/lib/data/` use a never-resolving placeholder `queryFn` so `onSnapshot` is the source of truth for cache writes (per architecture D11). Side-effect: `qc.invalidateQueries()` (no args, or any keyset that matches a live-listener entry) returns a Promise that never resolves, because TanStack awaits the matched queries' refetches and the placeholder `queryFn` never settles. Mutations that `await` the invalidate via `onSuccess` chain hang forever — `mutateAsync` never resolves → `mutation.isPending` stays `true` → the submit button reads "Adding…" until the page is refreshed.

Two fix paths:

1. **Audit + `void`** every callsite. Convert `onSuccess: () => qc.invalidateQueries()` (returns the promise) into `onSuccess: () => { void qc.invalidateQueries(); }` (fire-and-forget). Targeted invalidations keyed away from the DIY-hook prefix (`['kindoo', 'requests']`, etc.) are already safe because they don't match the live-listener cache keys.
2. **Replace the placeholder.** Rewrite the DIY hooks' `queryFn` to resolve immediately to the cached value (or a sentinel-undefined wrapper). More invasive — the current shape relies on the never-resolving promise for state-machine reasons documented in `useFirestoreDoc.ts` — but eliminates the footgun structurally.

PR #29 applied (1) selectively to mutations in `features/manager/configuration/`, `features/manager/access/`, `features/manager/allSeats/`, and `features/bootstrap/`. The rest of the codebase remains potentially affected — anywhere a future engineer writes `onSuccess: () => qc.invalidateQueries()` in expression-arrow form will reproduce the hang. A repo-wide audit (lint rule? grep + manual review?) plus the option-(2) refactor are both still open.

Surfaces this footgun: the screenshot trail in PR #29 ("Add manual access" stuck on Adding…) is the canonical reproduction.

## [T-25] E2E coverage for `runImportNow` and `installScheduledJobs` callables
Status: open
Owner: @infra-engineer (e2e setup) + @web-engineer (specs)
Phase: 8 → cross-cutting

The Phase 8 §1094 spec ("Manager clicks 'Import Now' → status updates → over-cap banner appears + clears on next clean run") is partially covered: the integration tests in `functions/tests/` exercise the callable's logic, and unit tests in `apps/web/src/features/manager/import/` cover the SPA mutation hook + the page's loading / success / error / banner states. The live-callable e2e is unwritten because Playwright's setup currently boots only the Auth + Firestore emulators, not the Functions emulator.

**Scope:** wire the Functions emulator into Playwright's `globalSetup`; write the §1094 e2e plus a sibling for `installScheduledJobs` (the bootstrap wizard's "Complete Setup" path that should idempotently install Cloud Scheduler jobs).

## [T-26] Phase 11 SA hardening pass
Status: open
Owner: @infra-engineer (verify SA roles, deploy) + @backend-engineer (function options)
Phase: 11

Pin the remaining Cloud Functions (audit fan-in × 9, claim sync × 4, `onAuthUserCreate`, `installScheduledJobs`, `removeSeatOnRequestComplete`) to `kindoo-app@` for single-identity audit traces and to allow revoking the project-default `roles/editor` from the default compute SA. Phase 8 pinned only the four Sheets-touching functions (`runImporter`, `runExpiry`, `reconcileAuditGaps`, `runImportNow`) because the LCR sheet is shared with `kindoo-app@` and the importer was 403'ing on the default compute SA; the rest stayed on default to defer the IAM review to cutover.

**Pre-req:** confirm via `gcloud projects get-iam-policy` that `roles/editor` is still bound to `<projectnum>-compute@developer.gserviceaccount.com`, and that `kindoo-app@` has the roles needed for Auth Admin SDK calls (claim-sync triggers + `onAuthUserCreate` write `customClaims` + revoke refresh tokens; `removeSeatOnRequestComplete` writes Firestore; the audit fan-in functions write Firestore; `installScheduledJobs` creates Cloud Scheduler jobs).

## [T-27] Replace placeholder SBA monogram favicon + brand-bar icon with final designed mark before public launch
Status: open
Owner: @web-engineer (wire), blocked on operator-supplied design
Phase: pre-launch (post Phase 10)

Phase 10 shipped a temporary "SBA" monogram (white letters on `#2b6cb0` rounded-square field) for the favicon set + manifest icons + apple-touch-icon + brand-bar icon, generated inline because the existing `website/images/` assets carry the old Kindoo "K" branding. Operator-supplied final design replaces all eight assets in `apps/web/public/` (`favicon.ico`, `favicon.svg`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`); the manifest entries in `apps/web/vite.config.ts` and the `<link>` tags in `apps/web/index.html` are already wired to those filenames so the swap is a one-PR replacement. Maskable variant must keep content inside the inner 80% safe-zone circle. SVG favicon should remain a single mark that reads cleanly at 16×16.

---

## [T-28] Sync `firebase-schema.md` + `data-model.md` with Phase 10.3 fields (`urgent`, `sort_order`)
Status: done (2026-04-29)
Owner: @docs-keeper
Phase: post Phase 10.3

Phase 10.3 added `urgent: boolean` to Request and `sort_order: number | null` to Seat and Access without updating the schema reference. Add `urgent` to `firebase-schema.md` §4.7 (Request) and `data-model.md`'s Request shape; add `sort_order` to `firebase-schema.md` §4.5 (Access) and §4.6 (Seat) with the operator-decided semantics — doc-level for Access (MIN of `sheet_order` across `importer_callings`), seat-level for Seat (MIN of `sheet_order` across `callings[]`), `null` for orphaned-calling seats and manual-only access docs. Cross-reference the importer-denormalization commit (`be93970`) and note the "wait for next importer run" migration posture (no backfill). Land in a docs-only commit; keep separate from the Phase 10.3 PR so that PR stays bounded.

## [T-30] Phase 10.5 backend lane — userIndex self-update rule + `pushOnRequestSubmit` trigger
Status: open
Owner: @backend-engineer
Phase: 10.5

Web-engineer shipped sub-changes A (schema) + B+C+D (SW + panel + token registration) on branch `phase-10.5-fcm-push` (PR #40, draft). Backend lane outstanding:

1. **Rules** (`firestore/firestore.rules` userIndex block at line 178). Currently `allow write: if false;`. Permit self-update of just `fcmTokens` + `notificationPrefs` + `lastActor` + `lastTouched` keys when `request.auth.uid == resource.data.uid`. Pattern:
   ```
   allow update: if isAuthed()
                 && resource.data.uid == request.auth.uid
                 && request.resource.data.diff(resource.data).affectedKeys()
                      .hasOnly(['fcmTokens', 'notificationPrefs', 'lastActor', 'lastTouched']);
   ```
   Add rules tests covering: allowed self-update with allowed keys; denied if uid mismatch; denied if write touches `uid` / `typedEmail` / `lastSignIn`.

2. **Trigger** (`functions/src/triggers/pushOnRequestSubmit.ts`). `onDocumentCreated('stakes/{stakeId}/requests/{requestId}', ...)`. Pattern follows `auditTrigger.ts` and the manager-active filter at `functions/src/lib/seedClaims.ts:71` (`managerSnap.data().active === true`). For each active manager with `notificationPrefs.push.newRequest === true` and non-empty `fcmTokens`, build a `MulticastMessage` (data-only payload — the SW renders the notification) and call `getMessaging().sendEachForMulticast(...)`. On invalid-token responses (`messaging/registration-token-not-registered` or `messaging/invalid-registration-token`), remove that token from the owning userIndex doc via `FieldValue.delete()`. No-tokens-registered case: silent skip (Phase 9 will extend this with email fallback).

   Title/body copy in v1: title `"New request"`, body `"<requester_name> requested <type> for <calling>"`. Data payload includes `{ requestId, deepLink: "/manager/queue?focus=<rid>" }` so the SW's `notificationclick` handler navigates correctly.

3. **Re-export** in `functions/src/index.ts`.

4. **Tests** — vitest + emulator, FCM Admin SDK mocked: reads only active managers; respects `notificationPrefs.push.newRequest`; skips managers with no tokens; cleans up invalid tokens.

Schema (sub-change A) is already committed; types + zod schemas live in `packages/shared/src/{types,schemas}/userIndex.ts`. Dependencies satisfied; ship on the same `phase-10.5-fcm-push` branch (rebase before pushing).

## [T-29] Per-row `sheet_order` sort on the Access page table view
Status: open
Owner: @web-engineer
Phase: post Phase 10.4

Phase 10.4 fixed the Access page **card view** to sort by the doc-level `sort_order` (Phase 10.3 importer denormalization). The **table view** (`flattenAccess` at `apps/web/src/features/manager/access/AccessPage.tsx`, the rows it produces are `(scope, calling, email)` triples) still sorts by `scope → calling → email`. Per-row `sheet_order` would be the right denominator there, but each row's calling needs to be matched against the corresponding template (`wardCallingTemplates` for ward scopes, `stakeCallingTemplates` for stake) to look up its `sheet_order`, including wildcard matching (the `Counselor *` family).

Doing this correctly requires:
1. Two new live subscriptions on the Access page (`useWardCallingTemplates` and `useStakeCallingTemplates`).
2. Porting `matchTemplate` + `wildcardToRegex` from `functions/src/lib/parser.ts` into a shared helper (probably `apps/web/src/lib/sort/calling-templates.ts` or moved into `packages/shared/`) so both client and importer use the same wildcard semantics.
3. Cache layer so the table doesn't re-resolve every render (one `Map<scope, TemplateIndex>` is enough; rebuild only when templates change).
4. Manual-grant rows (where `calling` is a free-text reason) get `+Infinity` sort_order — bottom of the band per scope.

Skipped in Phase 10.4 because the operator named only the card-view sort as the immediate priority, and this work has reasonable complexity (two new subscriptions + a parser port). Revisit after staging if the table view's `scope → calling` sort proves insufficient on real data.

## [T-32] Phase 9 schema additions — audit enum + stake fields
Status: open
Owner: @backend-engineer
Phase: 9

Phase 9 (`phase-9-resend-email` branch) adds three append-only-safe fields to `packages/shared`:

1. `AuditAction` enum — new member `'email_send_failed'` for the per-failure system audit row written by `EmailService` when Resend errors.
2. `Stake.notifications_reply_to?: string` — optional reply-to address used by EmailService.
3. `Stake.last_import_triggered_by?: 'manual' | 'weekly'` — populated by `Importer.runImporterForStake` on every run; read by `notifyOnOverCap` to attribute the over-cap email subject.

Append-only — no rename, no removal — so web consumers (`apps/web/`) only need to handle the new enum case in any audit-action display surface. Currently no surface renders distinct copy per audit action, so no follow-up edit is required; the new code just falls through to the generic action label.

## [T-34] Document `WEB_BASE_URL` env var in deploy runbook
Status: open
Owner: @infra-engineer
Phase: 9 follow-up

Phase 9's email triggers (`notifyOnRequestWrite`, `notifyOnOverCap`) read `process.env.WEB_BASE_URL` to compose deep-link URLs in email bodies. The variable is declared via `defineString('WEB_BASE_URL')` in both triggers and is set per-project via `functions/.env.<project>` at deploy time. `infra/runbooks/resend-api-key-setup.md` Step 4 documents the mechanism for the Phase 9 deploy, but `infra/runbooks/deploy.md` doesn't currently list `WEB_BASE_URL` among the per-project env vars / secrets the operator must set before a clean deploy. Cross-link from `deploy.md` so the per-project deploy checklist surfaces it without requiring the operator to follow the Resend runbook.

## [T-33] Phase 11 cutover — silence Apps Script Main email path
Status: open
Owner: @tad
Phase: 11 (cutover-day prerequisite)

When Phase 9 ships in staging/prod, Apps Script Main and Firebase will both send notifications for the same lifecycle events during the migration window — managers and requesters get duplicate emails per request. Accepted as transient. At Phase 11 cutover, before flipping DNS / traffic, the operator must flip the Apps Script `Config.notifications_enabled = FALSE` in the live Sheet so the legacy path silences. Bake this into the Phase 11 cutover runbook as a pre-flip step. Order is "flip Config off → confirm Firebase still sends → flip DNS / traffic". Reverting (rollback) re-enables it: flip Apps Script `notifications_enabled` back to TRUE.

## [T-31] Role-aware redirect gates on routes a user can't access
Status: open
Owner: @web-engineer
Phase: post Phase 10.5

Today most manager-only routes (`/manager/queue`, `/manager/dashboard`, `/manager/access`, `/manager/configuration`, `/manager/audit`, `/manager/seats`, `/manager/import`) rely on the nav not exposing them to non-managers — there's no per-route redirect for users who deep-link directly. The `/notifications` route (Phase 10.5) is the only one with an explicit gate today.

Add consistent role-aware redirect gates to every route that's role-gated, mirroring the principal-loading-aware pattern from `routes/_authed/notifications.tsx` (which derives `claimsLoading` from `firebaseAuthSignedIn && !isAuthenticated` to avoid race-redirecting during principal load). Same treatment for bishopric-only and stake-only routes if any exist.

Likely shape: a small reusable hook or HOC (e.g., `useRequireRole(role)`) that handles loading + redirect together, applied via `Route.beforeLoad` or a top-level `useEffect`. Mirror whatever pattern the codebase settles on for `/notifications` so all role-gated routes use the same idiom.

## [T-35] Manual completion-note UI on Mark Complete dialog
Status: open
Owner: @web-engineer

Today `request.completion_note` is only auto-populated by the system in the R-1 race case (`apps/web/src/features/manager/queue/hooks.ts:206`): when a manager marks a remove-type request complete and the seat is already gone, the code auto-writes `"Seat already removed at completion time (no-op)."`. There's no UI for managers to add a custom note.

Spec §9 says the completion email surfaces a `Note:` line for the requester ("so the requester knows nothing visibly changed"). The R-1 auto-note covers that one specific case but doesn't allow managers to leave a note for any other scenario (e.g., "I removed them but had to wait for the door system to sync overnight").

Add a small free-text textarea to the Mark Complete dialog (`apps/web/src/features/manager/queue/...`) — optional, only visible on `type='remove'` requests (or on all types — operator decides). Wire the value through to `update.completion_note` in the existing complete mutation. Phase 9's `notifyRequesterCompleted` already surfaces `completion_note` in the email body; no backend change needed.

Effort: small. Surface during a future polish pass.
