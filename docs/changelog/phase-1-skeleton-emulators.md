# Phase 1 — Project skeleton + monorepo + emulators

**Shipped:** 2026-04-27
**Commits:** _(see git log; commit message references Phase 1)_

## What shipped

A pnpm-workspace monorepo at the repo root, sitting alongside the still-running
Apps Script app under `src/` + `identity-project/` + `website/`. Six packages
(`apps/web/`, `e2e/`, `functions/`, `firestore/`, `packages/shared/`, `infra/`)
with the verification gates green locally and the end-to-end "smoketest" the
migration plan calls for working: a Vite-served React page reads
`stakes/_smoketest/hello` from the local Firestore emulator and renders it
(the doc is unseeded; the page handles that gracefully).

Concretely:

- **`apps/web/`** — Vite 6 + React 19 + TS strict + reactfire + TanStack Router
  with code-based routing and a single placeholder route at `/`. Hello page is
  the smoketest.
- **`functions/`** — Firebase Functions 2nd gen + TS strict. One anonymous
  callable `hello` returning `{version, builtAt, env}`.
- **`firestore/`** — `@firebase/rules-unit-testing` helper scaffolded;
  lock-everything `firestore.rules` stub (real rules in Phase 3); empty
  `firestore.indexes.json`.
- **`packages/shared/`** — `canonicalEmail` ported from Apps Script
  `Utils.normaliseEmail` with 11 unit tests covering Gmail dot-strip + `+suffix`
  strip, `googlemail.com → gmail.com` fold, non-Gmail preservation, whitespace,
  casing.
- **`e2e/`** — Playwright with one smoke spec asserting the Hello page heading
  renders.
- **`infra/`** — deploy script skeletons (`deploy-staging.sh`, `deploy-prod.sh`
  with `--dry-run`), CI workflow at `.github/workflows/test.yml` (lint +
  typecheck + test + build), monitoring + runbook skeletons (TODOs filed
  against B1).
- **Root configs** — `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`
  with composite refs to all four buildable workspaces, `firebase.json`
  (Hosting + Functions + Firestore + emulators), `.firebaserc` (placeholder
  project IDs), `.prettierrc.json`, `.prettierignore` (excludes Apps Script
  source + markdown).
- **Per-workspace `CLAUDE.md` files** (7 total) authored before Phase 1
  dispatch.
- **Four agent definitions** at `.claude/agents/`: `web-engineer`,
  `backend-engineer`, `infra-engineer`, `docs-keeper` — replaces the prior
  plan's four-agent set under `.claude/agents/firebase/`, which was deleted.

The verification gates pass locally: `pnpm typecheck`, `pnpm lint`, `pnpm test`
(apps/web vitest, packages/shared 11 tests, functions module-import smoke,
firestore rules-unit-testing against the lock-everything stub via emulator,
e2e Playwright smoke), `pnpm build`.

## Deviations from the pre-phase spec

Phase 1's "spec" is the Phase 1 section of `docs/firebase-migration.md`.

- **`reactfire` pinned to `^4.2.3`, not `^5.x`.** The migration plan F2 stack
  list names reactfire; there is no reactfire 5.x on npm. 4.2.3 is the latest
  stable and its declared peer of `firebase ^9.0.0` works fine against
  `firebase 11.x` because the Firebase modular SDK API has been stable since
  v9. Suppressed via `pnpm.peerDependencyRules.allowedVersions` in root
  `package.json`. Re-evaluate if reactfire ships a 5.x with refreshed peers;
  otherwise stays.
- **`@firebase/rules-unit-testing` peer mismatch handled the same way.**
  Declared peer is `firebase ^10.0.0`; runtime works fine with 11.x. Same
  `peerDependencyRules` entry.
- **Vite TanStack Router plugin removed.** The Phase 1 sub-task lists
  "TanStack Router scaffolded; placeholder route." The plugin
  (`@tanstack/router-plugin/vite`) is for *file-based* routing. Phase 1 uses
  code-based routing in `src/router.tsx`; the plugin without `routesDirectory`
  crashes Vite at config load. Plugin gets re-added in Phase 4 when file-based
  routing lands.
- **`apps/web/tsconfig.json` `rootDir: "."` instead of `./src`.** TS composite
  + `include: ["src", "test"]` requires `rootDir` to cover both. Cosmetic;
  build emits `dist/src/...` and `dist/test/...`, which Vite owns at runtime
  build.
- **`/__/auth/**` rewrite removed from `firebase.json`.** Firebase Hosting
  reserves `/__/auth/**` paths at the edge layer; user rewrites cannot match
  them. The original sub-task suggested this rewrite as a placeholder; it
  would be a no-op. Documented in `infra/runbooks/deploy.md`.
- **Functions lint script dropped `tests/`.** The initial author wrote
  `prettier --check src tests` per the spec, but no `tests/` directory exists
  yet (integration tests under `tests/` land in Phase 4; unit tests are
  colocated under `src/`). Lint script reduced to `prettier --check src`.
  Add `tests` back in Phase 4.
- **Markdown excluded from prettier.** `.prettierignore` contains `**/*.md`.
  Auto-formatting carefully-written specs and changelog entries causes
  format-thrash without value at this project's conventions. Code (TS / JSON
  / YAML) stays prettier-enforced. Re-evaluate if a markdown linter is
  wanted later.
- **Per-workspace tsconfigs use `tsBuildInfoFile`** (e.g.,
  `dist/.tsbuildinfo`, `lib/.tsbuildinfo`, `.tsbuild/`) so incremental
  `tsc -b` cache lands in gitignored locations. `.gitignore` updated.

## Decisions made during the phase

- **`KINDOO_WEB_VERSION` / `KINDOO_FUNCTIONS_VERSION` constants in workspace
  `version.ts` files.** The migration plan calls for build-time stamping via
  `infra/scripts/stamp-version.js`, but the existing stamper writes a
  different export shape (`VERSION` + `BUILT_AT`). Workspace authors followed
  the task spec naming. The follow-up to reconcile (rename `version.ts` →
  `buildInfo.ts` and update tests, or extend `stamp-version.js` to also write
  the per-workspace constants) is captured in `docs/TASKS.md` and is due
  before the first staging deploy in Phase 4.
- **`pnpm exec vitest run` wrap in firestore lint script.** When
  firebase-tools' standalone (282 MB pkg-bundled) binary was on the
  operator's PATH, `firebase emulators:exec` couldn't `require()` ESM-only
  Vitest 2.x. Wrap kept after the standalone was replaced with the
  npm-installed firebase-tools shim; harmless either way and resilient to
  future similar issues.
- **Definition-of-Done added to engineering agent contracts.** During Phase 1
  dispatch, two prettier-formatting failures slipped through because agents
  couldn't run their workspace's lint at author time (pnpm install happens
  after agent work). Updated
  `.claude/agents/{web,backend,infra}-engineer.md` to require
  `pnpm --filter <workspace> typecheck && lint && test` clean before
  reporting "done" from Phase 2 onward, with an explicit Phase-1 bootstrap
  exception noted inline.
- **`firestore/firestore.rules` stays as lock-everything stub.** Phase 3
  writes the real rules per `docs/firebase-schema.md` §6.

## Spec / doc edits in this phase

`docs/spec.md`, `docs/architecture.md`, and `docs/data-model.md` are
deliberately untouched: Phase 1 is bootstrap-only, doesn't change runtime
behaviour, doesn't move an architectural decision, and doesn't reshape data.
Phase 11 cutover is when those docs change.

- `docs/firebase-migration.md` — F2 stack list refined (added `shadcn-ui`
  (Radix + Tailwind) and `vite-plugin-pwa`; locked-in date stamp). F16
  (Resend) and F17 (custom domain TBD) added. Phase 9 SendGrid → Resend
  swap. Phase 11 cutover updated to target a new domain instead of
  `kindoo.csnorth.org` flip. Status banner moved from "paused" to "ACTIVE;
  pre-Phase-1 gating."
- `docs/firebase-schema.md` — renamed from `docs/firebase-alt-schema.md`
  (this is the chosen architecture, not an alt). Title updated to
  "Firebase data model + security rules." Section 8.2 marked Q2 / Q3 / Q4
  RESOLVED 2026-04-27; entries moved to §8.6 alongside the other locked-in
  decisions. Status banner moved from "exploration" to "ACTIVE."
- `CLAUDE.md` (root) — rewritten to reflect dual-world reality during
  migration (Apps Script + Firebase coexist on `main` until Phase 11).
  Per-workspace `CLAUDE.md` pointer table added.
- `docs/CLAUDE.md` — new; `docs-keeper` workspace conventions.
- `apps/web/CLAUDE.md`, `functions/CLAUDE.md`, `firestore/CLAUDE.md`,
  `packages/shared/CLAUDE.md`, `infra/CLAUDE.md`, `e2e/CLAUDE.md` — new
  per-workspace conventions.
- `.claude/agents/{web-engineer,backend-engineer,infra-engineer,docs-keeper}.md`
  — replaced the prior plan's `client-engineer.md` / `server-engineer.md` /
  `infra-engineer.md` / `docs-keeper.md` (which lived under
  `.claude/agents/firebase/` and were deleted).

## Deferred

Items intentionally not in Phase 1, with where they land.

- **B1 — Real Firebase project creation, billing, service accounts, IAM.**
  Operator-deferred 2026-04-27. Blocks the first staging deploy that exercises
  Phase 1 acceptance criteria; doesn't block local-emulator dev. → Operator
  step before Phase 4 ships to staging.
- **B2 — Domain registration** (Resend chosen as email vendor; new TLD TBD by
  operator). Doesn't block Phase 1 emulator-local work. → Operator step
  before Phase 9 ships.
- **B4 — LCR Sheet sharing protocol** (granting view access to importer
  service account). Doesn't block Phase 1; needed before Phase 8 importer
  real runs. → Operator step before Phase 8.
- **`stamp-version.js` ↔ `version.ts` shape reconciliation.** No immediate
  failure (stamper only runs at deploy time, which depends on B1). →
  `docs/TASKS.md` follow-up; reconcile before first staging deploy.
- **Vite chunk-size warning** (firebase SDK is the bulk; >500 KB). Phase 4's
  TanStack Router file-based routing + code-splitting fixes it. →
  `docs/TASKS.md` follow-up.
- **Real auth flow** — Phase 2.
- **Real schema and rules** — Phase 3.
- **Real pages beyond the smoketest** — Phases 5–7.
- **Real importer / expiry / email triggers** — Phases 8 / 9.
- **PWA + push notifications** — Phase 10.
- **TanStack Query, shadcn-ui, Tailwind, vite-plugin-pwa, react-hook-form, zod
  consumption** — Phase 4.

## Next

Things Phase 2 needs to know that aren't already in `firebase-migration.md`
Phase 2:

- The new agent definitions exist at `.claude/agents/` but **load only at
  session start** — operator should restart Claude Code before dispatching
  `web-engineer` / `backend-engineer` so they're picked up by the Agent tool.
  Phase 1's parallel agents had to use `general-purpose` because of this;
  Phase 2 onward should use the named agents.
- `firebase-tools` must be the **npm-installed** version (small Node shim),
  not the standalone pkg-bundled binary at `/usr/local/bin/firebase` (282 MB;
  old embedded Node; can't `require()` ESM packages). If the standalone
  reappears, `firebase emulators:exec` breaks ESM scripts again.
- `pnpm install` must run **without sudo** (use `~/.npm-global` prefix or
  `pnpm setup`) — sudo'd installs corrupt `~/.npm` cache and recreate the
  original problem.
