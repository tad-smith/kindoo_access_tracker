# Stake Building Access — Claude Code guidance

A door-access tracker that manages Kindoo seat assignments across the wards of a single LDS stake. (Previously named "Kindoo Access Tracker"; renamed to match the `stakebuildingaccess.org` domain locked in 2026-04-27 per F17 — apex flip completed 2026-05-13.) **Running on Firebase in production as of 2026-05-03 (Phase 11 cutover).** Apps Script was decommissioned at Phase 11 cutover; source removed from the repo in 2026-05-11. See [`docs/changelog/phase-11-cutover.md`](docs/changelog/phase-11-cutover.md) for history.

`docs/spec.md` is the authoritative description of runtime behaviour.

## Workspaces

| Workspace | Lives in | Owner agent |
|---|---|---|
| **React + Firebase SPA** | `apps/web/` | `web-engineer` |
| **Cloud Functions** | `functions/` | `backend-engineer` |
| **Firestore rules + indexes** | `firestore/` | `backend-engineer` |
| **Shared types + utilities** | `packages/shared/` | co-owned |
| **Infra + scripts + runbooks** | `infra/` | `infra-engineer` |
| **End-to-end tests** | `e2e/` | `web-engineer` |
| **Documentation** | `docs/` | `docs-keeper` |

**Per-workspace `CLAUDE.md` files** describe local conventions for each. Read the one for the workspace you're working in. Cross-workspace coordination via root `TASKS.md`.

## Start each session by reading

1. `docs/spec.md` — live source of truth for runtime behaviour.
2. `docs/firebase-schema.md` — data model + rules + indexes.
3. The latest `docs/changelog/phase-N-*.md` — what shipped most recently.
4. `docs/firebase-migration.md` — phase plan (Phase A complete; Phase 12 active).
5. `docs/TASKS.md` — cross-workspace work-in-flight.
6. `docs/BUGS.md` — known defects.
7. `docs/open-questions.md` — active ambiguities and the `[RESOLVED]` trail.
8. `docs/architecture.md` — numbered design decisions (D1, D2, …); cite when overriding.
9. The `CLAUDE.md` for the workspace you're working in.

## Non-negotiable conventions

- **Spec and code change in the same commit.** Never leave `docs/spec.md` describing yesterday's design.
- **Every phase closes with a changelog entry** at `docs/changelog/phase-N-<slug>.md`.
- **Canonicalise every email** via `packages/shared/canonicalEmail.ts`: lowercase, then for `@gmail.com` / `@googlemail.com` only strip local-part dots and `+suffix`, and collapse `googlemail.com` → `gmail.com`. Applied at every input boundary.
- **TypeScript strict everywhere.**
- **Tests are non-negotiable.** Every workspace has a test suite that gates merges.
- **Custom claims are the role-resolution source.** `usePrincipal()` (web) and `request.auth.token.stakes[stakeId]` (rules) are the only paths.
- **Audit rows are server-written.** The parameterized `auditTrigger` Cloud Function fans audit rows for every entity write. Don't write audit rows from client or from non-audit Cloud Functions.
- **`{stakeId}` parameterized from day one** (per F15). The hardcoded `'csnorth'` constant in `apps/web/src/lib/constants.ts` is going away in Phase 12's 12.4 PR in favour of the active-stake selector — every new per-stake read consumes the active stake, not the constant.
- **No secrets in code.** Secret Manager + env-var injection.

## Work discipline

- **Ask before writing implementation code.** The user directs phase starts; don't begin Phase N work without their go-ahead. Planning-doc edits in response to a design question are fine.
- **Don't spill scope across phases.** If a need isn't in the current phase's sub-tasks and isn't listed under "Out of scope", stop and ask.
- **Keep it simple.** Target scale is 12 wards, ~250 seats, 1–2 requests/week. Don't pre-build pagination, polling, batching, or feature flags. See `architecture.md` §1 "Scale targets".

## Commit & push

- Commit only when the user asks.
- Push only when the user asks.
- Never `--no-verify`, `--force`, or skip hooks. If a hook fails, fix the cause.
- Trailer on every commit: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

## Dev loops

- `pnpm dev` — emulators + Vite + functions in parallel.
- `pnpm test` — full test suite (unit + integration + rules + E2E).
- `pnpm deploy:staging` / `pnpm deploy:prod` — operator-triggered deploys.

**Operator runs `firebase deploy` themselves** unless explicitly delegated.

## Current status

**Live in production at `kindoo-prod`** as of 2026-05-03. Both `stakebuildingaccess.org` (F17 brand apex, live 2026-05-13) and the legacy `kindoo.csnorth.org` resolve to Firebase Hosting; dual-hosting is the final state (no redirect, no takedown). Bootstrap admin `admin@csnorth.org`; data live in Firestore (originally seeded from the LCR Sheet via the `runImportNow` callable). 1–2 requests/week. See [`docs/changelog/phase-11-cutover.md`](docs/changelog/phase-11-cutover.md).

**Open follow-ups:**

- Phase 12 (multi-stake) — **active** as of 2026-05-18; ships as five sub-deliverables (12.1 → 12.5). See `docs/firebase-migration.md` Phase 12 and T-46.
- B-1 — iPhone PWA notification deep-link.
- T-26 — finish Phase 11 SA hardening (pin remaining functions to `kindoo-app@`, audit IAM, revoke project-default `roles/editor`).
- Phase 10.6 (push expansion) — operator-deferred.
