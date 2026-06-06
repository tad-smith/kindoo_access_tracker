# Tasks

Deferred work items surfaced in session but not yet scheduled into a phase. These are smaller follow-ups and design questions the user has flagged. Check this file at the start of a session along with the other "start each session by reading" docs so ongoing work isn't dropped.

Format per task: `## [T-NN]` header with `Status:`, `Owner:`, optional `Phase:` lines, then a body. Status: `pending` / `open` / `in progress` / `done (YYYY-MM-DD)` / `done (YYYY-MM-DD — context)`. Done entries stay in place as trail.

---

## [T-70] Update D19's "four cards remain" claim after Warnings-card removal
Status: done (2026-06-06 — D19 addendum added noting PR #215 removed the over-cap Warnings card; three cards remain)
Owner: @docs-keeper
Phase: cross-cutting

`architecture.md` D19 (added 2026-06-05, PR #210) records the expiry-scheduler removal and notes "The manager Dashboard drops its fifth 'Last Operations' card … four cards remain." PR #215 then removed the over-cap Warnings card, so the count is now three. `spec.md` §5.3 and `TASKS.md` T-54 were updated in PR #215; `architecture.md` is docs-keeper-owned, so the D19 count is left for you. A one-line addendum (e.g., "(over-cap Warnings card later removed in PR #215 — three cards)") keeps a future reader of D19 from being misled.

## [T-69] Scrub `functions/CLAUDE.md` of retired-expiry references
Status: done (2026-06-05 — fixed in PR #210)
Owner: @backend-engineer
Phase: cross-cutting

The temp-seat expiry scheduler was removed in PR #210 (see `docs/changelog/remove-temp-seat-expiry-scheduler.md`, `architecture.md` D19), but `functions/CLAUDE.md` still references the deleted symbols in three places: the header line ("scheduled jobs (expiry, audit reconciliation)"), the `src/` file-layout block (`scheduled/runExpiry.ts`, `services/` "Expiry"), the don't-write-audit note (`ExpiryTrigger` example), and the deploy note ("bump to 540s for `runExpiry`"). `functions/CLAUDE.md` content is owned by `@backend-engineer`; docs-keeper owns only its structure. Replace the `runExpiry` / `Expiry.ts` / `ExpiryTrigger` mentions (the surviving synthetic actor example is `RemoveTrigger`; the only scheduled job is `reconcileAuditGaps`).

Closed 2026-06-05 in the same PR: header line → "scheduled jobs (audit reconciliation)"; dropped `scheduled/runExpiry.ts` and `services/` "Expiry" from the file-layout block; `ExpiryTrigger` example → `RemoveTrigger`; deploy note → "bump to 540s for any long-running scheduled job or callable."

## [T-01] Reconcile `stamp-version.js` with workspace `version.ts` shape
Status: done (2026-04-28)
Owner: @infra-engineer
Phase: 1 → due before Phase 4 staging deploy

`infra/scripts/stamp-version.js` wrote `VERSION` + `BUILT_AT`, but the Phase 1 workspace authors created `version.ts` files exporting `KINDOO_WEB_VERSION` / `KINDOO_FUNCTIONS_VERSION` per the migration-plan task spec. The mismatch surfaced when the operator ran `pnpm deploy:staging` for the first time: the stamper clobbered the placeholder files and `pnpm typecheck` failed because Shell.tsx, version.test.ts, functions/src/index.ts, and functions/src/index.test.ts all imported the per-workspace named constants.

Closed 2026-04-28 (option b): `infra/scripts/stamp-version.js` now emits per-workspace named exports — `KINDOO_WEB_VERSION` + `KINDOO_WEB_BUILT_AT` for `apps/web/src/version.ts`, `KINDOO_FUNCTIONS_VERSION` + `KINDOO_FUNCTIONS_BUILT_AT` for `functions/src/version.ts`. Consumer-side files unchanged. See PR #fix/t-01-version-stamper-shape.

## [T-02] Document `firebase-tools` standalone-binary footgun in deploy runbook
Status: done (2026-05-03)
Owner: @docs-keeper
Phase: 1 → cross-cutting

The standalone pkg-bundled `firebase` binary at `/usr/local/bin/firebase` (282 MB; embedded old Node) cannot `require()` ESM packages, so `firebase emulators:exec` breaks any ESM script (e.g., Vitest 2.x). The npm-installed firebase-tools is a small Node shim and works. Add a warning section to `infra/runbooks/deploy.md` (and any local-dev runbook the operator follows) telling operators to install firebase-tools via npm and to never `pnpm install -g firebase-tools` with sudo (corrupts `~/.npm`).

Closed 2026-05-03: canonical writeup landed at `infra/runbooks/provision-firebase-projects.md` §0.4 ("firebase CLI installed the right way") covering all three failure modes — standalone-binary ESM breakage, the npm-shim-uses-system-Node contrast, and the `sudo pnpm install -g` cache-corruption trap with detect/fix commands. `infra/runbooks/deploy.md` pre-flight step 2 is a brief pointer back to that section.

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
Status: done (2026-04-28) — **[DEPRECATED 2026-05-18 — T-45 removed the importer; sheet sharing no longer needed]**
Owner: @tad
Phase: 1 → due before Phase 8

Grant view access on the LCR callings sheet to the importer service account that lands with Phase 8. Doesn't block earlier phases. Spec: `docs/firebase-migration.md` B4.

Closed 2026-04-28: the importer service account that lands with Phase 8 will have view access to the LCR callings sheet.

Deprecated 2026-05-18: T-45 removed the LCR Sheet importer (`runImporter` / `runImportNow` / `Importer.ts` deleted; `googleapis` dropped from `functions/package.json`). The csnorth LCR sheet no longer needs to be shared with `kindoo-app@`; operator may revoke the existing grant as optional cleanup. See `docs/architecture.md` D14 and `infra/runbooks/granting-importer-sheet-access.md` (also deprecated).

## [T-06] Restart Claude Code so named engineering agents become dispatchable
Status: done (2026-04-28)
Owner: @tad
Phase: 1 → cross-cutting

The new `.claude/agents/{web-engineer,backend-engineer,infra-engineer,docs-keeper}.md` definitions plus the Definition-of-Done update only load at session start. Until Tad restarts Claude Code, the Agent tool can't dispatch them by name (Phase 1's parallel agents had to use `general-purpose`). Phase 2 onward expects the named agents.

Closed 2026-04-28: the named agents (`web-engineer`, `backend-engineer`, `infra-engineer`, `docs-keeper`) have been dispatched repeatedly across Phases 2 / 3 / 3.5 / 4 — proven dispatchable.

## [T-07] Vite `apps/web` chunk-size warning >500 KB
Status: done (2026-05-03; no code change needed — natural design already resolved it)
Owner: @web-engineer
Phase: 1 → revisited at Phase 6+ close

Phase 4 wired the `@tanstack/router-plugin/vite` autogen plugin with `autoCodeSplitting: true`, so per-route components ship as separate chunks. Phase 5 added seven feature folders, each landing as its own per-page chunk (2–7 KB), which further fragmented the bundle. Post-Phase-5 build output: main `index-*.js` was in the 90–100 KB gz range, per-page route chunks 2–7 KB each, and the `schemas-*.js` chunk held steady around ~352 KB / ~106 KB gz.

Closed 2026-05-03: the residual `schemas-*.js` chunk has shrunk on its own to 3.79 KB / 1.55 KB gz, well under the default 500 KB Vite warning limit. Inspection of `apps/web/src/features/**` shows web-side imports from `@kindoo/shared` are types-only (`Seat`, `Ward`, `AccessRequest`, etc.) plus a couple of helper functions (`canonicalEmail`, `buildingSlug`) — no `*Schema` value imports from the shared barrel. Forms use feature-local zod schemas at `apps/web/src/features/{bootstrap,requests,manager/configuration}/schemas.ts`, so the shared schemas barrel is never pulled into the client bundle as a single concentrated chunk. Vite's default code-splitter naturally fragments the small bits of zod that do land per-route. `pnpm --filter @kindoo/web build` produces zero chunk-size warnings; the largest chunks are the shared vendor bundle (`cn-*.js` at 430 KB / 130 KB gz, holding Firebase SDK + Radix primitives) and the entry chunk (`index-*.js` at 367 KB / 116 KB gz). No `chunkSizeWarningLimit` override or refactor needed.

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
Status: done (2026-05-03)
Owner: @docs-keeper
Phase: cross-cutting

Cloud Build's `npm install` cannot resolve pnpm's `workspace:*` protocol, so `@kindoo/shared` as a workspace dep blocks Cloud Functions deploy. Phase 2 worked around this with esbuild bundling: `functions/scripts/build.mjs` bundles `@kindoo/shared`'s source into `functions/lib/index.js` and writes a clean `functions/lib/package.json` containing only real npm deps; `firebase.json`'s `functions.source` points at `functions/lib`. This is architecturally significant — the workaround shape (clean `lib/package.json` + symlinked `node_modules` for the local emulator) is non-obvious and easy to break. Document it in `infra/CLAUDE.md` and consider promoting to a numbered architecture decision (next D-number) so future agents don't re-derive the trap. See the Phase 2 changelog "Deviations" section for the full rationale.

Closed 2026-05-03: promoted to architecture decision **D12** (`docs/architecture.md`) and documented in `infra/CLAUDE.md` "Cloud Functions deploy artifact" section.

## [T-12] Document failed-deploy half-state recovery in B1 runbook
Status: done (2026-04-28, Phase 2 close)
Owner: @infra-engineer
Phase: cross-cutting

A failed first-deploy attempt can leave Cloud Functions in a half-registered state where the platform sees a function as an HTTPS function even though the source declares it as a Firestore-document trigger. Symptom: subsequent deploys fail with a trigger-type-mismatch error. Recovery: `firebase functions:delete <name>` against the affected functions, then redeploy. Add a troubleshooting entry to `infra/runbooks/provision-firebase-projects.md`.

Closed 2026-04-28: `infra/runbooks/provision-firebase-projects.md` covers the half-state recovery via `firebase functions:delete <function-names...>` followed by redeploy.

## [T-13] `STAKE_IDS` hardcoded to `['csnorth']` in functions
Status: done (PR #75, 2026-05-03)
Owner: @backend-engineer
Phase: 12

`functions/src/lib/constants.ts` exports `STAKE_IDS = ['csnorth']` and `seedClaimsFromRoleData` walks this list when seeding claims for brand-new users on first sign-in. The `syncAccessClaims` / `syncManagersClaims` triggers extract `stakeId` from the doc path directly, so they are stake-ID-agnostic; only the seed path is hardcoded. Implication: if the v1 stake's actual document ID isn't `csnorth`, new users will sign in cleanly but won't get claims seeded automatically — operators can work around by manually editing a `kindooManagers` doc to fire the sync trigger. Phase 12 (multi-stake) makes this dynamic by deriving the list at runtime.

Closed 2026-05-03 (PR #75, commit `cf643eb`): seed path now calls `getStakeIds(db)` from new helper `functions/src/lib/stakeIds.ts`, which reads `stakes/` via `listDocuments()` and caches in module scope. `functions/src/lib/constants.ts` deleted (only export was the obsolete `STAKE_IDS`). Phase 12 work no longer needed for the SEED side — new stakes are picked up automatically on next cold start. SPA-side `STAKE_ID` remains hardcoded as planned; multi-stake routing lands in Phase 12 separately.

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
Status: done (PR #5, 2026-04-28)
Owner: @infra-engineer
Phase: cross-cutting

A 2026-04-28 dependency audit found several caret floors lagging current by many minors: `firebase-admin ^13.0.2` (latest 13.8.0), `@playwright/test ^1.49.1` (latest 1.59.1), `@tanstack/react-router ^1.95.5` and `@tanstack/router-plugin ^1.95.5` (latest 1.168.x / 1.167.x), `@tanstack/react-query ^5.62.10` (latest 5.100.x), plus smaller drift on `prettier`, `vite`, `jsdom`, `concurrently`, `@vitejs/plugin-react`, `@testing-library/*`, `firebase-functions-test`, `zod`. Carets would catch these on a fresh install but the lockfile holds. Bump the floors and refresh `pnpm-lock.yaml` in one pass; one PR, all workspaces. Separate concern: **`@google/clasp ^2.4.2` is in the affected range for CVE-2026-4092** (path traversal → arbitrary file write); bump to `^3.3.0` and verify push/deploy scripts still work — clasp 3.x is a major. Track that bump under this task or split it out, operator's choice. Hold `@types/node` at `^22` deliberately to track the Node 22 runtime; if upgraded, leave a comment noting the deliberate pin. Out of scope: TypeScript / Vite / Vitest / Firebase / esbuild, all already at-latest.

Closed 2026-04-28 (commit `f26bbf6`, PR #5): caret floors bumped across workspaces — `firebase-admin ^13.8.0`, `@playwright/test ^1.59.1`, `@tanstack/react-router ^1.168.25`, `@tanstack/router-plugin ^1.167.28`, `@tanstack/react-query ^5.100.5`, `@google/clasp ^3.3.0` (covers CVE-2026-4092), plus the smaller-drift entries. `@types/node ^22` held deliberately. Verifiable in current `package.json` files at `package.json:35-37` (root), `apps/web/package.json:27-49`, `functions/package.json:22-31`, `e2e/package.json:15`, `packages/shared/package.json:22`.

## [T-20] Bundle THIRD_PARTY_LICENSES artifact in production build
Status: done (PR #77, 2026-05-03)
Owner: @infra-engineer
Phase: 11 (cutover) → due before public DNS flip

Apache-2.0 dependencies in the production bundle (TypeScript, firebase, firebase-admin, @google/clasp, @playwright/test, @firebase/rules-unit-testing) require preserving the LICENSE + NOTICE text in the distributed artifact. MIT deps require preserving the copyright + license notice. Today nothing in the Hosting build assembles this. Add a build step (e.g., `pnpm-licenses` / `license-checker-rseidelsohn` / similar) that emits `apps/web/dist/THIRD_PARTY_LICENSES.txt` covering every runtime dep in the SPA bundle, and surface a link from a footer or About page so users can find it. Functions side does not ship to end-users so no equivalent artifact is needed. Verify the build runs in CI and the file is non-empty before Phase 11 close.

Closed 2026-05-03 (PR #77): postbuild step at `apps/web/scripts/emit-third-party-licenses.mjs` shells `pnpm --filter @kindoo/web licenses list --prod --long --json` to enumerate the SPA's transitive runtime tree (146 packages at this commit), reads LICENSE / NOTICE text from each package directory, and concatenates into `apps/web/dist/THIRD_PARTY_LICENSES.txt` (~208 KB). Wired into both `build` and `build:staging` in `apps/web/package.json`. The script fails the build if the artifact is under 16 KB so a silent regression cannot ship. CI gate added to `infra/ci/workflows/test.yml` (mirrored to `.github/workflows/test.yml`) verifies file presence + size after `pnpm build`. Footer link surfaced from `apps/web/src/components/layout/NavOverlay.tsx` as `v<version> · Licenses` (target=_blank, rel=noopener, href=/THIRD_PARTY_LICENSES.txt); component test in `NavOverlay.test.tsx`. `pnpm licenses` chosen over `license-checker-rseidelsohn` because the latter walks `node_modules/<dep>/node_modules/` and misses pnpm's flat `.pnpm/` layout (it found only the 20 direct deps).

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
Status: done (closed by Phase 7 close)
Owner: @backend-engineer
Phase: 7 (current — was discovered during Phase 7 wizard wiring)

Closed: option (1) shipped — `firestore/firestore.rules` defines `isBootstrapAdmin(stakeId)` (lines 132-138) keyed on `setup_complete == false` AND `bootstrap_admin_email == request.auth.token.email`. Predicate is OR'd into the wards / buildings / kindooManagers / parent stake match blocks (lines 234-283). Once the wizard flips `setup_complete=true`, the predicate goes silent and the manager claim takes over. Rules tests covering allowed/denied transitions live in `firestore/tests/bootstrap.test.ts` (added under T-23 / PR `fix/bootstrap-wizard-issues`).

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
Status: done (PR #68, 2026-05-03)
Owner: @web-engineer
Phase: cross-cutting

Audit completed; 5 unsafe-looking callsites voided defensively (all keyed away from the DIY-hook `__kindoo_firestore__` prefix, so technically safe, but voided for uniformity); 32 callsites already used `void qc.invalidateQueries()`; lint rule skipped because `apps/web/` has no ESLint infrastructure (lint script is `prettier --check`) and standing up `@typescript-eslint` for one rule is disproportionate. Future regressions are guarded by the now-uniform `void` convention plus the comment trail at each callsite citing the DIY-hook key prefix. Path-2 (replace the placeholder queryFn) explicitly out of scope — see comments in `useFirestoreDoc.ts`.

The DIY Firestore hooks (`useFirestoreDoc`, `useFirestoreCollection`) at `apps/web/src/lib/data/` use a never-resolving placeholder `queryFn` so `onSnapshot` is the source of truth for cache writes (per architecture D11). Side-effect: `qc.invalidateQueries()` (no args, or any keyset that matches a live-listener entry) returns a Promise that never resolves, because TanStack awaits the matched queries' refetches and the placeholder `queryFn` never settles. Mutations that `await` the invalidate via `onSuccess` chain hang forever — `mutateAsync` never resolves → `mutation.isPending` stays `true` → the submit button reads "Adding…" until the page is refreshed.

Two fix paths:

1. **Audit + `void`** every callsite. Convert `onSuccess: () => qc.invalidateQueries()` (returns the promise) into `onSuccess: () => { void qc.invalidateQueries(); }` (fire-and-forget). Targeted invalidations keyed away from the DIY-hook prefix (`['kindoo', 'requests']`, etc.) are already safe because they don't match the live-listener cache keys.
2. **Replace the placeholder.** Rewrite the DIY hooks' `queryFn` to resolve immediately to the cached value (or a sentinel-undefined wrapper). More invasive — the current shape relies on the never-resolving promise for state-machine reasons documented in `useFirestoreDoc.ts` — but eliminates the footgun structurally.

PR #29 applied (1) selectively to mutations in `features/manager/configuration/`, `features/manager/access/`, `features/manager/allSeats/`, and `features/bootstrap/`. The rest of the codebase remains potentially affected — anywhere a future engineer writes `onSuccess: () => qc.invalidateQueries()` in expression-arrow form will reproduce the hang. A repo-wide audit (lint rule? grep + manual review?) plus the option-(2) refactor are both still open.

Surfaces this footgun: the screenshot trail in PR #29 ("Add manual access" stuck on Adding…) is the canonical reproduction.

## [T-25] E2E coverage for `runImportNow` and `installScheduledJobs` callables
Status: done (PR #70, 2026-05-06)
Owner: @web-engineer
Phase: 8 → cross-cutting

The Phase 8 §1094 spec ("Manager clicks 'Import Now' → status updates → over-cap banner appears + clears on next clean run") is partially covered: the integration tests in `functions/tests/` exercise the callable's logic, and unit tests in `apps/web/src/features/manager/import/` cover the SPA mutation hook + the page's loading / success / error / banner states. The live-callable e2e is unwritten because Playwright's setup currently boots only the Auth + Firestore emulators, not the Functions emulator.

**Scope:** wire the Functions emulator into Playwright's `globalSetup`; write the §1094 e2e plus a sibling for `installScheduledJobs` (the bootstrap wizard's "Complete Setup" path that should idempotently install Cloud Scheduler jobs).

**Closed (PR #70):** Functions emulator wiring landed in `apps/web/src/lib/firebase.ts` (`connectFunctionsEmulator` behind `VITE_USE_FUNCTIONS_EMULATOR`) plus `e2e/playwright.config.ts` (build-time env flag). New specs at `e2e/tests/manager-admin/import-now.spec.ts` (happy path + over-cap-banner + clears-on-clean-rerun) and `e2e/tests/manager-admin/install-scheduled-jobs.spec.ts` (Complete-Setup invocation + SDK-driven idempotent second invocation via the test hatch's `invokeCallable`). Sheet-fixture seeding for the importer uses a Firestore-doc-backed fetcher gated by `FUNCTIONS_EMULATOR=true` (`functions/src/lib/sheets.ts` + `e2e/fixtures/emulator.ts:seedSheetFixture`). Drive-by web fix: `invokeInstallScheduledJobs` now passes `stakeId` (was a missing-argument bug — the wizard's warn-toast path was hiding it). CI side: build-functions step before E2E so the emulator can register callables, synthesize `functions/.env.kindoo-staging` to satisfy `defineString` params + the new `KINDOO_SKIP_CLAIM_SYNC=true` flag (`functions/src/lib/applyClaims.ts` short-circuit) so existing specs' synthetic `setCustomClaims` seeds are not raced by the now-loaded `onAuthUserCreate` / `syncManagersClaims` triggers.

## [T-26] Phase 11 SA hardening pass
Status: open (runbook fold-in landed)
Owner: @infra-engineer (verify SA roles, deploy) + @backend-engineer (function options)
Phase: 11

Pin the remaining Cloud Functions (audit fan-in × 9, claim sync × 4, `onAuthUserCreate`, `removeSeatOnRequestComplete`) to `kindoo-app@` for single-identity audit traces and to allow revoking the project-default `roles/editor` from the default compute SA. (`installScheduledJobs` was on this list; it was deleted in PR #214 — see `architecture.md` D20 — so there is nothing to pin.) Phase 8 pinned only the four Sheets-touching functions (`runImporter`, `runExpiry`, `reconcileAuditGaps`, `runImportNow`) because the LCR sheet is shared with `kindoo-app@` and the importer was 403'ing on the default compute SA; the rest stayed on default to defer the IAM review to cutover.

**Pre-req:** confirm via `gcloud projects get-iam-policy` that `roles/editor` is still bound to `<projectnum>-compute@developer.gserviceaccount.com`, and that `kindoo-app@` has the roles needed for Auth Admin SDK calls (claim-sync triggers + `onAuthUserCreate` write `customClaims` + revoke refresh tokens; `removeSeatOnRequestComplete` writes Firestore; the audit fan-in functions write Firestore).

**Runbook fold-in landed (2026-05-03):** PR `infra/runbook-kindoo-app-eventarc-fcm-roles` added `roles/eventarc.eventReceiver` and `roles/firebasecloudmessaging.admin` to step 1.8 of `infra/runbooks/provision-firebase-projects.md`. These are the two roles surfaced during the Phase 9/10.5 staging deploy and re-confirmed during prod bring-up (the codebase pins `kindoo-app` for the email + FCM push triggers, both Firestore-Eventarc consumers; FCM admin is needed for `messaging.send()`). The runbook now grants five roles instead of three. The remaining T-26 work — pinning the rest of the functions to `kindoo-app@`, the `gcloud projects get-iam-policy` audit, and revoking project-default `roles/editor` — remains open and tracked here.

## [T-27] Replace placeholder SBA monogram favicon + brand-bar icon with final designed mark before public launch
Status: done (PR #54, 2026-05-05)
Owner: @web-engineer
Phase: pre-launch (post Phase 10)

Phase 10 shipped a temporary "SBA" monogram (white letters on `#2b6cb0` rounded-square field) for the favicon set + manifest icons + apple-touch-icon + brand-bar icon, generated inline because the existing `website/images/` assets carry the old Kindoo "K" branding. Operator-supplied final design replaces all eight assets in `apps/web/public/` (`favicon.ico`, `favicon.svg`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`); the manifest entries in `apps/web/vite.config.ts` and the `<link>` tags in `apps/web/index.html` are already wired to those filenames so the swap is a one-PR replacement. Maskable variant must keep content inside the inner 80% safe-zone circle. SVG favicon should remain a single mark that reads cleanly at 16×16.

---

## [T-28] Sync `firebase-schema.md` + `data-model.md` with Phase 10.3 fields (`urgent`, `sort_order`)
Status: done (2026-04-29)
Owner: @docs-keeper
Phase: post Phase 10.3

Phase 10.3 added `urgent: boolean` to Request and `sort_order: number | null` to Seat and Access without updating the schema reference. Add `urgent` to `firebase-schema.md` §4.7 (Request) and `data-model.md`'s Request shape; add `sort_order` to `firebase-schema.md` §4.5 (Access) and §4.6 (Seat) with the operator-decided semantics — doc-level for Access (MIN of `sheet_order` across `importer_callings`), seat-level for Seat (MIN of `sheet_order` across `callings[]`), `null` for orphaned-calling seats and manual-only access docs. Cross-reference the importer-denormalization commit (`be93970`) and note the "wait for next importer run" migration posture (no backfill). Land in a docs-only commit; keep separate from the Phase 10.3 PR so that PR stays bounded.

## [T-30] Phase 10.5 backend lane — userIndex self-update rule + `pushOnRequestSubmit` trigger
Status: done (PR #40, 2026-04-29)
Owner: @backend-engineer
Phase: 10.5

Closed by Phase 10.5 close (PR #40, commit `456551f`). The userIndex self-update rule is at `firestore/firestore.rules:182-190` with the prescribed `affectedKeys().hasOnly(['fcmTokens', 'notificationPrefs', 'lastActor'])` allowlist plus the `lastActorMatchesAuth` integrity check; `lastTouched` was dropped from the allowlist mid-phase (cross-workspace constraint propagation, captured in the Phase 10.5 changelog). The trigger lives at `functions/src/triggers/pushOnRequestSubmit.ts` (re-exported in `functions/src/index.ts:8`), pinned to `APP_SA`, filters active managers with `notificationPrefs.push.newRequest === true` and non-empty `fcmTokens`, calls `sendEachForMulticast`, and prunes invalid tokens via `FieldValue.delete()`. 8 integration tests cover the trigger; 6 rules tests cover the self-update.

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
Status: done (closed by Phase 10.4 follow-up)
Owner: @web-engineer
Phase: post Phase 10.4

Closed: `apps/web/src/features/manager/access/AccessPage.tsx:59-67` builds a `(scope, calling) → sheet_order` lookup via `buildSheetOrderLookup({ stakeTemplates, wardTemplates, wardCodes })` from `./sort.ts`; `flattenAccess` (line 241) sorts rows by scope band → per-row `sheet_order` from the lookup → email. The Access page subscribes to `useStakeCallingTemplates` + `useWardCallingTemplates` (lines 52-53). Manual-grant rows fall through to `+Infinity` (bottom of band) as the original task spec called for. Wildcard match (`Counselor *` family) is handled inside `./sort.ts`.

Phase 10.4 fixed the Access page **card view** to sort by the doc-level `sort_order` (Phase 10.3 importer denormalization). The **table view** (`flattenAccess` at `apps/web/src/features/manager/access/AccessPage.tsx`, the rows it produces are `(scope, calling, email)` triples) still sorts by `scope → calling → email`. Per-row `sheet_order` would be the right denominator there, but each row's calling needs to be matched against the corresponding template (`wardCallingTemplates` for ward scopes, `stakeCallingTemplates` for stake) to look up its `sheet_order`, including wildcard matching (the `Counselor *` family).

Doing this correctly requires:
1. Two new live subscriptions on the Access page (`useWardCallingTemplates` and `useStakeCallingTemplates`).
2. Porting `matchTemplate` + `wildcardToRegex` from `functions/src/lib/parser.ts` into a shared helper (probably `apps/web/src/lib/sort/calling-templates.ts` or moved into `packages/shared/`) so both client and importer use the same wildcard semantics.
3. Cache layer so the table doesn't re-resolve every render (one `Map<scope, TemplateIndex>` is enough; rebuild only when templates change).
4. Manual-grant rows (where `calling` is a free-text reason) get `+Infinity` sort_order — bottom of the band per scope.

Skipped in Phase 10.4 because the operator named only the card-view sort as the immediate priority, and this work has reasonable complexity (two new subscriptions + a parser port). Revisit after staging if the table view's `scope → calling` sort proves insufficient on real data.

## [T-32] Phase 9 schema additions — audit enum + stake fields
Status: done (PR #63, 2026-05-03) — `firebase-schema.md` §4.1 and §4.10 now reflect `notifications_reply_to`, `last_import_triggered_by`, and `email_send_failed` per `packages/shared/src/types/{stake,audit}.ts`.
Owner: @backend-engineer
Phase: 9

Phase 9 (`phase-9-resend-email` branch) adds three append-only-safe fields to `packages/shared`:

1. `AuditAction` enum — new member `'email_send_failed'` for the per-failure system audit row written by `EmailService` when Resend errors.
2. `Stake.notifications_reply_to?: string` — optional reply-to address used by EmailService.
3. `Stake.last_import_triggered_by?: 'manual' | 'weekly'` — populated by `Importer.runImporterForStake` on every run; read by `notifyOnOverCap` to attribute the over-cap email subject.

Append-only — no rename, no removal — so web consumers (`apps/web/`) only need to handle the new enum case in any audit-action display surface. Currently no surface renders distinct copy per audit action, so no follow-up edit is required; the new code just falls through to the generic action label.

## [T-34] Document `WEB_BASE_URL` env var in deploy runbook
Status: done (PR #66, 2026-05-03)
Owner: @docs-keeper
Phase: 9 follow-up

Phase 9's email triggers (`notifyOnRequestWrite`, `notifyOnOverCap`) read `process.env.WEB_BASE_URL` to compose deep-link URLs in email bodies. The variable is declared via `defineString('WEB_BASE_URL')` in both triggers and is set per-project via `functions/.env.<project>` at deploy time. `infra/runbooks/resend-api-key-setup.md` Step 4 documents the mechanism for the Phase 9 deploy, but `infra/runbooks/deploy.md` doesn't currently list `WEB_BASE_URL` among the per-project env vars / secrets the operator must set before a clean deploy. Cross-link from `deploy.md` so the per-project deploy checklist surfaces it without requiring the operator to follow the Resend runbook.

Closed 2026-05-03: `infra/runbooks/deploy.md` Pre-flight step 5 ("Verify per-project env files contain `WEB_BASE_URL`") now documents the variable, its per-project values, the `build.mjs` copy mechanism, and both deploy-time + runtime failure modes. Cross-links to `resend-api-key-setup.md` §4 for the full setup walkthrough.

## [T-33] Phase 11 cutover — silence Apps Script Main email path
Status: done (closed by Phase 11 cutover, 2026-05-03)
Owner: @tad
Phase: 11 (cutover-day prerequisite)

When Phase 9 ships in staging/prod, Apps Script Main and Firebase will both send notifications for the same lifecycle events during the migration window — managers and requesters get duplicate emails per request. Accepted as transient. At Phase 11 cutover, before flipping DNS / traffic, the operator must flip the Apps Script `Config.notifications_enabled = FALSE` in the live Sheet so the legacy path silences. Bake this into the Phase 11 cutover runbook as a pre-flip step. Order is "flip Config off → confirm Firebase still sends → flip DNS / traffic". Reverting (rollback) re-enables it: flip Apps Script `notifications_enabled` back to TRUE.

Closed 2026-05-03: Phase 11 cutover decommissioned Apps Script entirely (per `docs/changelog/phase-11-cutover.md` — DNS flipped from the GitHub Pages iframe wrapper to `kindoo-prod` Hosting). Apps Script is no longer in the request path so its email triggers cannot fire on real users; the kill-switch concern is moot.

## [T-31] Role-aware redirect gates on routes a user can't access
Status: done (PR #71, 2026-05-03)
Owner: @web-engineer
Phase: post Phase 10.5

Today most manager-only routes (`/manager/queue`, `/manager/dashboard`, `/manager/access`, `/manager/configuration`, `/manager/audit`, `/manager/seats`, `/manager/import`) rely on the nav not exposing them to non-managers — there's no per-route redirect for users who deep-link directly. The `/notifications` route (Phase 10.5) is the only one with an explicit gate today.

Add consistent role-aware redirect gates to every route that's role-gated, mirroring the principal-loading-aware pattern from `routes/_authed/notifications.tsx` (which derives `claimsLoading` from `firebaseAuthSignedIn && !isAuthenticated` to avoid race-redirecting during principal load). Same treatment for bishopric-only and stake-only routes if any exist.

Likely shape: a small reusable hook or HOC (e.g., `useRequireRole(role)`) that handles loading + redirect together, applied via `Route.beforeLoad` or a top-level `useEffect`. Mirror whatever pattern the codebase settles on for `/notifications` so all role-gated routes use the same idiom.

Closed: shared `useRequireRole` hook lives at `apps/web/src/lib/useRequireRole.ts`. Manager-gated: `/manager/queue`, `/manager/dashboard`, `/manager/access`, `/manager/configuration`, `/manager/audit`, `/manager/seats`, `/manager/import`. Bishopric-gated: `/bishopric/roster`. Stake-gated: `/stake/roster`, `/stake/wards`. `/notifications` refactored onto the same hook (manager-only, behaviour preserved). Loading-window race + redirect targeting handled in the hook; per-route component test for each gated route.

## [T-35] Manual completion-note UI on Mark Complete dialog
Status: done (2026-05-03)
Owner: @web-engineer

Today `request.completion_note` is only auto-populated by the system in the R-1 race case (`apps/web/src/features/manager/queue/hooks.ts:206`): when a manager marks a remove-type request complete and the seat is already gone, the code auto-writes `"Seat already removed at completion time (no-op)."`. There's no UI for managers to add a custom note.

Spec §9 says the completion email surfaces a `Note:` line for the requester ("so the requester knows nothing visibly changed"). The R-1 auto-note covers that one specific case but doesn't allow managers to leave a note for any other scenario (e.g., "I removed them but had to wait for the door system to sync overnight").

Add a small free-text textarea to the Mark Complete dialog (`apps/web/src/features/manager/queue/...`) — optional, only visible on `type='remove'` requests (or on all types — operator decides). Wire the value through to `update.completion_note` in the existing complete mutation. Phase 9's `notifyRequesterCompleted` already surfaces `completion_note` in the email body; no backend change needed.

Effort: small. Surface during a future polish pass.

Closed: optional `Completion note` textarea added to BOTH `CompleteAddDialog` and `CompleteRemoveDialog` in `apps/web/src/features/manager/queue/QueuePage.tsx` (3 rows, vertical resize, placeholder "What did you do? (Optional context for the requester.)"). Wired through `useCompleteAddRequest` / `useCompleteRemoveRequest` in `hooks.ts`; empty/whitespace-only is dropped from the write. R-1 race interaction: manager note wins and the system tag is appended as `"<manager-note>\n\n[System: Seat already removed at completion time (no-op).]"`, preserving both signals on the completion email; helper `resolveRemoveCompletionNote` is exported for unit testing.

## [T-36] Harden the requests-create rule to require role-for-scope (drop the `isManager` blanket allowance)
Status: done (PR #52)
Owner: @backend-engineer
Phase: post Phase 11 (paired with B-3)
Branch / PR: `fix/b-3-new-request-scope-filter` / [#52](https://github.com/tad-smith/kindoo_access_tracker/pull/52)

The `match /stakes/{stakeId}/requests/{requestId}` create predicate in `firestore/firestore.rules` (lines 470–474) currently allows any of:

```
isManager(stakeId)
|| (request.resource.data.scope == 'stake' && isStakeMember(stakeId))
|| (request.resource.data.scope in bishopricWardOf(stakeId))
```

The `isManager(stakeId)` branch lets a Kindoo Manager who holds NO stake or ward claim create requests in any scope, server-side. The B-3 fix on the SPA side filters the New Request scope dropdown strictly by the user's stake + bishopric role union — manager status alone no longer surfaces scope options. The rule should match: a Kindoo Manager who happens to also hold `stake: true` or a bishopric ward inherits creation rights through those branches; manager-only users have no creation surface at all.

**Proposed change:** drop the `isManager(stakeId) ||` term from the create predicate. The two remaining branches already cover every legitimate creator. The rule's `read` / `update` predicates keep `isManager` (managers must still be able to read every request and complete / reject in their queue) — only the `create` branch loses it.

**Tests to add (in `firestore/tests/requests.test.ts` or wherever the requests rules tests live):**
- Manager-only user (claims: `manager: true`, `stake: false`, `wards: []`) creating a `scope: 'stake'` request → denied.
- Manager-only user creating a `scope: 'CO'` request → denied.
- Manager + stake user (claims: `manager: true`, `stake: true`) creating a `scope: 'stake'` request → allowed (inherits through the stake branch).
- Manager + bishopric user (claims: `manager: true`, `wards: ['CO']`) creating a `scope: 'CO'` request → allowed (inherits through the ward branch).
- Bishopric user (claims: `wards: ['CO']`) creating a `scope: 'BA'` request → denied (already covered today; regression-guard).

The web SPA filter (B-3) is the user-visible fix; this rule change is the defense-in-depth layer that prevents a hand-crafted POST from a manager-only user against the REST API. Land on its own PR; do not block the B-3 web fix on it.

## [T-37] Verify requests-create rule does not gate `building_names` contents per role
Status: done (verification confirmed)
Owner: @backend-engineer

The New Request form now lets ward (bishopric) users select multiple buildings — including buildings outside their own ward — via a collapsible widget that defaults to the ward's building but accepts any combination from the catalogue. Web-side change shipped on `feat/new-request-collapsible-buildings`; submit payload's `building_names` for a ward-scope request can now contain ≥1 entry from anywhere in the stake.

A read of `firestore/firestore.rules` (lines 462–464 of the requests-create predicate) confirms the rule only enforces `scope == 'stake' → building_names.size() > 0`. There is no per-role gate on `building_names` contents for ward scopes. So this change should pass the rule as-is.

Closed: re-verified 2026-05-03 — `firestore/firestore.rules:462-464` reads `(request.resource.data.type == 'remove' || request.resource.data.scope != 'stake' || request.resource.data.building_names.size() > 0)`. No per-role gate on `building_names` contents for ward scopes. A bishopric user submitting `building_names: ['Maple Building', 'Cedar Building']` for a ward-scope `add_manual` passes the rule. T-36's role-for-scope tightening (already merged via PR #52) does not re-introduce a buildings-contents gate.

## [T-38] SBA temp grant expiry doesn't downgrade Kindoo permanent users (one-way temp→permanent sync)
Status: open — deferred future work, not blocking
Owner: TBD (depends on chosen fix path — `@web-engineer` for A/B, `@backend-engineer` for C)
Phase: post v2.2 design scoping

Originally filed as B-9; reclassified as a task on 2026-05-12 because this is deferred future feature work, not a defect against currently-shipping behavior. The v2.2 extension design explicitly adopts a one-way temp→permanent promotion rule and accepts the sync gap described below as a known consequence — operator decision when the rule was locked in.

**Mechanism note (2026-06-05).** This entry was written against the old SBA-side expiry trigger, which was removed in PR #210 (`architecture.md` D19, `docs/changelog/remove-temp-seat-expiry-scheduler.md`). The body below still says "SBA's existing expiry trigger removes the temp grant" — that trigger no longer exists. Under the current model Kindoo expires the temp user and the extension's Sync removes the orphaned SBA seat via the `sba-only` path (`spec.md` §7 / §8). The underlying drift this task describes is unchanged in substance — Sync removing the SBA seat still doesn't demote a permanent Kindoo user — so the task stays open; only the trigger mechanism it cites is now stale. Fix path A ("expiry-time push from the SBA trigger") is moot; B / C / D still apply.

**The rule (operator wording).** If v2.2 is processing a manual (permanent) request and finds the Kindoo user is temporary, it promotes them to permanent; if v2.2 is processing a temp request and finds the user already permanent, it leaves them permanent (does not demote):

> If we're adding a manual role to a user and we find they are temporary in Kindoo, then we need to make them a permanent user in Kindoo. If they are a permanent user and we are processing a temporary request, then we have to leave the user as a permanent user.

The accepted consequence: once a Kindoo user is permanent, v2.2 never demotes them — even when the SBA grant that triggered the original temp processing later expires. SBA's view of who has temp vs. permanent access drifts from Kindoo's view over time.

**Observed behaviour.** An SBA `add_temp` grant expires server-side (SBA's existing expiry trigger removes it from the seat's `duplicate_grants[]`), but the corresponding Kindoo user retains the rules + permanent status that v2.2 set when the request was originally processed. Nothing pushes an update to Kindoo at the expiry boundary, so the Kindoo record drifts out of sync with SBA's current state.

**Concrete example:**
1. User A has a permanent SBA seat (e.g. auto-derived from a calling).
2. An `add_temp` request is submitted and approved for User A on the same building.
3. v2.2 sees Kindoo already permanent — per the rule, leaves Kindoo's permanent flag alone, updates rules + description.
4. The temp grant's `end_date` passes.
5. SBA's expiry trigger fires and removes the temp grant from the seat in SBA.
6. Kindoo still shows User A as permanent with the temp grant's rules assigned; nothing pushed the update.

**Impact.** No day-to-day operational impact (the user retains access, the conservative failure mode). Hurts data hygiene + audit traceability over time, and is worse if the original temp grant was a time-limited high-trust access (e.g. a contractor visiting the building) — they keep that access indefinitely until manually revoked. Low-medium severity if a fix is eventually scoped.

**Root cause.** v2.2 is request-driven. There is no scheduled job or expiry-time trigger that reconciles Kindoo against SBA when an SBA temp grant expires server-side.

**Repro (for whoever picks this up):**
1. Find / create a Kindoo user who is permanent.
2. Submit and complete an SBA `add_temp` request for the same user (any building).
3. After v2.2 provisions, confirm Kindoo user is still permanent (correct per the rule).
4. Wait past `end_date` (or simulate by editing the request's `end_date` to the past).
5. SBA expires the temp grant server-side via the existing expiry trigger.
6. Inspect Kindoo: the access rules from the temp grant remain in place; nothing changed.

**Proposed fix paths (not committing to one — surface them for prioritization):**

- **A. Expiry-time push to the extension.** When the SBA expiry trigger removes a temp grant, fire an event the extension reacts to. Hard to wire — the extension is browser-side; the function would need to push to a service the manager has open. Probably not practical.
- **B. Manual reconciliation panel in the extension.** New view that surfaces "Kindoo users with access SBA no longer grants" — manager clicks to revoke. Operator-driven, no server complexity.
- **C. Nightly reconciliation job.** Server-side, lists out-of-sync users for the manager to review (email digest, dashboard widget, audit collection).
- **D. Accept the gap permanently.** Permanent-in-Kindoo is a one-way door by design; revocation always requires an explicit SBA remove request.

**Not blocking anything.** v2.2 ships with the gap by design. Future work only — pick up when someone wants to close the loop.

## [T-39] Production: Chrome Web Store distribution for the SBA extension
Status: done (2026-05-20 — Chrome Web Store listing live at https://chromewebstore.google.com/detail/stake-building-access-%E2%80%94-k/klkkpfdafbjebccodmgkogdklachelpb; OAuth client re-registered against the Web Store extension ID, manifest 1.0.8 with the corrected client pending Web Store re-review)
Owner: Operator (per `extension/CLAUDE.md` and `infra/runbooks/extension-deploy.md` — operator owns the Chrome Web Store listing and the OAuth consent screen)
Phase: post v2.2 rollout

The staging extension is in active use. The production extension is fully built and configured locally; the only remaining step is the Chrome Web Store upload + listing + OAuth consent screen publish. This is operator-execution work only — no engineering prerequisites left.

**State of play (everything technical is already done).**

- Production RSA keypair generated; the deterministic extension ID `cpkoobhcoddjkoflpijeoocniepgnnle` is pinned via the manifest `key` field.
- GCP "Chrome extension" OAuth client registered in the `kindoo-prod` project (client ID prefix `125946184519-...`).
- `extension/.env.production` filled in with the production OAuth client + Kindoo web base URL.
- `pnpm --filter @kindoo/extension build` emits `extension/dist/production/` with the right manifest: name `Stake Building Access — Kindoo Helper`, brand icons, version per current manifest.

**What's still needed (per `infra/runbooks/extension-deploy.md` § "Production: Chrome Web Store distribution").**

1. Zip the **contents** of `extension/dist/production/` (not the folder itself):
   ```
   cd extension/dist/production && zip -r ../../sba-extension-vX.Y.Z.zip ./* && cd ../../..
   ```
2. Upload to the Chrome Web Store Developer Dashboard.
3. Fill in listing fields: icon (use `apps/web/public/icon-512.png` or equivalent), short description, detailed description, screenshots, privacy policy URL.
4. Set visibility to **Unlisted** for the v1 distribution model — the manager distributes the install link to operator-trusted users directly.
5. Submit for review. Web Store review typically takes days to weeks.

**OAuth consent screen.** For the `kindoo-prod` GCP project, the OAuth consent screen must be configured + published before any non-test user can sign in. The extension uses `openid email profile` (non-sensitive scopes), so Google verification is **not** required, but the consent screen must be filled in (app name, support email, etc.) and pushed to production.

**Decision deferred.** Whether the listing eventually goes Public (vs staying Unlisted) is operator's call once the user base extends beyond a single stake. Tracked under Phase 12 (multi-stake) as a follow-up.

**No dependencies.** Every prerequisite is already shipped. Pick up when operator is ready to put the listing live.

## [T-40] Enforce Firebase App Check on user-callable Cloud Functions
Status: open
Owner: @backend-engineer + @infra-engineer
Phase: cross-cutting

Surfaced by the 2026-05-14 callable-permission security review: none of the five user-callable Cloud Functions (`getMyPendingRequests`, `runImportNow`, `markRequestComplete`, `syncApplyFix`, `installScheduledJobs`) currently enforce App Check. Any signed-in Firebase Auth user can invoke them from any origin (web, mobile, curl, scripts). The existing per-callable `kindooManagers` doc check is the only authorization gate.

Add App Check enforcement so calls without a valid App Check token are rejected at the Functions runtime. Defense-in-depth against bot / scripted / MITM invocation — does not replace the per-callable manager auth check. Web app (Firebase Hosting) registers via reCAPTCHA Enterprise; Chrome extension needs a separate App Check provider (custom debug provider during development; production attestation TBD — operator decision).

## [T-41] Enable Firestore TTL on `platformAuditLog`
Status: open (re-opened 2026-05-19 — Phase 12.3 shipped, see `docs/changelog/phase-12.3-create-stake.md`)
Owner: @infra-engineer (operator runs gcloud) + @tad
Phase: cross-cutting

T-15 closed 2026-04-29 by enabling Firestore TTL on the `auditLog` collection-group. The sibling `platformAuditLog` collection (superadmin records — see Q20) was originally deferred at operator's discretion.

**2026-05-18: no production code writes to `platformAuditLog` today.** The type, zod schema, doc-ref helpers (`platformAuditLogRef` / `platformAuditLogCol` in `apps/web/src/lib/docs.ts`), and Firestore rules all exist as scaffolding, but no caller invokes them — `grep -rn 'platformAuditLogRef\|platformAuditLogCol'` returns only the definitions. The collection is empty in production; enabling TTL now would expire zero rows. The Phase 12 `createStake` callable (sub-deliverable 12.3) will be the first production writer; re-open this task when 12.3 lands.

**2026-05-19: 12.3 has shipped.** The `createStake` callable writes `platformAuditLog` rows in production (one row per stake create, with `ttl` = 365 days from write time stamped at write). The collection is no longer scaffolding-only — every new stake provision now lands a row. Run the gcloud command below against staging then production to wire Firestore's TTL deletion against the `ttl` field.

When Phase 12's `createStake` lands, the work needed:

```
gcloud firestore fields ttls update ttl \
  --collection-group=platformAuditLog \
  --enable-ttl \
  --project=<staging-project>
```

Repeat for production. Decide retention duration before enabling (the in-code default for `auditLog` is 365 days; superadmin records may warrant longer — operator decision). Add a corresponding subsection to `infra/runbooks/provision-firebase-projects.md` next to the existing TTL setup notes.

## [T-42] Multi-scope Kindoo users straddling home + foreign sites
Status: done (2026-05-17 — PR #131)
Owner: @extension-engineer
Phase: Kindoo Sites — Phase 4 follow-up

**Closed by PR #131 (Phase A implementation).** Phase A data-model + behavioural changes shipped across `packages/shared/`, `functions/`, `extension/`, and `apps/web/`: `Seat.kindoo_site_id` + per-`duplicate_grants[]` field, importer fan-out per (scope, site), `markRequestComplete.planAddMerge` stamps the new duplicate's `kindoo_site_id`, one-shot migration callable `backfillKindooSiteId`, sync detector per-site fan-out (replaces `pickPrimarySegment` collapse), provision orchestrator per-site building union. Spec §15 "Multi-site grants" subsection rewritten in present tense. Migration is operator-invoked once per stake. See `docs/changelog/t-42-multi-site-grants.md`.

**Spec for the fix was defined in PR #130 (docs-only); the implementation PR (#131) landed it across all four workspaces. Acceptance criteria below preserved for history.**

Surfaced by PR #122 review (2026-05-16). The Phase 4 sync detector resolves a Kindoo user's site by collapsing the parsed Description down to a single primary segment via `pickPrimarySegment` (auto-matching is the primary tiebreaker). A Description that legitimately straddles home + foreign wards — e.g. `'Maple Ward (Bishop) | Pine Ward (Stake Clerk)'` with Maple on the home site and Pine on a foreign site — has both segments resolve to real wards on different sites, but `pickPrimarySegment` picks one. The unpicked segment's site loses visibility of the user entirely: that site's sync view never sees them, and on both sides the asymmetry manufactures spurious `sba-only` / `kindoo-only` drift for the same person.

Documented as a known limitation in `docs/spec.md` §15 Phase 4 prose. The current operational consequence is that a person cannot simultaneously surface on both home-site and foreign-site sync views.

**Fix shape (open).** The detector needs to fan a multi-site Description out into per-site classifications instead of collapsing to one primary segment, then run the diff per-site. Likely involves teaching the detector to emit one `KindooUserClassification` per distinct `kindoo_site_id` covered by the parsed segments, and teaching the sync diff to include / exclude Kindoo users per-site based on whether any of their segments lives on the active site. Stake-scope segments stay home-only (per Phase 1 policy).

**Files implicated (high-level).**
- `extension/src/content/kindoo/sync/detector.ts` — `pickPrimarySegment` callsites at lines ~267, ~301, ~486, ~507; the classifier currently keys off a single primary segment.
- `extension/src/content/kindoo/sync/activeSite.ts` — the active-site resolver; likely unchanged, but the diff layer that consumes its output needs to gain per-site fan-out.
- Spec §15 Phase 4 prose — drop the "known limitation" paragraph once the fix lands.

**Acceptance.** All of the following must hold. (Phase A spec landed in PR #130 — see spec §15 "Multi-site grants — data model (planned, T-42)". A T-42 implementation PR that fixes only the sync detector does not close T-42 — every responsibility below must ship together so the data model and every consumer move in lockstep.)

1. **Sync detector — ward + foreign-ward.** A Kindoo user with Description `'Maple Ward (Bishop) | Pine Ward (Stake Clerk)'` (Maple home, Pine foreign) appears on both the home-site sync view and the foreign-site sync view, each with the site-scoped expectation correctly derived from that site's segment.
2. **Sync detector — stake + foreign-ward.** A Kindoo user with Description `'<StakeName> (Stake Clerk) | Pine Ward (Elders Quorum President)'` (where `<StakeName>` matches the home stake and Pine is on a foreign Kindoo site) appears on both the home-site sync view (with the stake-segment expectation) and the foreign-Pine sync view (with the EQP expectation). Today `pickPrimarySegment` prefers stake on tie, so this user disappears from the Pine view; the fix must surface them on both. Neither side manufactures `sba-only` / `kindoo-only` drift for the user when SBA's grants match each site's segment-derived expectation.
3. **Importer fan-out.** Integration test against a multi-site LCR fixture: a person with callings on both home and at least one foreign site, processed by the importer, produces a seat whose top-level `kindoo_site_id` matches the primary's site and whose `duplicate_grants[]` includes one entry per **(scope, kindoo_site_id)** combo other than the primary, each carrying that site's `kindoo_site_id`, the per-scope calling list, and per-scope `building_names`. Two foreign wards on the same foreign site produce two duplicate entries (same `kindoo_site_id`, distinct `scope`). Within-site priority losers continue to land with `kindoo_site_id === primary.kindoo_site_id` (no regression).
4. **Importer parallel-site duplicate carries `building_names`.** Importer fan-out integration test asserts a parallel-site duplicate carries a non-empty `building_names` array derived from its scope.
5. **`Seat.kindoo_site_id` written top-level.** Every importer-produced seat doc (and every seat doc written by `markRequestComplete`) carries `kindoo_site_id` at top level: derived from primary scope + ward (stake-scope ⇒ home). Verified by unit test + integration test.
6. **Provision orchestrator per-site writes — sequential walk.** Given a seat whose primary + duplicates span N distinct `kindoo_site_id` values, the orchestrator walks the plan sequentially in stable order: one Kindoo write per distinct site, each using the matching active Kindoo session and writing the union of `building_names` from grants on that site. Within-site priority losers do not produce a separate write. At each step the Phase 3 EID check validates the active session matches the step's `kindoo_site_id`; on mismatch the orchestrator refuses with the existing "switch to site X" error and the operator switches sites in the Kindoo UI before retrying. Each per-site write is atomic at the Kindoo level; a half-progressed plan is recoverable by re-running from scratch. Verified by extension integration test with a multi-site fixture seat.
7. **Request-completion auto-merge stamps `kindoo_site_id`.** A `markRequestComplete` call that auto-merges a new manual / temp grant onto an existing seat's `duplicate_grants[]` stamps `kindoo_site_id` on the new entry, derived from the request's scope and ward lookup. The path is `planAddMerge` in `functions/src/callable/markRequestComplete.ts:113`. Verified by Cloud Functions integration test.
8. **One-shot migration.** Running the migration callable over a fixture stake with N seats (mix of home, foreign-only, multi-site) populates `kindoo_site_id` on every seat doc and every `duplicate_grants[]` entry. Idempotent — second run produces no diffs (the migration reads existing `kindoo_site_id` and skips docs where the derived value already matches; first run writes ~500-750 audit rows, re-runs write 0). Missing-ward `duplicate_grants[]` entries are skipped with a logged warning (no error, no "home" fallback). The migration uses a dedicated `migration_backfill_kindoo_site_id` audit action code. The callable takes a `stakeId` parameter.
9. **`Seat.duplicate_scopes` denormalisation.** Every Seat doc carries `duplicate_scopes: string[]` mirroring `duplicate_grants[].scope`. Written by every seat-write path: (i) importer fan-out, (ii) `markRequestComplete.ts` fresh-seat create branch, (iii) `markRequestComplete.planAddMerge` merge branch, (iv) `removeSeatOnRequestComplete.planRemove` promote + drop_duplicate paths, (v) `functions/src/callable/syncApplyFix.ts` kindoo-only fresh-seat create, (vi) `apps/web/src/features/manager/queue/hooks.ts` web-side queue-completion seat write, and (vii) the one-shot migration backfill. Verified by integration tests asserting `duplicate_scopes` matches `duplicate_grants.map(d => d.scope)` after each write path, plus a migration test asserting the field is populated on every seat after a one-shot run. Server-maintained — clients never write this field; rules forbid it via the `hasOnly` allow-list on the seat update predicate and a size-zero requirement on the seat create predicate.

**`packages/shared/` types deliberately lagging.** The Phase A spec PR updates `docs/firebase-schema.md` to document `Seat.kindoo_site_id` and `DuplicateGrant.kindoo_site_id`, but the matching zod schema (`packages/shared/src/schemas/seat.ts`) and TypeScript type (`packages/shared/src/types/seat.ts`) are intentionally NOT updated in the spec PR. Per `packages/shared/CLAUDE.md`'s "schema doc + zod + type stay in sync" rule, the T-42 implementation PR must add the field to both the zod schema and the TS type alongside the importer / orchestrator / migration code changes.

## [T-43] T-42 Phase B implementation — roster surfaces for parallel grants
Status: done (2026-05-17 — PR #134)
Owner: @web-engineer (coordinate with @backend-engineer on the small `functions/` + `firestore/rules` + `packages/shared/` server-side hook)
Phase: Kindoo Sites — Phase B (multi-site roster surfaces)

**Resolved 2026-05-17 — PR #134.** Phase B shipped end-to-end: AllSeats multi-row rendering (one row per grant), per-row foreign-site badge, Edit-disabled-with-tooltip + functional Remove on duplicate rows, Reconcile UI removed; broadened inclusion on Bishopric / Stake / Ward Rosters + Manager Dashboard rollups via two-query union (KS-10 Option b); composite `(member_canonical, scope, kindoo_site_id)` pending-removal discriminator; `kindoo_site_id` optional on remove requests + threaded through `planRemove`; bishopric `seats.read` widened against `duplicate_scopes`. KS-10 resolved as Option b. Spec §15 Phase B rewritten to present tense. See [changelog/t-43-phase-b-roster-surfaces.md](changelog/t-43-phase-b-roster-surfaces.md).

**Spec defined in the T-42 Phase B spec PR (companion to this entry); Phase A data-model spec landed in PR #130. T-43 closes when the Phase B implementation PR lands.** Cross-ref `docs/spec.md` §15 "Phase B — roster surfaces for parallel grants (planned)".

T-42 Phase A made the data model and the Kindoo-side writes correct per-site. T-43 closes Phase A's visibility gap in the Manager UI: today's roster pages render the primary grant only, so a person with parallel-site duplicates is invisible on the foreign side and on every non-primary scope's view.

**Prerequisites (blockers).**
1. The T-42 Phase A migration callable (`migration_backfill_kindoo_site_id`) must have run on every target stake before T-43 rolls out — Phase B's `isParallelSite` predicate is meaningless on un-migrated seats.
2. **Phase A's data model must include `Seat.duplicate_scopes: string[]` on every seat-write path** — a denormalized mirror of `duplicate_grants[].scope` required by the `seats.read` rule widening (CEL cannot project across an array of objects, so the rule must read a primitive-array mirror). Phase A writers covered: (i) importer fan-out, (ii) `functions/src/callable/markRequestComplete.ts:381` (fresh-seat create branch), (iii) `markRequestComplete.planAddMerge` (line 113+, merge branch), (iv) `functions/src/callable/syncApplyFix.ts:239`, (v) `apps/web/src/features/manager/queue/hooks.ts:131` (web-side queue-completion seat write), and (vi) the T-42 one-shot migration. T-43 cannot ship until Phase A covers all six paths. Coordinate with the Phase A implementation owner before starting T-43; the Phase A subsection in spec §15 will be updated by the Phase A implementation PR to document the field.

**Surfaces in scope.**
- `apps/web/src/features/manager/allSeats/AllSeatsPage.tsx` — multi-row rendering, one row per grant; Edit disabled with tooltip on duplicate rows; Remove functional on duplicate rows; **delete Reconcile button + `ReconcileDialog` (lines ~417+) + the import of `useReconcileSeatMutation` + related state and tests in `AllSeatsPage.test.tsx`**.
- `apps/web/src/features/manager/allSeats/hooks.ts` — **delete `useReconcileSeatMutation` and `ReconcileSeatInput` interface** (`hooks.ts:98+`). The mutation is client-only — verified no `reconcileSeat` callable exists in `functions/src/callable/` (the directory contains only `getMyPendingRequests`, `installScheduledJobs`, `markRequestComplete`, `runImportNow`, `syncApplyFix`). No server-side deletion required.
- `apps/web/src/features/requests/rosterPending.ts` — `partitionPendingForRoster` widens the `pendingRemovesByCanonical` map key from `member_canonical` (single string) to `(member_canonical, scope, kindoo_site_id)` (composite key). All callsites in `apps/web/src/features/stake/WardRostersPage.tsx`, `apps/web/src/features/stake/RosterPage.tsx`, and any AllSeats badge consumers update to look up by the composite key.
- `apps/web/src/features/bishopric/RosterPage.tsx` + `apps/web/src/features/bishopric/hooks.ts` — broadened inclusion (any-grant scope match), single row.
- `apps/web/src/features/stake/RosterPage.tsx`, `apps/web/src/features/stake/WardRostersPage.tsx`, + `apps/web/src/features/stake/hooks.ts` — same widening; also update to the new composite pending-removal key.
- `apps/web/src/features/manager/dashboard/DashboardPage.tsx` — per-scope rollups widen the same way; collapse same-scope duplicates so a seat isn't double-counted on one bar.
- `apps/web/src/lib/kindooSites.ts` — `siteLabelForSeat` (or a sibling helper) extended to apply per-row / per-grant.
- `packages/shared/src/schemas/request.ts` — new optional `kindoo_site_id?: string | null` on remove requests (zod + TS type).
- `functions/src/triggers/removeSeatOnRequestComplete.ts` — `planRemove` (lines 77-94) keys on `(scope, kindoo_site_id)` rather than `scope` alone. Scope-only fallback for legacy remove requests preserved. (Not `markRequestComplete.ts` — the callable's remove branch only reads `seatSnap.exists`; the scope-aware walking of `duplicate_grants[]` lives in this trigger.)
- `firestore/firestore.rules` — one change: widen the bishopric clause of `seats.read` so bishopric reads cover seats whose `duplicate_scopes` mirror includes a scope matching the reader (using `hasAny`), not only primary-scope matches. **Stake-presidency clause needs no widening** — `isStakeMember(stakeId)` already grants unrestricted seat reads in the stake. **No change required on `requests.create`** — the existing predicate doesn't enforce a field allowlist, so the new optional `kindoo_site_id` field on remove requests passes through unchanged; an optional defense-in-depth `kindoo_site_id is string` type-check is implementer's call.

**Acceptance** (verbatim from the Phase B spec subsection):

1. **AllSeats multi-row.** A seat with one primary + two `duplicate_grants[]` entries renders 3 rows. Each row's columns reflect the grant. Verified by RTL test.
2. **AllSeats — within-site priority loser visible.** A seat with primary `scope='Maple'` and a duplicate with `scope='Maple'` renders 2 rows. Verified by RTL test.
3. **Bishopric Roster — broadened inclusion.** A seat with primary `scope='stake'` and a `duplicate_grants[]` entry with `scope='Maple'` appears on Maple's bishopric roster (was invisible pre-Phase-B). Single row. Row's columns reflect the Maple duplicate.
4. **Stake Roster — broadened inclusion.** A seat with primary `scope='Maple'` and a stake-scope duplicate appears on the stake-scope view. Single row.
5. **Manager Roster / Dashboard rollups — broadened inclusion.** Whichever manager-side per-scope summaries exist similarly widen inclusion.
6. **Foreign-site badge** renders per-row based on the rendered grant's `kindoo_site_id`, not the seat's primary `kindoo_site_id`.
7. **Edit Seat dialog unchanged behavior.** Still edits primary only. Edit button on a duplicate row is disabled with the specified tooltip.
8. **Remove on duplicate row — functional.** Clicking Remove on a duplicate row generates a `remove` request scoped to **that duplicate's (scope, kindoo_site_id)**. When marked complete, only that `duplicate_grants[]` entry is removed; primary + remaining duplicates stay intact; the Kindoo removal write goes to the correct foreign site. Verified by Cloud Functions integration test + RTL test.
9. **Sort/filter** on AllSeats: each row sorts independently by its own grant's fields (no special grouping by seat). Per operator: "if users hit issues, fix then." No acceptance test needed beyond not breaking today's sort logic.
10. **`seats.read` rule widened on the bishopric clause for any-grant scope match.** A bishopric member of ward X can read a seat whose primary is `scope='stake'` (or some other ward) and whose `duplicate_grants[]` includes an entry with `scope='X'` (mirrored on `duplicate_scopes`). Stake-presidency reads need no widening: `isStakeMember(stakeId)` already grants unrestricted seat-reads. Verified by `firestore/tests/` rules unit tests covering the bishopric-via-duplicate read path, plus a negative test that a non-matching outside-stake reader is still denied.
11. **`Seat.duplicate_scopes` denormalized field present on every seat-write path.** Every Seat doc carries `duplicate_scopes: string[]` mirroring `duplicate_grants[].scope`. Written by every seat-write path: (i) importer fan-out, (ii) `markRequestComplete.ts:381` (fresh-seat create branch), (iii) `markRequestComplete.planAddMerge` (line 113+, merge branch), (iv) `syncApplyFix.ts:239`, (v) `apps/web/src/features/manager/queue/hooks.ts:131` (web-side queue-completion seat write), and (vi) the T-42 migration backfill. Owned by Phase A; Phase B will not ship until Phase A's PR covers all six paths. Verified by integration tests asserting `duplicate_scopes` is populated post-write on every path, plus a migration test asserting the field is populated on every seat after a one-shot run.
12. **Reconcile removed.** The Reconcile button on AllSeats, `ReconcileDialog`, `useReconcileSeatMutation`, and the related tests are deleted from the codebase. Phase B's multi-row rendering subsumes the surface. No server callable exists for `reconcileSeat` (the mutation was client-only), so no Cloud-Functions deletion is required.
13. **Pending-removal badge discriminates by `(member_canonical, scope, kindoo_site_id)`.** A pending `remove` request for grant `(memberX, scope='Maple', kindoo_site_id=<foreign-east>)` lights up the badge ONLY on the East-Stake-Maple row, not on the home-Maple row. Two same-scope rows on the same `kindoo_site_id` (true within-site collision) still both light up. Verified by RTL test against `partitionPendingForRoster` (or its replacement) and against the AllSeats / Roster surfaces that render the badge.

**Out of scope** (explicit, mirrors spec §15 Phase B): Edit Seat multi-grant editing; Mark Complete callout / hint about parallel-grant creation; Dashboard hint that the same person appears on two ward bars; Audit Log grouping; any layout change to per-scope roster pages beyond inclusion-logic widening.

**Sequencing.** T-43 has three hard prerequisites — distinct events, all must land before T-43 rolls out:
1. **T-42 Phase A code lands** (`feat/t-42-phase-a-implementation` merged to main). Brings the schema, importer fan-out, orchestrator per-site walk, `markRequestComplete` `kindoo_site_id` stamping, the new `Seat.duplicate_scopes: string[]` denormalized field on every write-path, and the one-shot migration callable.
2. **Phase A includes `Seat.duplicate_scopes`** on the importer fan-out, `markRequestComplete.planAddMerge`, and the migration. CEL cannot project across an array of objects, so the Phase B rules widening depends on this primitive-array mirror. If the Phase A PR merges without it, T-43 is blocked until a follow-up adds it. The Phase A implementation agent must be notified.
3. **T-42 Phase A migration callable run on production** (and any other live stakes). Without this, every existing seat's top-level `kindoo_site_id`, each `duplicate_grants[]` entry's `kindoo_site_id`, and `duplicate_scopes` are `undefined`, so the `isParallelSite` predicate is always false and the rules-side `duplicate_scopes.hasAny(...)` check is a no-op — Phase B's behaviour degrades to today's primary-only rendering (graceful no-op, not a misclassification, but Phase B is meaningless until the data is populated).

**Open questions blocking T-43 implementation start.**
- **KS-9** (open-questions.md) — disambiguator for same-scope same-site duplicate-row Remove. AC #2 + AC #8 require Remove on a same-scope same-site duplicate row to splice only that duplicate, but the spec'd `(scope, kindoo_site_id)` matching collapses to scope-only here. Likely fix: per-grant UUID on `duplicate_grants[]` — a Phase A scope addition. Phase A implementation agent decides.
- **KS-10** (open-questions.md) — roster-hook query shape under broadened inclusion. Pick: drop the `where` and full-scan vs. two-query union (`scope == X` ∪ `duplicate_scopes array-contains X`). Resolves at Phase B implementation time.

T-43 can ship as a single PR or as a web-side PR followed by a small server-side PR — implementer picks. The Phase B implementation PR rewrites the spec §15 Phase B subsection from future to present tense.

## [T-44] SPA email magic link sign-in
Status: done (2026-05-18 — PR #140)
Owner: @web-engineer
Phase: cross-cutting (post-Phase-11)

Replace the SPA's Google sign-in button with an email magic link flow. Spec defined in `docs/spec.md` §4.1 "Sign-in providers" (companion to this entry — PR that lands T-44 reads from §4.1 and §5.0). No backend changes; the Firebase Auth Email/Password provider with the Email-link sub-toggle is already enabled at the Console level alongside the existing Google provider (which the Chrome extension still uses and must keep using).

**Surfaces in scope.**
- `apps/web/src/features/auth/SignInPage.tsx` — remove the Google button + `signInWithPopup` wiring; render an email input + "Send me a sign-in link" primary CTA in the hero. Topbar CTA scrolls/focuses the hero form. Add a short note explaining that new sign-ins land in pending authorization until a stake manager adds their email (verbatim suggestion in §4.1; refine if a more natural phrasing is found in copy review). Swap to a "Check your email" confirmation state after submit.
- `apps/web/src/features/auth/signIn.ts` — replace `signInWithPopup(GoogleAuthProvider)` with `sendSignInLinkToEmail(auth, email, actionCodeSettings)` + the matching `signInWithEmailLink` call on the action-handler route. Stash the typed email in `localStorage` between the two halves of the round-trip; clear it on success.
- New action-handler route — unauthed (the user isn't signed in yet at the time the link is opened). Path is implementer's choice (suggestion: `/auth/email-link` or `/auth/action`). Reads `localStorage`; if absent (cross-device), prompts the user for the email the link was sent to. Calls `signInWithEmailLink`. On success, redirects to `/`. On error (expired / malformed / mismatch / network), renders a clear error message + a "re-send" affordance back to the sign-in flow.
- `actionCodeSettings`: `url` = full URL of the action-handler route on the host that issued the link; `handleCodeInApp: true`. Per spec §4.1 "Deployment prerequisites," verify before ship that the Firebase **Auth** Authorized Domains list (Console → Authentication → Settings → Authorized domains — distinct from the Hosting custom-domain config in §12) contains `stakebuildingaccess.org`, `kindoo.csnorth.org`, and `kindoo-prod.firebaseapp.com`. A missing entry surfaces as `auth/unauthorized-continue-uri` at `sendSignInLinkToEmail` time.
- Tests — three existing files hard-code Google-only assertions / `signInWithPopup` mocks and will fail CI when the Google button is removed. They need **rewriting in place** (not just additions):
   - `apps/web/src/features/auth/SignInPage.test.tsx` — drop the "Sign in with Google" button-presence assertion and the `signIn()` mock that resolved a `signInWithPopup` flow; replace with assertions on the email input, the "Send me a sign-in link" CTA, the post-submit "Check your email" confirmation state, and the new-user explanatory sentence.
   - `apps/web/src/features/auth/signIn.test.ts` — drop the `signInWithPopupMock` setup and the `GoogleAuthProvider` assertion; replace with mocks for `sendSignInLinkToEmail` + `signInWithEmailLink` (happy path, cross-device prompt, error branches, `localStorage` stash/clear lifecycle).
   - `e2e/tests/auth/sign-in-button-renders.spec.ts` — the existing `getByRole('button', { name: /Sign in with Google/i })` strict-mode assertion no longer applies; rewrite the spec around the new email-input + "Send me a sign-in link" form. Verify both the hero CTA and the topbar CTA still resolve unambiguously under Playwright strict-mode `getByRole`.
   - `e2e/tests/auth/auth-flow.spec.ts` — verify Google-specific assertions / mock helpers within and update them to the magic-link flow.

   Plus new RTL coverage of the action-handler route: (i) happy path with `localStorage` populated, (ii) cross-device branch where `localStorage` is empty and the route prompts for the email, (iii) error branches (`auth/invalid-action-code` expired-link, `auth/argument-error` malformed, email-mismatch, network failure).

**Acceptance** (mirrored from spec §4.1):
1. SPA sign-in page renders no Google button and no password field — only an email input + "Send me a sign-in link" button + the new-user explanatory sentence.
2. Submitting a valid email calls `sendSignInLinkToEmail(auth, email, actionCodeSettings)`, stashes the email in `localStorage`, and swaps the hero to a "Check your email" confirmation state.
3. Clicking the emailed link on the same device → handler reads `localStorage`, calls `signInWithEmailLink`, redirects to `/`, `gateDecision()` runs unchanged.
4. Clicking the emailed link on a different device → handler prompts for the email and then completes sign-in.
5. Error cases (expired / malformed / mismatch / network) render a clear error + offer re-send.
6. A signed-in user with no `access` / `kindooManagers` / `superadmins` doc still lands on the existing `NotAuthorized` page (unchanged authorization path).
7. The Chrome extension's Google auth continues to work unchanged (sanity-test on staging — no code change required, just verify the Firebase Console-level Google provider stays enabled).
8. Existing Google-signed-in users (operator `tad.e.smith@gmail.com`, etc.) can sign in via magic link to the same address and keep their UID, `userIndex/{canonical}`, and every role doc. **This guarantee is load-bearing on Firebase Auth's "one account per email address" Console setting** (default on; spec §4.1 deployment-prerequisite bullet); flipping it to "multiple accounts per email" would mint a second UID on first magic-link sign-in and break every UID-keyed assumption. Verify the setting is ON before T-44 ships.

**Out of scope** (mirrors spec §4.1): email/password (the password sub-toggle stays off); other OAuth providers; self-service authorization or onboarding; changes to the extension's Google-only auth path; backend changes to `onAuthUserCreate` / claim-sync triggers.

Cross-ref: spec §4.1 (sign-in providers), §5.0 (sign-in page layout), §2 (stack — identity).

## [T-45] Remove LCR Sheet importer — Sync subsumes auto-seat ingestion
Status: **[COMPLETE 2026-05-18 — PR #144 squashed as f8c8923; deployed to staging + prod]**
Owner: @backend-engineer + @web-engineer (cross-workspace)
Phase: cross-cutting (post-T-44)

Decision recorded as `architecture.md` D14; spec rewritten in this PR. The extension's Sync feature (`fix.ts` `kindoo-only` path + `classifier.ts`) already creates auto seats from Kindoo-side data via the `syncApplyFix` callable. Kindoo itself ingests LCR via Church Access Automation, so the LCR Sheet importer was duplicating an upstream path. Only `csnorth` has a sheet wired up; removal unblocks multi-stake.

**Surfaces to remove (code):**

- `functions/src/services/Importer.ts`
- `functions/src/scheduled/runImporter.ts`
- `functions/src/callable/runImportNow.ts`
- The Sheets-client wrapper in `functions/src/lib/` (verify path during implementation)
- Tests for all of the above
- `googleapis` dep from `functions/package.json` (it's only used by the importer)
- `apps/web/src/features/manager/import/` (entire feature folder) + colocated tests
- `e2e/` specs that exercise the Import page
- Nav entries pointing to `/manager/import`
- Bootstrap wizard sheet-ID step (in `apps/web/src/features/bootstrap/`) + the corresponding zod schema field on the wizard form
- `packages/shared/` — remove the six deprecated Stake fields from the zod schema + type (`callings_sheet_id`, `import_day`, `import_hour`, `last_import_at`, `last_import_summary`, `last_import_triggered_by`)
- `functions/src/services/EmailService.ts` — `buildOverCapSubject` currently reads `last_import_triggered_by` to format the over-cap email subject (per the pre-removal §9 wording `[Kindoo Access] Over-cap warning after <manual|weekly> import`). Update to produce the post-removal subject `[Kindoo Access] Over-cap warning` (per spec §9) and drop the `last_import_triggered_by` read.

**Surfaces to keep:**

- `wardCallingTemplates` + `stakeCallingTemplates` collections — still used by Sync's classifier
- `give_app_access` + `sheet_order` fields — still used (Sync auto-seat gate + roster sort priority)
- The Configuration tab's Auto Ward/Stake Callings management UI

**Infra (operator-side):**

- Delete the Cloud Scheduler job for `runImporter` on each project (gcloud)
- Revoke the importer's service-account access to the csnorth LCR Sheet (optional cleanup)
- Mark `infra/runbooks/granting-importer-sheet-access.md` (or whichever runbook covers the sheet-sharing protocol) deprecated; cross-reference this T-task
- T-05 (LCR sharing) — mark deprecated, point at T-45

**Acceptance criteria:**

1. **Code-side grep — three scoped checks** all return zero hits:
   - `rg 'runImporter|runImportNow' functions/ apps/web/ packages/shared/ extension/ firestore/ e2e/ infra/` — function-name and file-path references.
   - `rg "'Importer'" functions/src/ apps/web/src/` — literal actor-string writes (the quoted single-quote form matches what the audit-trigger / Cloud Function code writes when it stamps a fresh row).
   - The actor enum / type in `packages/shared/` no longer includes `'Importer'` as a value; the remaining automated actors (`'ExpiryTrigger'`, `'RemoveTrigger'`, `'OutOfBand'`, `'Migration'`, and the `'SyncActor:<code>'` prefix-matched string variant) are preserved, plus the canonical-email string variant for human actors. **Do not drop `RemoveTrigger`, `OutOfBand`, or `SyncActor:*` — those are unrelated to the importer.** (The six deprecated `stake.*` field names ARE expected to remain visible in `docs/firebase-schema.md` §3 as deprecated-block comments until a future cleanup pass; do not gate this AC on stripping them from the doc.)
2. `googleapis` is gone from `functions/package.json` and lockfile.
3. The bootstrap wizard's step 1 no longer collects a sheet ID; tests assert the field is absent from the form.
4. The manager Import page route no longer exists; nav doesn't link to it; the route file is deleted; tests asserting "Import" in the nav are removed.
5. Sync continues to create / update / remove auto seats per existing AC; no regression in `extension/src/content/kindoo/sync/` tests.
6. The six deprecated Stake fields are removed from the zod schema; existing csnorth doc values may persist as vestigial keys on the Firestore doc (operator may manually clear post-merge).
7. `DashboardPage.tsx` no longer reads `stake.last_import_at` (spec §5.3 dropped the "last Sync run if surfaced" Dashboard hedge; the "Last Operations" card surfaces last expiry + triggers reinstall only).
8. CI green; lint + typecheck clean.

**Sequencing.** Spec PR (this one) lands first. Implementation PR follows; operator runs the Cloud Scheduler delete + service-account-access revoke after the implementation PR merges and the new code is deployed.

**Out of scope:** Renaming `access.importer_callings` (the field name is historical post-removal — see `spec.md` §3 reference). Phase 12 multi-stake bootstrap UX. Changes to Sync's classifier or fix paths.

Cross-ref: `spec.md` §8 (rewritten), `architecture.md` D14, `firebase-schema.md` §3 Stake doc.

## [T-46] Phase 12 — multi-stake support promoted to first-class
Status: done (2026-05-20 — all five sub-deliverables shipped: 12.1 PRs #153 + #154, 12.2 PR #155, 12.3 PR #156, 12.4 PRs #157 + #158, 12.5 PR #159)
Owner: cross-workspace (web-engineer, backend-engineer, extension-engineer, infra-engineer, docs-keeper)
Phase: B (closed 2026-05-20)

Phase 12 (current plan) replaces the deferred Phase 12 plan that settled 2026-05-05 with first-class multi-stake support. Three reversals from the prior plan are captured in `firebase-migration.md` F18 / F19 / F20 and rolled up into `architecture.md` D15. Five operator-resolved design decisions (`firebase-migration.md` Phase 12 "Operator-resolved design decisions") are baked into the sub-deliverable scope.

Lands as five sub-deliverables, each on its own implementation PR with its own changelog entry and its own `T-N` when opened:

- **12.1 — Seed runbook + e2e test for the existing `syncSuperadminClaims` trigger.** (in flight as of 2026-05-18 — `feat/12.1-superadmin-seed-v2`.) The trigger already exists at `functions/src/triggers/syncSuperadminClaims.ts` with full mint / revoke wiring through `functions/src/lib/applyClaims.ts`; no new trigger code is needed. 12.1 ships the `infra/runbooks/seed-platform-superadmin.md` runbook for the operator-side console-write step + an end-to-end emulator test that writes a `platformSuperadmins/{canonical}` doc and asserts the claim lands on the matching auth user.
- **12.2 — Stake List page + Superadmin nav section.** `/superadmin/stakes` route gated on `principal.isPlatformSuperadmin`. New "Superadmin" section in `navigation-redesign.md` §8 carries the Stake List entry; section hidden for non-superadmin users.
- **12.3 — `createStake` callable + Create Stake form.** [SHIPPED 2026-05-19, PR #156, see `docs/changelog/phase-12.3-create-stake.md`.] New `createStake` Cloud Function callable (superadmin-gated) writes the `stakes/{slug}` parent doc with `setup_complete=false` and emits a `platformAuditLog` `create_stake` row. Stake List page grows a Create Stake form that calls the callable.
- **12.4 — Active-stake selector + switcher dropdown.** Active-stake resolution priority chain (URL `?stake=X` → `sessionStorage` → `localStorage` → principal-derived first stake) per `spec.md` §2.1. Switcher dropdown in brand bar when principal has ≥ 2 stakes; hidden otherwise. Hardcoded `'csnorth'` constant in `apps/web/src/lib/constants.ts` goes away.
- **12.5 — Extension EID-to-stake mapping.** When a single Kindoo EID maps to configurations under more than one SBA stake the operator manages, the slide-over panel surfaces a stake picker; choice remembered per-EID in `chrome.storage.local`.

Cross-ref: `firebase-migration.md` Phase 12, `architecture.md` D15, `spec.md` §2.1 + §5.4 + §15 Phase 12 interaction, `firebase-schema.md` §3.2 + §3.3, `navigation-redesign.md` §8.

## [T-47] Extension panel doesn't re-resolve on mid-session EID change
Status: open
Owner: @extension-engineer
Phase: post-12.5

`extension/src/panel/App.tsx`'s `resolveStake` only fires on `authState.status` transitions. If the operator navigates within Kindoo from one EID to another without closing the slide-over panel, the previously resolved stake is reused and writes go to the wrong stake. Pre-existing limitation that 12.5 doesn't make worse (the old code was hardcoded to `csnorth`, so navigating EIDs already routed all reads/writes incorrectly), but in a multi-stake world the consequence is more impactful. Reviewer's recommendation on PR #159: revisit if a multi-stake operator reports confusion.

## [T-48] Extension `partialFailure` with surviving candidates silently drops the failure
Status: done (2026-05-20 — PR #160)
Owner: @extension-engineer
Phase: post-12.5

When `resolveEidStakes` returns `partialFailure=true` AND `candidates.length >= 1`, `extension/src/panel/App.tsx` treats the surviving subset as authoritative — auto-picks if length=1, renders the picker if length≥2 — with no signal to the operator that another stake's read failed. For a multi-stake operator whose EID happens to collide across two stakes, a transient read failure on the unseen stake means they work in the wrong queue. Practically extremely rare at the 1–2 requests/week scale. Resolved by widening `resolveEidStakes` to emit `failedStakes: string[]` and rendering a non-modal "Could not read N of your stakes — partial results shown" banner above the picker / auto-picked resolved view. Retry button re-runs the resolver. Auto-pick on length=1 preserved.

## [T-49] Extension `readChoiceMap` swallows `chrome.storage.local.get` rejections
Status: done (2026-05-20 — PR #160)
Owner: @extension-engineer
Phase: post-12.5

`readChoiceMap` in `extension/src/lib/extensionApi.ts` catches `chrome.storage.local.get` rejections and returns `{}`. If a read fails and is immediately followed by `writeEidStakeChoice`, the writer persists a single-entry map and silently erases every other EID's choice. Read failures on `chrome.storage.local` are essentially never observed in practice; this is theoretical hardening. Resolved by propagating read failures from `readChoiceMap` so `writeEidStakeChoice` / `clearEidStakeChoice` refuse to write on a failed prior read. The picker's existing write-error banner surfaces the failure.

## [T-50] Preserve manually-inserted Access rows through imports
Status: done (2026-04-23)
Owner: @tad
Phase: Apps Script era

**Why / what.** The importer currently owns the entire `Access` tab — any row not produced by the current import run gets deleted (see `spec.md` §3.2 "Not manually edited" and §8 step 5). We want to support manual Access entries that survive imports, so a Kindoo Manager can grant app access to someone whose calling doesn't appear in the templates (or who doesn't hold a calling at all).

**What shipped.** Added `source` as a fourth column to the `Access` tab with values `'importer' | 'manual'`. The importer stamps every insert as `source='importer'` and scopes its delete-not-seen step to `source='importer'` rows only; `source='manual'` rows are invisible to the importer. The insert dedup check still considers ALL rows (regardless of source) so the importer will never create a duplicate composite-key row alongside an existing manual row — the B1 decision. Role resolution (`Auth_resolveRoles` → `Access_getByEmail`) is untouched: a manual row grants the same roles as an importer row.

The manager Access page grew write affordances: source badge column, Delete button on manual rows (rejected server-side for importer rows as defense in depth), and an "Add manual access" form at the bottom with email / scope dropdown / reason free-text. For manual rows the `calling` column holds a free-text reason (A1) rather than a literal calling name — same column, same composite PK, UI labels it "Reason".

Two new endpoints: `ApiManager_accessInsertManual(token, row)` and `ApiManager_accessDeleteManual(token, email, scope, calling)`. Both take `Lock_withLock`, write one AuditLog row with `actor_email = principal.email` (not `'Importer'`), and enforce their invariants: insert rejects composite-key collisions against any existing row; delete rejects non-manual rows with a clean error. Scope is validated against `Wards_getAll()` + `'stake'` on insert so a typo can't create an unreachable role grant.

**Migration.** Zero data-migration. The header bump to 4 columns causes a loud `Access header drift at column 4: expected "source", got "…"` error on first read after deploy. Operator adds `source` as column D header by hand. Existing rows' empty `source` cells map to `'importer'` via `Access_normaliseSource_` at the read boundary. Fresh installs (via `setupSheet`) get the 4-col header seeded directly.

**Decisions locked in.** A1 (free-text reason in the shared `calling` column), B1 (importer no-ops on PK collision with any existing row, preserving manual provenance), C1 (UI allows deleting manual rows only).

**Files touched.** `src/repos/AccessRepo.gs`, `src/services/Importer.gs`, `src/api/ApiManager.gs`, `src/ui/manager/Access.html`, `src/ui/Styles.html`, `src/services/Setup.gs`, `docs/spec.md` (§3.1 Access entry + §8 step 5), `docs/data-model.md` Tab 7, `docs/sheet-setup.md` Tab 7.

## [T-51] Convert wide tables to card layout
Status: done (2026-04-23)
Owner: @tad
Phase: Apps Script era

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

## [T-52] Drop `ward_code` from All Seats summary cards
Status: done (2026-04-23)
Owner: @tad
Phase: Apps Script era

**Why / what.** The per-scope summary cards on the manager All Seats page currently display the `ward_code` alongside the ward name. The ward name alone is enough; the code is noise.

**What shipped.** The `scope-sub` line (rendering "ward_code: XX" for wards, "Stake" for the stake pool) is gone from `renderSummaries` in `src/ui/manager/AllSeats.html`; ward_name is the only per-scope label. The orphaned `.all-seats-summary-card .scope-sub` CSS rule was deleted from `src/ui/Styles.html` and the `.scope-label` rule's bottom-margin was bumped from 4px → 6px to keep the spacing to the utilization bar consistent. No server-side change — `summaries[].scope` still carries the ward code, just unused in the card.

**Files likely touched.** `src/ui/manager/AllSeats.html` (and check whether the code surfaces through `ApiManager_allSeats` / `services/Rosters.gs` vs. rendered client-side — the fix goes wherever the card template is).

## [T-53] Rename Config UI labels: calling templates → "Auto ... Callings"
Status: done (2026-04-23 — UI labels only)
Owner: @tad
Phase: Apps Script era

**Why / what.** On the manager Configuration page, the two calling-template section labels should read:

- "Ward Calling Template" → **"Auto Ward Callings"**
- "Stake Calling Template" → **"Auto Stake Callings"**

**What shipped.** UI-label-only rename in `src/ui/manager/Config.html` (not `Configuration.html` — the file is `Config.html`). The two `config-tab-btn` labels now read "Auto Ward Callings" / "Auto Stake Callings". The `label` argument that `renderTemplate` inlined into "No <label> template rows yet" / "Add a <label> calling" was removed (the new labels made those constructions awkward — "No Auto Ward Callings template rows yet"); the surrounding tab already names the template, so the empty-state now reads "No callings yet. Add one below." and the add-form heading reads "Add a calling." Sheet tab names (`WardCallingTemplate` / `StakeCallingTemplate`) and every server-side callsite (`Setup.gs`, `TemplatesRepo.gs`, `Importer.gs`) are untouched. Spec / data-model / sheet-setup docs still reference the existing tab names, which is consistent with a UI-only rename.

**Decisions made.**

- UI label only (the TASKS.md "safer default"). Full sheet-tab rename was not confirmed by the user and would have been a live-Sheet migration.
- If the user later wants the full rename: update `docs/spec.md` §3.1, `docs/data-model.md` section headings, `docs/sheet-setup.md` tab list, plus `src/services/Setup.gs`, `src/repos/TemplatesRepo.gs`, `src/services/Importer.gs` callsites.

**Files touched.** `src/ui/manager/Config.html` only.

## [T-54] Rebuild the Dashboard screen
Status: done (2026-06-06 — closed by the Dashboard card-removal cleanup: PR #210 removed the Last Operations card, PR #215 removed the over-cap Warnings card)
Owner: @web-engineer

**Resolution.** The operator scoped the "rebuild" down to a cleanup. The manager Dashboard now shows three cards — pending-request counts, per-scope utilization, and recent activity. No heavier redesign (new aggregates, feed layout, inline drill-down) was pursued; the design questions below are retained as historical context should a future rebuild be revived.

**Why / what.** The manager Dashboard (the default landing for the `manager` role) needs a redesign. Today it's three cards per `spec.md` §5.3: pending-request counts, recent activity, and per-scope utilization, all driven by live Firestore subscriptions through DIY hooks. (The last-operations card was removed with the expiry scheduler in PR #210; the over-cap warnings card was removed in PR #215.) The user has flagged this as wanting a rebuild; the *what* of the rebuild is still open.

**Decisions to make before coding.**

- Which cards stay, which go, and what replaces them. Is the goal more-dense (more signals per screen), less-dense (a focused "what needs attention right now" landing), or a different shape entirely (e.g., a feed of events rather than counts + bars)?
- New data the server needs to shape. The current dashboard is per-card live subscriptions; a rebuild that needs new aggregates (e.g., request-type breakdown over time, per-requester throughput, expiry forecast) might need additions to the hooks layer or a Cloud Function aggregate.
- Interaction model. Today every tile deep-links into a filtered downstream page. Keep that pattern? Add inline drill-down / expand-in-place?
- Mobile layout. Current grid is responsive and collapses to single-column on narrow viewports. If the new design changes card size / count, confirm it still reads at ~375px.

**Files likely touched.** `apps/web/src/features/manager/dashboard/DashboardPage.tsx`, `apps/web/src/features/manager/dashboard/hooks.ts` (any new aggregates), Tailwind utility tweaks in the component (no global `.dashboard-*` rules), `docs/spec.md` §5.3, `docs/architecture.md` (the utilization-math section near the `Rosters_buildContext_` reuse note), and a `docs/changelog/phase-N-*.md` entry if the rebuild is substantial enough to warrant its own phase.

## [T-55] Use OAuth to try and get rid of the Apps Script warning
Status: done (2026-04-25 — addressed by Chunk 11 iframe wrapper)
Owner: @tad
Phase: Apps Script era

The "warning" referred to the *"This application was created by a Google Apps Script user"* banner. Chunk 11 removed it via a different mechanism than the task originally framed: a static GitHub-Pages-hosted wrapper page at `https://kindoo.csnorth.org` containing a full-viewport iframe to the Main `/exec` URL, with `setXFrameOptionsMode(ALLOWALL)` on every `doGet` HtmlOutput permitting the embed. The top frame never loads Apps Script's banner-bearing outer wrapper page, so the banner is gone. See `docs/changelog/chunk-11-custom-domain.md`. OAuth verification submission to Google was not needed and remains optional — it could remove the first-time per-user consent prompt on the Identity project, which is a different concern from the banner.

## [T-56] Fix the remove button on Roster screens
Status: done (2026-05-05 — closed by PR #58)
Owner: @web-engineer

Closed by the Firebase-era roster work in PR #58 (`feat/roster-pending-requests`): bishopric Roster, stake Roster, stake WardRosters, and manager AllSeats all render a per-row Remove button on manual / temp seats, gated by symmetric ADD-equals-REMOVE authority (the `allowedScopesFor` helper from PR #52). Auto seats are correctly excluded (LCR-managed). The original Apps Script roster's broken remove button has been superseded by the post-cutover Firebase implementation.

## [T-57] Sync grant-derived seat type — Stage 1
Status: done (2026-06-05 — obsolete; superseded by D17 / PR #192)
Owner: @web-engineer (sort, d) · @extension-engineer (detector) · @backend-engineer (shaping)
Phase: extension Sync — "Grant-derived seat type (Stage 1 + Stage 2)", locked 2026-05-30

**Closed 2026-06-05 — obsolete (superseded by `architecture.md` D17 / PR #192).** The config-simplification work deleted the entire calling-template substrate this task targeted: the `wardCallingTemplates` / `stakeCallingTemplates` collections, both Configuration tabs, and the `auto_kindoo_access` / `give_app_access` template fields are gone, and seat **type** is now role-derived (`DepartmentType`) + door-grant-derived, never template-derived. Track (d) ("stop the web reading `auto_kindoo_access` for seat-type classification") is moot — `auto_kindoo_access` has no live-source references left (only stale build artifacts that regenerate clean). Tracks a/b/c/e had already shipped (PRs #178/#179/#180, corrected by #186–#189). Stage 2 (auto-applied promote, revoke-on-promote, provision-time grant check), if still wanted, is a fresh task against today's grant-derived model — not a continuation of T-57. Original Stage-1 content preserved below as trail.

Stage 1 of the Sync grant-derived-seat-type feature (`extension/docs/sync-design.md` §"Grant-derived seat type (Stage 1 + Stage 2)"). Tracks a/b/c/e shipped to main 2026-05-30; track (d) is the only unshipped Stage-1 piece.

**(a) Sort — render-time calling-order (PR #178, @web-engineer) — DONE (2026-05-30).** Roster / All Seats sort decoupled from calling templates: the web computes seat order at render time against a compiled churchwide `calling → order` table instead of the denormalised `seat.sort_order`.
- `packages/shared/src/callingSortOrder.ts` (+ test, exported) — authoritative 85-entry table (operator-locked; stake 1–42, ward 43–85). `callingSortOrder(calling)` / `seatCallingOrder(callings[])` (MIN; null = no match); exact, trimmed, case-insensitive; no wildcards.
- `apps/web/src/lib/sort/seats.ts` (+ test) — bands auto/manual/temp; auto → `seatCallingOrder(seat.callings)`, manual → `callingSortOrder(seat.reason)` (manual seats carry `callings: []`, calling in free-text `reason` per spec §6.1), temp → `end_date` desc. Unknown → band bottom by `created_at` asc then `member_name`. Stops reading `seat.sort_order`. Cross-scope scope-primary (stake first, wards alpha) preserved.
- `apps/web/src/features/manager/allSeats/AllSeatsPage.tsx` — bespoke grant-row sort replaced by a shim feeding the shared comparator, so AllSeats and per-ward rosters order identically.
- `apps/web/src/features/requests/standardCallings.ts` — rewritten to the authoritative 85-entry list verbatim, split at `Bishop` (STAKE 1–42, WARD 43–85), operator spellings exact.
- Spec lockstep: `docs/spec.md` + `docs/firebase-schema.md` §4.6 describe the render-time sort; `sort_order` no longer read client-side (functions' stamping left vestigial; field retained).

**(b/c/e) Detector — grant-based type (PR #179, @extension-engineer) — DONE (2026-05-30).** Extension-only; the `applyTypeMismatch` path carries the grant-derived target.
- (b) Direct-grant detection (`buildingsFromDoors.ts` + `endpoints.ts`): `directGrantBuildings` per user from church-granted rows; per-door dedup prefers the church grant so the overlap/lag case stays observable. (PR #179 originally keyed "church grant" off `AccessScheduleID === 0`; **corrected in PR #188** — real church grants carry `AccessScheduleID: -1` and are identified by their grantor (`GrantedBy.Username === sentry@groups.churchofjesuschrist.org` or `IsSuperApi`). `UserDoorGrantRow.accessScheduleId` → `churchGranted`. See T-63.)
- (c) Grant-based `type-mismatch`: promote (manual + church-backed → auto) / demote (auto + not church-backed → manual) via `isChurchBacked` / `grantsBackAuto`; temp never promoted/demoted; null `directGrantBuildings` skips. Promote payload carries `callings: string[]` (Kindoo-parsed); SyncPanel shows only "Update SBA".
- (e) `callings-mismatch` AUTO-only (operator decision 2026-05-30): fires only for `seat.type === 'auto'` vs `seat.callings`; manual/temp never checked. (Shipped as `extra-kindoo-calling` (append) in #179; renamed + corrected to `callings-mismatch` (replace-to-match-Kindoo, bidirectional set diff) in PR #186 — see T-61.)

**Backend — seat-shape on flip + `callings` consume (PR #180, @backend-engineer) — DONE (2026-05-30).** `applyTypeMismatch` reshapes the seat to the §6.1 convention: promote sets `callings[]` from `payload.callings` (fallback `[reason]`) and clears `reason`; demote folds `callings` into `reason` and clears `callings`. Shared `TypeMismatchPayload.callings?: string[]` (append-only).

Remaining (all superseded by D17 / PR #192 — see closeout note above; preserved as trail):
- **(d) Soft-deprecate `auto_kindoo_access`'s seat-type role (Stage 1 d) — MOOT (D17 removed `auto_kindoo_access` entirely).** Code-only: stop the web reading `auto_kindoo_access` for seat-type classification (the detector now derives type from church direct grants). NOT a UI task — the **Auto Ward Callings** / **Auto Stake Callings** Configuration tabs and BOTH per-row toggles stay fully functional. The two toggles are independent: **"Can Request Access"** (`give_app_access`) is an active, essential feature (SBA web-app access) and is untouched; only **"Auto Kindoo Access"** (`auto_kindoo_access`) is dormant **for type classification** (flag + toggle remain; minor internal uses + validation fallback). Owner: @web-engineer. (Spec reconciliation DONE 2026-05-30 by @docs-keeper — spec §8 "Grant-derived seat type" + the §3.2 `wardCallingTemplates` bullet now describe the grant-derived model; the stale "classifies each Kindoo user's Description against `wardCallingTemplates` / `stakeCallingTemplates`" prose is gone. The code-only web change below remains PENDING.)
- **Stage 2 (separate)** — auto-applied promote, revoke-on-promote, provision-time grant check.

## [T-58] Sync: temp-vs-non-temp divergence no longer detected (deferred)
Status: open
Owner: @extension-engineer
Phase: extension Sync — Grant-derived seat type (Stage 1)

The grant-derived `type-mismatch` (T-57) intentionally skips temp seats (`sbaBlock.type === 'temp'`) and any row where `directGrantBuildings === null`. Consequence: a divergence between Kindoo's `IsTempUser` flag and the SBA seat's `temp` type — in either direction (SBA-temp vs Kindoo-permanent, or SBA-auto/manual vs Kindoo-temp) — is no longer surfaced. The pre-Stage-1 classifier-based check (`intended.type !== sbaBlock.type`) caught these.

**Accepted as a known Stage-1 limitation** (operator decision, 2026-05-30): temp is an `IsTempUser` + expiry concept orthogonal to grant provenance, so folding it into the grant-based promote/demote would conflate two axes. Deferred rather than fixed. If temp drift becomes a real operational gap, add a dedicated `temp-mismatch` discrepancy row keyed on `seat.type === 'temp'` XOR `kuser.isTempUser` (independent of the grant-based type check), with its own fix semantics (Kindoo `IsTempUser` + expiry-date reconcile vs SBA seat-type change). Not in scope for Stage 1.

## [T-59] Sync Kindoo-authoritative — shared-type `SbaOnlyRemovePayload` (cross-workspace)
Status: done (2026-06-02 — PR #183)
Owner: @backend-engineer
Phase: extension Sync — Kindoo-authoritative

Cross-workspace shared-type change landed alongside the Kindoo-authoritative Sync shift (PR #183). `packages/shared/src/types/syncApplyFix.ts` gains `SbaOnlyRemovePayload` (`{ memberEmail: string }`) and a `{ code: 'sba-only'; payload: SbaOnlyRemovePayload }` member on the `SyncApplyFixInput` union; re-exported from `packages/shared/src/types/index.ts` + `packages/shared/src/index.ts`. `SYNC_DISCREPANCY_CODES` (`packages/shared/src/systemActors.ts`) adds `'sba-only'` so the orphan-delete write stamps `SyncActor:sba-only` and renders with the automated-actor chip. Consumed by the `syncApplyFix` callable's new `sba-only` delete path (`functions/`) and the extension's `fix.ts` "Remove From SBA" dispatch. Spec / sync-design / changelog reconciled in the same PR. See `docs/changelog/sync-kindoo-authoritative.md`.

## [T-60] Sync review-rows-actionable — shared-type `KindooUnparseablePayload` (cross-workspace)
Status: done (2026-06-02 — PR #184)
Owner: @backend-engineer

Cross-workspace shared-type change landed alongside the make-review-rows-actionable Sync shift (PR #184). `packages/shared/src/types/syncApplyFix.ts` gains `KindooUnparseablePayload` (`{ memberEmail: string; calling: string }`) and a `{ code: 'kindoo-unparseable'; payload: KindooUnparseablePayload }` member on the `SyncApplyFixInput` union; re-exported from `packages/shared/src/types/index.ts` + `packages/shared/src/index.ts`. `SYNC_DISCREPANCY_CODES` (`packages/shared/src/systemActors.ts`) adds `'kindoo-unparseable'` so the seat write stamps `SyncActor:kindoo-unparseable` and renders with the automated-actor chip. Consumed by the `syncApplyFix` callable's new `applyKindooUnparseable` path (`functions/` — present-but-unparseable Description → seat to `scope='stake'`, `kindoo_site_id` cleared, calling from raw description; auto seats reap the old scope's `importer_callings` and write `importer_callings['stake']` iff the calling matches a `give_app_access` stake template, else no new grant — `writeStakeScopeAccessForUnparseable`) and the extension's `fix.ts` `kindoo-unparseable` "Update SBA" dispatch (gated home-site + Guest + unaligned; non-Guest and parsed-but-no-primary are review-only, and a review row never offers an action). The new `kindoo-no-description` discrepancy code (blank Description, review-only, no action) is **not** in `SYNC_DISCREPANCY_CODES` and has no payload — it never reaches the callable. Spec / sync-design / firebase-schema / changelog reconciled in the same PR. See `docs/changelog/sync-review-rows-actionable.md`.

**Gate superseded by PR #187 (T-62):** the "+ Guest + unaligned; non-Guest...review-only" dispatch gate above no longer holds. The Guest gate was removed; `kindoo-unparseable` is now actionable drift on the home site for **all seat roles**. The shared type and `applyKindooUnparseable` callable are unchanged — only the detector's role-reading went away.

## [T-61] Sync `extra-kindoo-calling` → `callings-mismatch` — shared-type rename (cross-workspace)
Status: done (2026-06-02 — PR #186)
Owner: @backend-engineer

Cross-workspace shared-type rename that corrects the calling-diff fix from append to replace-to-match-Kindoo (PR #186). `packages/shared/src/types/syncApplyFix.ts`: `ExtraKindooCallingPayload` → `CallingsMismatchPayload` and its `extraCallings` field → `callings` (now the FULL Kindoo target set that REPLACES the seat's `callings[]`, not a delta); the union member becomes `{ code: 'callings-mismatch'; payload: CallingsMismatchPayload }`; re-exported from `packages/shared/src/types/index.ts` + `packages/shared/src/index.ts`. `SYNC_DISCREPANCY_CODES` (`packages/shared/src/systemActors.ts`) renames `'extra-kindoo-calling'` → `'callings-mismatch'`. Consumed by the `syncApplyFix` callable's renamed `applyCallingsMismatch` path (`functions/` — REPLACES `callings[]` with Kindoo's parsed set, recomputes `sort_order`, reconciles the scope's `importer_callings` in either direction: `writeAccessForAutoScope` when the new callings earn a grant, else `clearImporterCallingsForScope`; rejects an empty target) and the extension (`detector.ts`: `KindooBlock.extraKindooCallings` → `kindooCallings` (full set), `missingCallings` → `parseKindooCallings` + new `callingSetsEqual` bidirectional set compare; `fix.ts`: button `testId` `add-callings-sba` → `update-sba`; `DiscrepancyCode` union). Corrects the `extra-kindoo-calling` append behaviour from #178/#179/#184: a renamed calling (Kindoo `Bishopric Clerk`, seat `Bishop`) appended to `[Bishop, Bishopric Clerk]` instead of replacing. Spec / sync-design / firebase-schema / changelog reconciled in the same PR. See `docs/changelog/sync-callings-mismatch.md`.

## [T-62] Sync: drop the Guest gate from unparseable + grant reconciliation
Status: done (2026-06-03 — PR #187)
Owner: @extension-engineer
Phase: extension Sync — Grant-derived seat type

Reverses the Kindoo-seat-role gating from PR #181 (grant reconciliation scoped to Guests) and PR #184 (non-Guest present-but-unparseable → review-only). The detector now applies the `kindoo-unparseable` Update-SBA, `type-mismatch` (promote/demote), and `buildings-mismatch` to **all seat roles**. Operator decision: managers can legitimately hold seats, and the role-from-door-rows signal mis-skipped a real church-granted Guest (`gossbc`) whose `UserRole` read as `undefined` from empty door rows. Removed: the `skipGrantReconciliation` predicate, the `userRole` field/plumbing (`KindooEnvironmentUser.userRole`, `getUserAccessRulesWithEntryPoints`/`getUserDoorGrants` no longer return it, the enrichment stamp), and `KINDOO_GUEST_ROLE` (`extension/src/content/kindoo/{endpoints,sync/detector,sync/buildingsFromDoors}.ts`). Kept: the per-check provenance-unknown skips (`directGrantBuildings === null` skips type-mismatch; `derivedBuildings === null` skips auto buildings-mismatch) and the home-site gate on unparseable. SBA still provisions seats as Guest (`KindooInviteUserPayload.UserRole: 2`) — only role-reading was removed. Docs-only: no shared-type or callable change (T-60's `KindooUnparseablePayload` and `applyKindooUnparseable` are untouched). Spec §8 / sync-design / changelog reconciled. See `docs/changelog/sync-drop-guest-gate.md`.

**"All seat roles" re-shaped by PR #189 (T-64):** the **grant-based** `type-mismatch` is no longer all-roles — it now branches on the bulk record's `DepartmentType` enum (Administrator/Manager force `auto`, Guest grant-based, Installer skipped entirely). `kindoo-unparseable` and `buildings-mismatch` remain all-classified-roles. The reliable `DepartmentType` enum replaces #181's fragile door-row `UserRole`; this PR did NOT revert #187's removal of the `UserRole` plumbing.

## [T-63] Sync: church-direct grants identified by grantor, not `AccessScheduleID`
Status: done (2026-06-03 — PR #188)
Owner: @extension-engineer
Phase: extension Sync — Grant-derived seat type

Corrects the church-direct-grant detection from PR #179, which keyed "church grant" off `AccessScheduleID === 0`. Real church grants carry `AccessScheduleID: -1`, not `0`, and are identified by their **grantor**: `GrantedBy.Username === sentry@groups.churchofjesuschrist.org` (new exported const `CHURCH_AUTOMATION_USERNAME`) or `GrantedBy.IsSuperApi === true` (`isChurchGrantedRow`). With the old `=== 0` test, church grants were never recognised → `directGrantBuildings` came back empty → auto seats with full church-granted access were falsely demoted to manual. Latent on `main`; **exposed by PR #187** dropping the Guest gate (the affected church-granted users were skipped before, masking it). The fix: `UserDoorGrantRow.accessScheduleId` → `churchGranted: boolean`; `buildingsFromDoors`'s `direct`/`directGrantBuildings` set derives from `churchGranted`; `all`/`derivedBuildings` unchanged. Docs-only reconciliation here: spec §8, `extension/docs/sync-design.md` (algorithm + prefer-church dedup + (b) status), T-62 (b) annotation. See `docs/changelog/sync-church-grant-detection.md`.

## [T-64] Sync: role-based seat type (`DepartmentType`) + any-church-grant ruleset
Status: done (2026-06-03 — PR #189)
Owner: @extension-engineer
Phase: extension Sync — Grant-derived seat type

Two changes in one PR. **(1) Role branch.** The detector decides seat `type` by branching first on the Kindoo role enum `DepartmentType` (**0 = Administrator, 1 = Manager, 2 = Guest, 3 = Installer**), present on every bulk environment-user record. `kindooRole` (`detector.ts`) maps it to `admin` / `guest` / `installer`. Installer (`3`) → skipped entirely (no rows of any kind, one `continue` before the live-`kuser` branches). Administrator/Manager (`0`/`1`) → `auto` forced (grant check bypassed; PROMOTE a non-`auto` seat). Guest (`2`, or unreadable) → grant-based. `undefined`/missing → `guest` (conservative). New `DepartmentType?: number` on `KindooEnvironmentUser` (`endpoints.ts`, sanitized to number-or-absent). **(2) Any-church-grant correction.** The Guest grant predicate changed from "all of the seat's building doors are church-direct-granted" (all-buildings strict subset) to "ANY church-direct grant": `isChurchBacked` / `grantsBackAuto` now take a single argument, `directGrantBuildings !== null && length > 0`. Promote `manual→auto` on any church-direct grant; demote `auto→manual` only on zero (`[]`, not `null`). The seat's `building_names` no longer enter the type decision. Builds on #187 (Guest gate dropped; #189 reintroduces a role branch on the reliable `DepartmentType` enum, not #181's fragile door-row `UserRole`, and scopes the *grant* decision to Guests) and #188 (grantor-based church signal, kept). Unchanged: the `directGrantBuildings` derivation, `buildings-mismatch` (grant-agnostic, all types), `kindoo-unparseable` (all roles), the provenance-unknown skip, born-as-Guest provisioning. Docs-only reconciliation here: spec §8 (role enum + full ordered ruleset), `extension/docs/sync-design.md` (new "Kindoo role" subsection + detector table + predicate corrections + decision #6 / (b)-status annotations), T-62 annotation. No shared-type or callable change. See `docs/changelog/sync-role-based-seat-type.md`.

## [T-65] Purge orphaned calling templates + stale `ward.kindoo_site_id`
Status: done (2026-06-04)
Owner: @backend-engineer
Phase: cross-cutting

Post-merge data cleanup after PR #192 (config simplification — D17). Two pieces of orphaned data are left in place at merge because both changes self-heal (access on the next Sync, ward site at read time), so neither blocks the merge:

1. **`wardCallingTemplates` / `stakeCallingTemplates` docs** in existing stakes. The collections, their Configuration UI, their rules, and every reader were removed; the docs on disk are now unreachable but still occupy space. Delete them per stake.
2. **Stale `kindoo_site_id` on existing ward docs.** The field was removed from the `Ward` type / schema / form / reads; a ward's site now derives from its building (`resolveWardSite` / `wardSiteMap`). The resolvers ignore any value still on disk, so it is dead data. Strip it from existing ward docs.

One-shot script per stake (operator-run; this is a few wards × one stake at v1 scale — keep it minimal, no friendly errors). Verify against `csnorth` before any future stake. See `docs/changelog/config-simplification.md` "Migration note".

Closed 2026-06-04: a minimal one-shot (`functions/scripts/cleanup-templates-and-ward-sites.mjs`, operator-run via Admin SDK + ADC) ran against staging then prod. Staging `csnorth`: deleted 11 `wardCallingTemplates` + 11 `stakeCallingTemplates`, stripped `kindoo_site_id` from 14 wards. Prod `csnorth`: deleted 11 + 10, stripped 4 wards. Dry-run counts matched the actual run on both. Script deleted after use (spent one-shot, not committed).

## [T-66] Tighten Seat rule — drop orphaned manager direct-update allowlist
Status: closed
Owner: @backend-engineer

Closed 2026-06-04: Removed the manager direct-`update` allowlist from the `seats` rule in `firestore/firestore.rules` (no `allow update` clause now — client updates are denied; verified no remaining client seat-write path in `apps/web/` or `extension/`, only Admin-SDK writers). Updated `firestore/tests/seats.test.ts` to assert manager + non-manager direct `update` is denied. Updated `docs/firebase-schema.md` §seats rules to reflect server-write-only; `docs/spec.md` already consistent (All Seats fields immutable, edits flow through the `edit_*` request → `markRequestComplete` path). `create`/`delete` left as-is (out of T-66 scope).

PR #197 removed the only SPA surface that did a manager direct-write seat edit (All Seats' inline `SeatEditDialog` + `useInlineSeatEditMutation`). Editing a seat is now request-only (the `edit_*` request → `markRequestComplete` completion path). The Firestore rule at `firestore/firestore.rules` (~§seats update, around lines 507–524) still permits `isManager()` direct `update` of `member_name`, `reason`, `building_names`, `start_date`, `end_date` — now an orphaned client-write surface with no UI exercising it. Not a regression (pre-existing, and the spec's "no edit dialog may write SBA directly" language is about UI dialogs), but worth tightening so the rule can't be exercised out-of-band. Proposed: remove the manager direct-update allowlist for these seat fields (request-completion writes go through the Admin SDK / callable, which bypasses rules), OR, if kept, add a rule comment noting the path is currently un-exercised. Test cases to add: "manager direct `update` of `member_name` on a seat should be denied" and "`markRequestComplete`-style completion write still succeeds." Flagged by the automated reviewer on PR #197.

## [T-67] Wards reference buildings by immutable `building_id` slug (additive)
Status: done
Owner: @web-engineer (Part 1: shared + web) · sibling work for @backend-engineer + extension-engineer + @docs-keeper
Phase: cross-cutting

Single coordinated PR on branch `feat/immutable-building-id-ward-slug`. Makes wards reference buildings by the immutable slug `building_id` and makes `building_id` truly immutable. **Additive + backward-compatible**: `ward.building_name` stays populated during the transition so stale browser bundles and the migration window keep resolving; new code is id-first with a name fallback. Grant arrays (`seat.building_names` / `request.building_names`) are OUT OF SCOPE — they remain display-name arrays.

**Shared API contract (Part 1, landed on this branch — code against exactly this):**
- `Ward` type + `wardSchema`: added `building_id?: string` (slug FK to `buildings/{building_id}`, preferred, optional during transition). `building_name: string` stays required + populated.
- `resolveWardBuilding(ward: Pick<Ward,'building_id'|'building_name'>, buildings: readonly Building[]): Building | undefined` — id-first (match `building.building_id` when `ward.building_id` set; else fall back to `building.building_name`; `undefined` if neither resolves; a stale slug that matches nothing also falls back to the name).
- `resolveWardSite(ward: Pick<Ward,'building_id'|'building_name'>, buildings: readonly Building[]): string | null` — **signature changed** from the old `(ward, buildingsByName: Map)` form to the array form; implemented as `resolveWardBuilding(ward, buildings)?.kindoo_site_id ?? null`.
- `buildingNameById(buildings: readonly Building[], buildingId: string | null | undefined): string | undefined` — slug → current display name.
- All three exported from `@kindoo/shared`. `@kindoo/shared` is rebuilt on this branch.

**Web (Part 1, landed on this branch):** building-slug immutability on edit (carry original `building_id`, never re-slug); unique display-name enforcement in the Buildings UI; ward write stores BOTH `building_id` and `building_name`, ward `<Select>` option value = `building_id`; resolution call sites moved to the array API; request-form helpers resolve via `resolveWardBuilding`; building-delete ref-guard uses transitional OR (`w.building_id === b.building_id || w.building_name === b.building_name`).

**Sibling work still owed on this branch (CI red until these land):**
- (a) **@extension-engineer** — update the three `buildingsByName` + `resolveWardSite` call sites (`extension/src/content/kindoo/provision.ts`, `siteCheck.ts`, `sync/detector.ts`) to the new array-based `resolveWardSite(ward, buildings)` API. No more pre-built `buildingsByName` Map.
- (b) **@backend-engineer** — **DONE (2026-06-05)**:
  - (1) **Rules — no change needed (verified).** The `match /wards/{wardCode}` block does role checks (`isManager || isBootstrapAdmin`) + the field-agnostic `lastActorMatchesAuth` integrity check with NO field-shape validation (no `affectedKeys().hasOnly` allowlist, no `building_*` constraint), so the additive optional `ward.building_id` already writes freely. Pinned with a passing test ("manager write carrying the additive building_id slug FK → ok") in `firestore/tests/wards.test.ts` so a future field-shape rule cannot silently reject the slug FK; existing name-only writes still pass.
  - (2) **Ward-backfill migration script** at `functions/scripts/backfill-ward-building-id.mjs` (operator-run, `--dry-run` + apply, ADC auth, `GOOGLE_CLOUD_PROJECT=kindoo-staging|kindoo-prod`). Per stake: for each ward without `building_id`, match the building by `building_name` and set `ward.building_id`; wards whose `building_name` matches no building are logged as `UNMATCHED` + counted (left untouched) so the operator can fix the data. Idempotent. NOT run by the agent (operator runs against staging then prod). Note: because resolution is id-first with a `building_name` fallback, the migration is **not strictly required for runtime correctness** — un-migrated wards keep resolving via the name fallback — it populates the new slug FK so it becomes the primary reference.
  - (3) **Functions FK audit — runtime code WAS affected (not just fixtures).** Five runtime call sites resolved a ward's site via the old `resolveWardSite(ward, buildingsByName(buildings))` Map form and broke against the new array signature: `functions/src/lib/wardSites.ts` (`wardSiteMap`), `functions/src/callable/markRequestComplete.ts` (×2), `functions/src/callable/syncApplyFix.ts`, `functions/src/callable/backfillKindooSiteId.ts`, and transitively `functions/src/triggers/removeSeatOnRequestComplete.ts` (via `wardSiteMap`). All updated to the id-first array API; the redundant `buildingsByName` helper was removed. `backfillKindooSiteId`'s `resolveExpectedSite` now uses `resolveWardBuilding` for its explicit "missing building ≠ home" existence check. New unit coverage in `functions/src/lib/wardSites.test.ts` (id-first, name-fallback, stale-slug-falls-back-to-name, neither-resolves). `building_name` stays on wards for now — dropping it is a deliberate later follow-up, not part of this PR.
- (c) **@docs-keeper** — **DONE (2026-06-05)**: `docs/spec.md` (§3.2 ward/building doc bullets id-first + slug-immutable + unique names; reconciled the stale "cross-collection refs carry the slug" line — ward FK is the slug, grant arrays stay display-name; Configuration + bootstrap bullets) and `docs/firebase-schema.md` §4.2 (`ward.building_id` field + id-first resolution paragraph) + §4.3 (slug immutable post-create, display name mutable + unique-name guard). Changelog: `docs/changelog/t-67-immutable-building-id-ward-slug.md`.

## [T-68] Building rename stales display-name grant arrays
Status: done (2026-06-05 — resolved via option D, prevent-rename guard)
Owner: @web-engineer
Phase: cross-cutting

Renaming a building is now an in-place edit on a frozen `building_id` slug, so the ward → building FK survives (T-67). But existing `seat.building_names` / `request.building_names` (display-name snapshots) and the extension's building-name → Kindoo-rule maps still point at the OLD name until the seat/request is re-saved.

**Resolved 2026-06-05 via option D (prevent-rename guard)** — operator-chosen. Rather than cascade-rewrite the stale arrays (option A) or warn-and-proceed (option B), the Buildings UI now **blocks the rename while references exist**, mirroring the existing `buildingDeleteBlocker`. Shipped: a pure `buildingRenameBlocker(currentName, seats, pendingRequests)` helper next to `buildingDeleteBlocker` in `apps/web/src/features/manager/configuration/hooks.ts`; the Buildings tab subscribes to seats + requests (`useSeats` / `useRequests`) and `useUpsertBuildingMutation` throws the block message when the display name actually changes AND any active seat / non-terminal (pending) request still references the old name. A seat references the building when the name appears in EITHER its primary `building_names` OR any `duplicate_grants[].building_names` (duplicate-site grants — T-43), counted once per seat. Completed / rejected / cancelled requests are historical and don't block. Address / Kindoo-site-only edits (and name-unchanged saves) pass through. Edit is gated until the seats + requests snapshots hydrate (reuses the `…Ready` pattern). Wards are unaffected — the ward FK is the immutable slug, not the display name. Spec: `docs/spec.md` Configuration Buildings bullet. Changelog: `docs/changelog/t-68-prevent-building-rename-when-referenced.md`.

The **cascade (option A)** — a Sync sweep that rewrites stale `building_names` across seats / requests (and the extension's building-name → Kindoo-rule maps) so in-use buildings can be renamed seamlessly — remains the upgrade path if seamless in-use renames are ever needed. Grant arrays intentionally stay display-name (out of scope for T-67 / T-68). Same item the automated reviewer flagged on the T-67 changelog (`docs/changelog/t-67-immutable-building-id-ward-slug.md`).
