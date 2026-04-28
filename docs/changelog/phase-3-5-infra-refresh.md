# Phase 3.5 — Infrastructure refresh + reactfire replacement

**Shipped:** 2026-04-28
**Commits:** see PR [#3](https://github.com/tad-smith/kindoo_access_tracker/pull/3) (17 commits on `phase-3-5-infra-refresh`); predecessor was Phase 3 close `bb6d7a9`. The two CI fixes that landed pre-3.5 in PRs [#1](https://github.com/tad-smith/kindoo_access_tracker/pull/1) (`57a8ebb`) and [#2](https://github.com/tad-smith/kindoo_access_tracker/pull/2) (`3ffded9`) are causally part of this phase even though they merged first.

## What shipped

A modern dependency baseline for the rest of the migration. The unmaintained `reactfire` library is gone, replaced by an in-house Firestore hooks layer at `apps/web/src/lib/data/` consumed directly from the SDK singletons in `apps/web/src/lib/firebase.ts`. The remaining major-version bumps that had been deferred since Phase 1 land in one disciplined pass: Node 22 LTS pinned across local + CI; pnpm 9 → 10; TypeScript 5 → 6; Vite 6 → 8 (rolldown); Vitest 2 → 4; Firebase Web SDK 11 → 12; firebase-functions 6 → 7; `@firebase/rules-unit-testing` 3 → 5; zod 3 → 4 in `@kindoo/shared`; jsdom 25 → 29; esbuild 0.24 → 0.28. All four pre-3.5 acceptance signals (workspace `typecheck && lint && test`, the production `@kindoo/web` build, the rules-tests suite, and the functions emulator integration tests) pass on the new baseline. Behaviour-preserving: every test that passed at the close of Phase 3 still passes.

Phase 3.5 acceptance criteria from `docs/firebase-migration.md` line 613 onward — workspace test/lint/typecheck pass on Node 22.22.2 + pnpm 10, web production build clean, `apps/web/src/lib/data/` hooks tested and ready for Phase 4/5, `reactfire` gone from sources + lockfile + the root `pnpm.peerDependencyRules.allowedVersions` block, D11 in `architecture.md`, Cloud Functions still register under `firebase-functions` v7, Phase 4's sub-task list reflects the reactfire-removed reality, T-14 closed — are all met.

Concretely landed, grouped by slice.

### Slice 1 — toolchain + CI + spec

Four commits (`4e562e8`, `7c1673e`, `b6e0e0a`, `310ec65`):

- **`.nvmrc` (`22`), `.npmrc` (`engine-strict=true`), root `package.json` `engines.node: ">=22"` and `"volta": { "node": "22.22.2" }`.** Three-layer pin: Volta auto-installs the right Node on `cd`; nvm/fnm contributors are covered by `.nvmrc`; npm/pnpm refuses to install on a mismatched runtime via `engine-strict`. Same Node line Cloud Functions v2 runs on, so the emulator no longer warns about local/runtime drift.
- **pnpm `9.15.0` → `10.33.2`** (root `packageManager`). Lockfile re-resolved against pnpm 10's resolver; on-disk `lockfileVersion: 9.0` unchanged. pnpm 10 stops running install scripts by default — verified the esbuild deploy bundle still builds; if a future runtime regresses, opt back in via `pnpm.onlyBuiltDependencies`. Side-effect: prettier 3.4.2 → 3.8.3 patched under the same `^3.4.2` range, which flagged `firestore/firestore.indexes.json` for JSON-array-inline reformatting; auto-fixed by `prettier --write`.
- **TypeScript `^5.7.2` → `^6.0.3`** in root devDeps. Per-workspace `tsconfig.json` inherits `module: ESNext` + `moduleResolution: bundler` from `tsconfig.base.json`; TS 6 accepts both unchanged, no module-resolution tweaks needed.
- **CI workflow** (`.github/workflows/test.yml` mirrored from `infra/ci/workflows/test.yml`): hardcoded `node-version: '22'` → `node-version-file: '.nvmrc'`, single source of truth for Node. Action major bumps to be ready for GitHub's 2026-06-02 Node 24 default flip: `actions/checkout` v4 → v6, `actions/setup-node` v4 → v6, `actions/setup-java` v4 → v5, `pnpm/action-setup` v4 → v5. The `pages.yml` workflow is intentionally untouched — it's the Apps Script wrapper deploy and gets deleted at Phase 11.
- **`docs/architecture.md`** — added **D11** recording the reactfire → DIY-hooks decision. **`docs/firebase-migration.md`** — added the full Phase 3.5 section (goal, sub-tasks, tests, acceptance criteria, out-of-scope) and updated Phase 4's `Dependencies:` line to include Phase 3.5. **`docs/TASKS.md`** — T-14 marked "closing in Phase 3.5".

### Slice 2 — backend + rules-tests dep bumps

Five commits (`74bb04e`, `5b8bebc`, `a443432`, `3fef958`, `329aab3`):

- **`firebase-functions` `^6.1.1` → `^7.2.5`** in `@kindoo/functions`. The v7 line cleans up the legacy v1 surface; the imports we use are unchanged — `firebase-functions/v1/auth` for `auth.user().onCreate` in `onAuthUserCreate` and `firebase-functions/v2/{https,firestore}` for the claim-sync triggers both still register correctly. Verified by all 21 emulator-gated integration tests + 1 unit test.
- **`vitest` `^2.1.8` → `^4.1.5`** in `@kindoo/functions`. Vitest 4 removed `poolOptions.threads.singleThread`; intent ported to the new top-level `maxWorkers: 1` paired with the existing `fileParallelism: false`. Same emulator-shared-state reasoning that motivated the original setting (see Phase 2 changelog "Deviations") survives unchanged.
- **`esbuild` `^0.24.0` → `^0.28.0`** in `@kindoo/functions`. Pre-1.0 dep — treat as semver. Used only by the deploy-artifact bundler in `functions/scripts/build.mjs`; output unchanged (~136 KB `index.js`, `firebase-admin` / `firebase-functions` external).
- **`@firebase/rules-unit-testing` `^3.0.4` → `^5.0.0`, `firebase` `^11` → `^12.12.1`, `vitest` `^2` → `^4.1.5`** in `@kindoo/firestore-tests`. The three move together because rules-unit-testing 5 requires firebase ^12. Public API surface used by tests (`initializeTestEnvironment`, `RulesTestContext`, `RulesTestEnvironment`, `assertFails`, `assertSucceeds`, `withSecurityRulesDisabled`, `authenticatedContext`, `unauthenticatedContext`) is unchanged in v5. All 160 rules tests still pass. Root `pnpm.peerDependencyRules.allowedVersions` updated: `@firebase/rules-unit-testing>firebase` from `11` to `12`.
- **`@types/node` `^22.10.5` declared in `@kindoo/firestore-tests` devDeps + `types: ["node"]` added to `firestore/tsconfig.json`** as a follow-up CI fix. Pre-3.5, vitest 2's transitive dep tree happened to surface `@types/node` in TypeScript's auto-include path; vitest 4 + TS 6 stopped picking it up that way, so `firestore/tests/lib/rules.ts` (which uses `node:fs` / `node:path` / `node:url` and `import.meta.url`) failed CI typecheck. Local pre-push typecheck looked clean because of stale tsbuildinfo cache from before Slice 1's TS bump; CI on a fresh checkout exposed it. Stays on `^22.x` per the Phase 3.5 hard exclusion.

### Slice 3 — apps/web reactfire swap + dep bumps

Eight commits (`23ec728`, `ebd2064`, `1368e1c`, `603da51`, `1c7f4de`, `3610690`, `7ceaafc`, `20551a7`):

- **`apps/web/src/lib/data/`** — new module implementing D11. Three hooks plus a barrel:
  - `useFirestoreDoc<T>(ref)` — `onSnapshot`-driven live subscription on a `DocumentReference<T>`; pushes each snapshot into the TanStack Query cache via `setQueryData`; returns the standard `{ data, status, error, ... }` result shape; `null` ref disables the subscription.
  - `useFirestoreCollection<T>(query)` — same pattern for `Query<T>`; preserves array referential stability via shallow per-element comparison so React doesn't re-render downstream consumers gratuitously.
  - `useFirestoreOnce<T>(refOrQuery)` — one-shot `getDoc` / `getDocs` for cursor-paginated reads (Phase 5's Audit Log); discriminates doc vs query at runtime via the modular SDK type tag.
  - `index.ts` — barrel re-exporting the three hooks; `queryKeys.ts` — small helper for stable cache keys derived from refs/queries.
  Production module total: 565 LoC across the three hook files (459) + `queryKeys.ts` (80) + barrel (26). Test files add another 526 LoC for 17 test cases. Pattern decisions called out below under "Decisions."
- **`reactfire` removed.** `apps/web/package.json` dependency dropped; root `pnpm.peerDependencyRules.allowedVersions.reactfire>firebase: "11"` entry removed; lockfile regenerated; no reactfire entries remain. `apps/web/src/main.tsx` lost `<FirebaseAppProvider>` / `<AuthProvider>` / `<FirestoreProvider>` and the surrounding `<Suspense>` fallback — the provider stack is now just `<QueryClientProvider>` wrapping `<Topbar>` + `<RouterProvider>`. Side-effect import of `./lib/firebase` still drives `initializeApp` + emulator wiring. `usePrincipal()` replaced reactfire's `useUser()` with a direct `onAuthStateChanged` subscription on the auth singleton, seeded from `auth.currentUser` so steady-signed-in mounts don't flicker. Stale doc comments in `useTokenRefresh.ts` / `signOut.ts` / `principal.test.ts` updated.
- **`firebase` `^11` → `^12.12.1`** in `@kindoo/web`. Aligns with Slice 2's firestore-tests bump so the workspace runs one Firebase major across web + tests. Firebase 12 is mostly tree-shaking and v9-compat removal; none of our v9 modular API usage tripped.
- **`vite` `^6.4.2` → `^8.0.10`** + **`@vitejs/plugin-react` `^4.7.0` → `^6.0.0`** in `@kindoo/web` (tied — plugin-react 6 requires Vite 8). Vite 7 dropped Node 18 support; Vite 8 needs Node 20.19+ or 22.12+, both covered by Slice 1's pin. Vite 8 uses rolldown as the default bundler — production build dropped from 1.3s to 184ms. `vite.config.ts` is `plugins: [react()]` with simple server/preview/build options; no Vite 7/8 breakage triggered.
- **`vitest` `^2` → `^4.1.5`** in `@kindoo/web` + `@kindoo/shared`. Neither config used `poolOptions.threads.singleThread`, so no migration needed — both `vitest.config.ts` files passed through Vitest 4 unchanged.
- **`jsdom` `^25` → `^29`** in `@kindoo/web`. No config changes required.
- **`zod` `^3.25` → `^4.0.0`** in `@kindoo/shared`. The bulk of the cross-cutting work: schema syntax updated to v4 across all 13 collection schemas. Also bumped `@hookform/resolvers` `^3` → `^5` in `apps/web/package.json` so it's ready for Phase 4's forms — this is a no-op on `main` since `react-hook-form` itself lives on the `phase-4-spa-shell-wip` branch and gets exercised on rebase.
- **`@types/node` `^22.10.5` declared in `@kindoo/shared` devDeps** as a Slice 2 follow-up. Same root cause as the firestore-tests fix in Slice 2 — vitest 4 + TS 6 stopped picking up `@types/node` transitively, and `@kindoo/shared`'s node-using test code needed it explicit. Stays on `^22.x` per the hard exclusion.

### Pre-Phase-3.5 CI fixes (PRs [#1](https://github.com/tad-smith/kindoo_access_tracker/pull/1) + [#2](https://github.com/tad-smith/kindoo_access_tracker/pull/2))

Three regressions surfaced when CI started running cleanly without earlier failures masking them. They merged to `main` before this branch opened, but they're causally part of Phase 3.5 and worth recording here:

- **e2e `writeDoc` and `setCustomClaims` fixtures hit unauthenticated emulator endpoints** that Phase 3's rules now reject. `writeDoc` got `Authorization: Bearer owner` so the emulator treats writes as service-account-equivalent (the same bypass the Admin SDK uses); `setCustomClaims` switched from the client-side `accounts:update` endpoint to the project-scoped `/v1/projects/{pid}/accounts:update` endpoint with `Bearer owner`. (`e2e/fixtures/emulator.ts`, PR #1.)
- **`e2e/tests/smoke.spec.ts`** still asserted Phase 1's placeholder smoketest heading; Phase 2 replaced it with the SignInPage. Updated to assert the actual anonymous landing heading and renamed accordingly. (PR #1.)
- **CI's outer `firebase emulators:exec --only firestore,auth,functions ...` raced the inner `functions` workspace `test:integration` script's own emulator wrap** for the same ports, failing with "Port 9099/8080 not open" before any test ran. Split into `test:integration` (no emulator boot — CI's outer wrap supplies them) and `test:integration:local` (emulator-booting form for standalone operator runs). Matching root-level recursion script added. (`functions/package.json`, root `package.json`, PR #2.)

**Test outcomes (final, all green on CI run [25064392962](https://github.com/tad-smith/kindoo_access_tracker/actions/runs/25064392962)):**

- `@kindoo/shared`: **69 tests pass** (canonicalEmail, principal, buildingSlug, auditId, schemas — unchanged from Phase 3 close).
- `@kindoo/web`: **32 tests pass** (was 15 pre-3.5; +17 for the new DIY-hooks layer across `useFirestoreDoc`, `useFirestoreCollection`, `useFirestoreOnce`).
- `@kindoo/functions`: **1 unit + 21 integration pass** (unchanged from Phase 2 close).
- `@kindoo/firestore-tests`: **160 rules tests pass** (unchanged from Phase 3 close).
- `@kindoo/e2e`: **5 specs pass** — 4 auth-flow specs + 1 smoke spec, updated for Phase 3 rules + Phase 2 SignInPage heading via the pre-3.5 fixes above.

**Bundle outcomes** (`@kindoo/web` production build): 651 KB / ~198 KB gz on Vite 8 + Firebase 12. Pre-Phase-3.5 reference points: 913 KB / 237 KB gz with reactfire still in the graph (Phase-4-WIP branch with shell components included). Build time dropped from 1.3 s to 184 ms thanks to Vite 8's rolldown bundler.

## Deviations from the pre-phase spec

Phase 3.5's spec is the Phase 3.5 section of `docs/firebase-migration.md` (line 520) plus D11 in `docs/architecture.md`. Implementation matches the spec faithfully. No deviations beyond the implementation gotchas worth recording for future agents:

- **TanStack Query 5's `undefined`-data restriction → sentinel-wrapping in the DIY hooks.** TanStack Query 5 disallows raw `undefined` as a resolved value, but a Firestore doc-not-found is naturally representable that way. Solved by wrapping cache values in `{ value: T | undefined }` and unwrapping on the way out so consumers still see `T | undefined`. Worth recording as a small invariant of the hooks layer; documented inline in `useFirestoreDoc.ts` / `useFirestoreCollection.ts`.
- **Live-subscribed hooks use a never-resolving placeholder `queryFn`.** The `onSnapshot` listener owns state transitions; if `queryFn` resolved, it would race the listener and clobber freshly-arrived data. The `queryFn` returns a `Promise` that never settles, by design. Documented inline.
- **Vitest 4's `poolOptions.threads.singleThread` → `maxWorkers: 1` + `fileParallelism: false` migration.** Required in `@kindoo/functions` and `@kindoo/firestore-tests` (the workspaces with emulator-shared-state reasoning); both `@kindoo/web` and `@kindoo/shared` were unaffected because neither used the dropped option.
- **`@types/node` CI failure mode invisible to incremental local builds.** Vitest 4 + TS 6 stopped surfacing `@types/node` via transitive auto-include; workspaces that used `node:*` builtins or `import.meta.url` needed explicit devDep declarations + `types: ["node"]` in `tsconfig.json`. Local pre-push typecheck looked clean because of stale tsbuildinfo cache from before Slice 1's TS bump; CI on a fresh checkout exposed two workspaces (`firestore-tests`, `shared`) that needed the fix. The failure mode is worth remembering: CI on a fresh checkout is the only signal that catches it.
- **Prettier 3.4 → 3.8 auto-bump caught one indexes-file formatting nit.** `pnpm install --force` after the pnpm 10 bump pulled prettier within the same `^3.4.2` range up to 3.8.3, and 3.6+'s JSON-array-inlining rule flagged `firestore/firestore.indexes.json`. Auto-fixed by `prettier --write` — pure formatting, no semantic change to the index definitions.

## Decisions made during the phase

D11 was authored in Slice 1 (rationale: reactfire unmaintained, react-firebase-hooks inactive, `@invertase/tanstack-query-firebase` live-query support officially WIP) and implemented in Slice 3. No new D-numbers earned beyond it. Two implementation patterns emerged from the build that are load-bearing for Phase 4+ and warrant recording:

- **Sentinel-wrapping (`{ value: T | undefined }`) in the cache** for the DIY hooks. Lets the hooks express doc-not-found as a resolved value while still surfacing `T | undefined` to consumers. The pattern is the price of using TanStack Query as the cache substrate; future hooks added to `apps/web/src/lib/data/` should follow the same shape.
- **Never-resolving `queryFn` for live subscriptions.** The `onSnapshot` listener is the single state-transition owner; any `queryFn` that resolves would race it. Future live-listener hooks should use the same placeholder.

Both patterns are documented inline in the hook source files; D11's "Implementation note" block in `architecture.md` references them.

## Spec / doc edits in this phase

`docs/spec.md` is **not** touched. Phase 3.5 is behaviour-preserving infra; `spec.md` describes Apps Script reality until Phase 11 cutover.

- `docs/architecture.md` — D11 added in Slice 1 (reactfire → DIY hooks decision); D11 "Implementation note (2026-04-28)" appended in this close commit recording the actual versions landed (`apps/web/src/lib/data/` LoC count, TanStack Query `^5.62.10`, Firebase Web SDK `^12.12.1`) plus the two pattern decisions above.
- `docs/firebase-migration.md` — Phase 3.5 section (line 520) added in Slice 1, unchanged at close. Phase 4's `Dependencies:` line already references Phase 3.5.
- `docs/firebase-schema.md` — unchanged. No schema or rule changes this phase.
- `docs/changelog/phase-3-5-infra-refresh.md` — this entry.
- `docs/TASKS.md` — T-14 status flipped to `done (2026-04-28, Phase 3.5 close)`. No new TASKS entries opened by this phase.
- `apps/web/CLAUDE.md` — Vite 6 → 8 in the Stack list; reactfire bullet replaced with "DIY Firestore hooks at `apps/web/src/lib/data/` (per architecture D11)"; convention bullet "All Firestore reads via reactfire hooks" rewritten to point at the DIY hooks.

## Deferred

Items intentionally not in Phase 3.5, with where they land.

- **`@hookform/resolvers` 3 → 5 consumer wiring.** The bump landed on `main` in Slice 3 but `react-hook-form` itself + the form components that consume it live on `phase-4-spa-shell-wip` and don't exist on `main`. Will be exercised when Phase 4 rebases onto post-3.5 `main`. No TASKS entry needed — it's part of the Phase 4 rebase work already on the plan.
- **`@google/clasp` 2 → 3.** Out of scope per Phase 3.5 hard exclusion — the Apps Script side gets deleted at Phase 11 cutover, not worth the work.
- **`@types/node` past `^22.x`.** Out of scope per Phase 3.5 hard exclusion — must match the Node 22 LTS runtime. Documented in `infra/CLAUDE.md`.
- **GitHub Actions Node 24 readiness follow-up.** Slice 1's action major bumps already cover the 2026-06-02 default flip; no separate TASKS entry needed (called out explicitly in the Slice 1 commit message).

## Next

Phase 4 resumes by **rebasing `phase-4-spa-shell-wip` (commit `d38bda1`) onto post-3.5 `main`** and fixing the breakage from this phase's changes: reactfire calls become DIY-hook calls; Vite/Vitest config tweaks where Phase 4's WIP added vitest configuration; zod 4 syntax updates wherever Phase 4's WIP added new schemas; firebase 12 module-resolution wherever Phase 4's WIP imported from `firebase/*`. The DIY hooks layer is ready for Phase 4 (re-applied) and Phase 5 (Audit Log cursor pagination) to consume directly. The typed-doc helper `apps/web/src/lib/docs.ts` (T-16) lands as part of Phase 4's first real query — the DIY hooks accept any `DocumentReference<T>` / `Query<T>` regardless of source, so they're independent of the helper.

The Phase 2 SignInPage and the placeholder Hello page on `main` continue to work as before. Phase 4 is the first phase that materially exercises the new dep baseline against real UI surface.
