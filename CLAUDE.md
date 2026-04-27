# Kindoo Access Tracker — Claude Code guidance

A door-access tracker that manages Kindoo seat assignments across the wards of a single LDS stake. Currently running on Google Apps Script in production; **migrating to Firebase as of 2026-04-27** (target: as quickly as possible).

`docs/spec.md` is the authoritative description of runtime behaviour.

## Two worlds during migration

Until Phase 11 cutover, this repo holds **both** the live Apps Script app AND the Firebase migration in flight:

| World | Lives in | Owner agent | Status |
|---|---|---|---|
| **Apps Script Main** | `src/` | (legacy; bug fixes only) | Live in production until cutover |
| **Apps Script Identity** | `identity-project/` | (legacy) | Live until cutover |
| **GitHub Pages wrapper** | `website/` | (legacy) | Live until DNS flip in Phase 11 |
| **React + Firebase SPA** | `apps/web/` | `web-engineer` | Building in Phases 4–10 |
| **Cloud Functions** | `functions/` | `backend-engineer` | Building in Phases 2, 8, 9, 10 |
| **Firestore rules + indexes** | `firestore/` | `backend-engineer` | Building in Phase 3 |
| **Shared types + utilities** | `packages/shared/` | co-owned | Building in Phase 3 onward |
| **Infra + scripts + runbooks** | `infra/` | `infra-engineer` | Building from Phase 1 |
| **End-to-end tests** | `e2e/` | `web-engineer` | Building from Phase 4 |
| **Documentation** | `docs/` | `docs-keeper` | Continuous |

**Per-workspace `CLAUDE.md` files** describe local conventions for each. Read the one for the workspace you're working in. Cross-workspace coordination via root `TASKS.md`.

## Start each session by reading

1. `docs/firebase-migration.md` — **ACTIVE migration plan**; what phase is current.
2. `docs/firebase-schema.md` — data model + rules for the migration target.
3. `docs/spec.md` — live source of truth for runtime behaviour (Apps Script reality until Phase 11).
4. The latest `docs/changelog/phase-N-*.md` (or `chunk-N-*.md` for legacy) — what shipped most recently.
5. `docs/TASKS.md` — cross-workspace work-in-flight.
6. `docs/BUGS.md` — known defects.
7. `docs/open-questions.md` — active ambiguities and the `[RESOLVED]` trail.
8. `docs/architecture.md` — numbered design decisions (D1, D2, …); cite when overriding.
9. The `CLAUDE.md` for the workspace you're working in.

## Non-negotiable conventions (apply everywhere)

- **Spec and code change in the same commit.** Never leave `docs/spec.md` describing yesterday's design.
- **Every phase closes with a changelog entry.** Migration phases: `docs/changelog/phase-N-<slug>.md`.
- **Canonicalise every email** via `packages/shared/canonicalEmail.ts` (or, in Apps Script, `Utils.normaliseEmail`): lowercase, then for `@gmail.com` / `@googlemail.com` only strip local-part dots and `+suffix`, and collapse `googlemail.com` → `gmail.com`. Applied at every input boundary.
- **No secrets in source.** Apps Script `Config` tab; Firebase Secret Manager. The repo is public.

## Apps Script-only conventions (`src/`, `identity-project/` only)

These apply when working in the legacy code path and **not** in the new monorepo:

- **Auth is two-project Session+HMAC** (see `architecture.md` D10). Never call `Session.getActiveUser()` for identity outside `Identity_serve`.
- **Two identities** — Apps Script runs as the deployer (infrastructure); `AuditLog.actor_email` carries the authenticated user, derived from the verified HMAC token. `AuditRepo.write` requires `actor_email` explicitly; never fall back to `Session.*`.
- **Every write wraps `Lock.withLock`** and emits exactly one `AuditRepo.write` inside the same lock acquisition. Automated actors: literal strings `"Importer"` / `"ExpiryTrigger"`.
- **Flat namespace.** `src/` subdirectories become folder prefixes in the Apps Script editor but share one global scope. Prefix exported function names: `Seats_getByScope`, not `getByScope`.

## Firebase-monorepo conventions (`apps/`, `functions/`, `firestore/`, `packages/`, `infra/`, `e2e/`)

See per-workspace `CLAUDE.md`. The cross-cutting rules:

- **TypeScript strict everywhere.**
- **Tests are non-negotiable.** Every workspace has a test suite that gates merges.
- **Custom claims are the role-resolution source.** `usePrincipal()` (web) and `request.auth.token.stakes[stakeId]` (rules) are the only paths.
- **Audit rows are server-written.** The parameterized `auditTrigger` Cloud Function fans audit rows for every entity write. Don't write audit rows from client or from non-audit Cloud Functions.
- **`{stakeId}` parameterized from day one** (per F15) even in single-stake v1. Constant lives in `apps/web/src/lib/constants.ts`; one place to change for Phase B.
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

**Apps Script (legacy):**
- `npm run push` — sync local → Apps Script.
- `npm run push:watch` — sync on save.
- `npm run deploy` — new deployment version.
- `npm run logs` — tail execution logs.

**Firebase (new):**
- `pnpm dev` — emulators + Vite + functions in parallel.
- `pnpm test` — full test suite (unit + integration + rules + E2E).
- `pnpm deploy:staging` / `pnpm deploy:prod` — operator-triggered deploys.

**Operator runs `clasp` and `firebase deploy` themselves** unless explicitly delegated.

## Current status

**Apps Script:** all 11 chunks shipped; deployed to `kindoo.csnorth.org` via GitHub Pages iframe wrapper; 1–2 requests/week; running in production.

**Firebase migration:** committed 2026-04-27. Working through pre-Phase-1 gating. Next: agent definitions in `.claude/agents/`, then Phase 1 (project skeleton + emulators + CI). Target: 5–7 weeks full-time / 2–3 months part-time.
