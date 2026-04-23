# Kindoo Access Tracker — Claude Code guidance

A Google Apps Script web app that manages Kindoo door-access seat assignments across the wards of a single LDS stake. `docs/spec.md` is the authoritative description.

## Start each session by reading

1. `docs/spec.md` — live source of truth for what the system does **now**.
2. The **latest** `docs/changelog/chunk-N-*.md` — what the most recent chunk shipped and why the spec moved.
3. `docs/build-plan.md` — what chunk comes next. Each has an "Explicitly deferred to later chunks" fence; respect it.
4. `docs/TASKS.md` — deferred follow-up tasks the user has flagged between chunks. Small stuff, but persistent across sessions.
5. `docs/open-questions.md` — active ambiguities and the `[RESOLVED]` trail.
6. `docs/architecture.md` — numbered design decisions (D1, D2, …). Cite them in commit messages when overriding one.

## Non-negotiable conventions

- **Spec and code change in the same commit.** Never leave `docs/spec.md` describing yesterday's design.
- **Every chunk closes with a changelog entry.** Copy `docs/changelog/template.md` → `docs/changelog/chunk-N-<slug>.md`; commit alongside the chunk's final code change.
- **Auth is GSI + server-side JWT verification.** Never call `Session.getActiveUser()` for identity — it returns empty for consumer Gmail users (which is everyone here). Every `api/` endpoint takes `jwt` as its first argument. See `architecture.md` §§4–5 and D10.
- **Two identities.** Apps Script runs as the deployer — that's infrastructure and will appear in Sheet revision history for every write. `AuditLog.actor_email` carries the authenticated user, derived from the verified JWT. `AuditRepo.write` requires `actor_email` explicitly; never fall back to `Session.*`. See `architecture.md` §5.
- **Canonicalise every email** via `Utils.normaliseEmail`: lowercase, then for `@gmail.com` / `@googlemail.com` only strip local-part dots and `+suffix`, and collapse `googlemail.com` → `gmail.com`. Applied at UI input, JWT claim, and importer read boundaries. See `architecture.md` D4 and `open-questions.md` I-8.
- **Every write wraps `Lock.withLock`** and emits exactly one `AuditRepo.write` inside the same lock acquisition. Automated actors are the literal strings `"Importer"` and `"ExpiryTrigger"`.
- **Flat namespace.** `src/` subdirectories become folder prefixes in the Apps Script editor but share one global scope at runtime. Prefix exported function names: `Seats_getByScope`, not `getByScope`.
- **No secrets in source.** OAuth client ID, callings-sheet ID, admin emails all live in the `Config` tab. The backing sheet is container-bound so its ID isn't needed in source. The repo is public.

## Work discipline

- **Ask before writing implementation code.** The user directs chunk starts; don't begin coding a chunk without their go-ahead. Planning-doc edits in response to a design question are fine.
- **Don't spill scope across chunks.** If a need isn't in the current chunk's sub-tasks and isn't listed under "Deferred", stop and ask.
- **Keep it simple.** Target scale is 12 wards, ~250 seats, 1–2 requests/week. Don't pre-build pagination, polling, batching, or feature flags. See `architecture.md` §1 "Scale targets".

## Commit & push

- Commit only when the user asks.
- Push only when the user asks.
- Never `--no-verify`, `--force`, or skip hooks. If a hook fails, fix the cause.
- Trailer on every commit: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

## Dev loop

- `npm run push` — sync local → Apps Script.
- `npm run push:watch` — sync on save.
- `npm run deploy` — new deployment version.
- `npm run logs` — tail execution logs.
- **The user runs `clasp login / create / push / deploy` themselves** unless they explicitly delegate.

## Current status

No implementation yet. `src/` holds placeholder stubs (one-line comments describing what each file will contain) in the planned layout. Chunk 1 in `docs/build-plan.md` replaces them with working code and must demonstrate six specific auth/role proofs. `docs/changelog/chunk-0-planning.md` is the pre-implementation trail that explains how the spec diverged from the original brief.
