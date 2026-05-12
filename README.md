# Stake Building Access

A web app used by a stake of The Church of Jesus Christ of Latter-day Saints to manage Kindoo door-access seat assignments across its wards. Running on Firebase in production as of 2026-05-03 (Phase 11 cutover); served from `kindoo.csnorth.org`. Project name `stakebuildingaccess.org` is locked for the eventual apex flip (Phase B).

## What it does

- Tracks three kinds of seats per ward and per stake pool: **automatic** (from LCR callings), **manual**, **temporary** (with end dates).
- Lets bishoprics request manual/temp adds and removals for their own ward.
- Lets the stake presidency do the same against the stake pool.
- Gives Kindoo Managers a queue to work through, mirror into Kindoo by hand, and mark complete.
- Hourly importer reconciles automatic seats from the LCR stake callings spreadsheet.
- Hourly expiry job removes temp seats whose end date has passed.
- Resend transactional emails at the relevant lifecycle points; FCM Web push on supported clients.

Specification: [`docs/spec.md`](docs/spec.md) — live source of truth, always describes the current system. Architecture: [`docs/architecture.md`](docs/architecture.md). Migration plan: [`docs/firebase-migration.md`](docs/firebase-migration.md). Data + rules reference: [`docs/firebase-schema.md`](docs/firebase-schema.md). Per-phase history: [`docs/changelog/`](docs/changelog/).

## Project layout

```
.
├── apps/web/                  # React 19 SPA — Vite + TanStack Router + reactfire
├── functions/                 # Cloud Functions 2nd gen — triggers, schedulers, callables
├── firestore/                 # Security rules + composite indexes (+ rules tests)
├── packages/shared/           # Shared TypeScript types and zod schemas
├── e2e/                       # Playwright end-to-end tests
├── infra/                     # Deploy scripts, runbooks, CI workflows, monitoring config
├── docs/                      # Spec, architecture, changelog, BUGS, TASKS, open questions
├── firebase.json              # Firebase project config (hosting, functions, firestore, emulators)
├── .firebaserc                # Default Firebase project aliases
├── pnpm-workspace.yaml        # pnpm workspace members
├── tsconfig.base.json         # Shared TypeScript compiler options
├── tsconfig.json              # Workspace project references
├── package.json               # Root scripts + dev tooling
└── README.md
```

## Local dev workflow

### First-time setup

1. Use Node 22 (`nvm use` reads `.nvmrc`).
2. Install dependencies:
   ```
   pnpm install
   ```
   The `prepare` hook seeds `apps/web/src/version.gen.ts` and `functions/src/version.gen.ts` with `0.0.0-dev` placeholders so `pnpm dev` and `pnpm test` work without running the deploy stamper.
3. Install the Firebase CLI globally (`npm install -g firebase-tools`) and log in (`firebase login`).

### Day-to-day

- `pnpm dev` — start Firebase emulators (Auth, Firestore, Functions, Hosting) with state imported from `.firebase/emulator-data/` and re-exported on exit.
- `pnpm test` — run the full test suite across every workspace (unit + integration + rules + E2E). Individual surfaces: `pnpm test:unit`, `pnpm test:rules`, `pnpm test:e2e`.
- `pnpm typecheck` — `tsc -b` across the workspace.
- `pnpm lint` — per-workspace lint plus root `prettier --check`.
- `pnpm build` — fan-out build across every workspace.

### Deploy

Two Firebase projects: `kindoo-staging` (rehearsal) and `kindoo-prod` (live). Same code, different `--project` flag.

- `pnpm deploy:staging` — runs `infra/scripts/deploy-staging.sh`.
- `pnpm deploy:prod` — runs `infra/scripts/deploy-prod.sh`.

Both scripts stamp the build version into `apps/web/src/version.gen.ts` and `functions/src/version.gen.ts` (git short SHA + UTC ISO timestamp) before invoking `firebase deploy`. The Cloud Functions deploy uses an esbuild-bundled artifact under `functions/lib/` so the workspace-protocol `@kindoo/shared` import resolves cleanly under Cloud Build's `npm install`. See [`infra/CLAUDE.md`](infra/CLAUDE.md) and architecture decision D12 for the rationale.

### Custom domain

Production resolves at `https://kindoo.csnorth.org` (Firebase Hosting with auto-provisioned Let's Encrypt cert). Domain registration for `stakebuildingaccess.org` is held for the Phase B apex flip; until that lands, both names point at the same Firebase Hosting site.

## Conventions

- **`docs/spec.md` is the live source of truth.** Code and spec change together, in the same commit. Per-phase changelogs in [`docs/changelog/`](docs/changelog/) record the "why" behind each change.
- **Custom claims are the role-resolution source.** `usePrincipal()` (web) and `request.auth.token.stakes[stakeId]` (rules) are the only paths. Don't query `kindooManagers` or `access` directly to check roles.
- **Audit rows are server-written** by the parameterized `auditTrigger` Cloud Function. Clients write entity docs; the trigger fans audit rows from those writes.
- **Canonicalise every email** via `packages/shared/canonicalEmail.ts` at every input boundary: lowercase, strip `+suffix`, and for `@gmail.com` / `@googlemail.com` only strip local-part dots (collapse `googlemail.com` → `gmail.com`).
- **No secrets in source.** Secret Manager + env-var injection. The repo is public.
- **TypeScript strict everywhere.** Every workspace has a test suite that gates merges.

## Historical note

The app originally ran on Google Apps Script (December 2026 – May 2026), backed by a Google Sheet with an HMAC-signed two-project auth model and a GitHub Pages iframe wrapper for the custom domain. Apps Script was decommissioned at the Phase 11 cutover on 2026-05-03; the source was removed from the repo in 2026-05-11. The Apps Script-era design decisions D1–D10 in [`docs/architecture.md`](docs/architecture.md) and the corresponding `[RESOLVED]` trail in [`docs/open-questions.md`](docs/open-questions.md) are retained as historical record. See [`docs/changelog/phase-11-cutover.md`](docs/changelog/phase-11-cutover.md) for the cutover narrative.
