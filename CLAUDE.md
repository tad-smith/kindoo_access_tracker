# Stake Building Access — Claude Code guidance

A door-access tracker that manages Kindoo seat assignments across the units — wards and branches — of an LDS stake. (Previously named "Kindoo Access Tracker"; renamed to match the `stakebuildingaccess.org` domain locked in 2026-04-27 per F17 — apex flip completed 2026-05-13.) **Running on Firebase in production as of 2026-05-03 (Phase 11 cutover).** Apps Script was decommissioned at Phase 11 cutover; source removed from the repo in 2026-05-11. See [`docs/changelog/phase-11-cutover.md`](docs/changelog/phase-11-cutover.md) for history.

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

**Per-workspace `CLAUDE.md` files** describe local conventions for each. Read the one for the workspace you're working in. Cross-workspace coordination via `docs/TASKS.md`.

**End-user help guides** are hand-authored HTML in `docs/user-guide/`, synced into `apps/web/public/help/` by `apps/web/scripts/sync-help.mjs` and served at `/help/*.html`. See `apps/web/CLAUDE.md` and `docs/CLAUDE.md`.

## Start each session by reading

**Read in full — these are small, and they are the live state:**

1. `docs/TASKS.md` — work in flight. Closed entries live in `docs/TASKS-archive.md`; go there only when researching how something was decided.
2. `docs/BUGS.md` — open defects. Closed ones in `docs/BUGS-archive.md`, same rule.
3. `docs/open-questions.md` — active ambiguities and the `[RESOLVED]` trail.
4. The latest `docs/changelog/*.md` — what shipped most recently.
5. The `CLAUDE.md` for the workspace you're working in.

**Index-first for the big three.** `spec.md`, `architecture.md` and `firebase-schema.md` are reference works, not briefing documents — together they exceed a context window. Take the map, then read only the sections in scope:

```bash
grep -nE '^#{1,3} ' docs/spec.md              # the section map
grep -nE '^#{1,3} ' docs/architecture.md      # the section map
grep -nE '^#{1,3} ' docs/firebase-schema.md   # the section map
sed -n 'START,ENDp' docs/spec.md              # then read only the slice
grep -n '^| D38 |' docs/architecture.md       # decisions are table rows, not headings
```

This governs *how* you read them, not whether they bind. `docs/spec.md` is still the authority on runtime behaviour and `architecture.md` still governs design decisions (D1, D2, …; cite when overriding). If a change might touch a section you have not read, read it then — the index exists so that choice is deliberate rather than blind.

`docs/firebase-migration.md` is history (Phase A and Phase 12 complete). Consult it when researching a past phase decision; it is not session-start reading.

## Non-negotiable conventions

- **Spec and code change in the same commit.** Never leave `docs/spec.md` describing yesterday's design.
- **Shipped work closes with a changelog entry** in `docs/changelog/` — `phase-N-<slug>.md` for a phase, `<feature-slug>.md` otherwise.
- **Canonicalise every email** via `packages/shared/src/canonicalEmail.ts`: lowercase, then for `@gmail.com` / `@googlemail.com` only strip local-part dots and `+suffix`, and collapse `googlemail.com` → `gmail.com`. Applied at every input boundary.
- **TypeScript strict everywhere.**
- **Tests are non-negotiable.** Every workspace has a test suite that gates merges.
- **Custom claims are the role-resolution source.** `usePrincipal()` (web) and `request.auth.token.stakes[stakeId]` (rules) are the only paths.
- **Audit rows are server-written.** The parameterized `auditTrigger` Cloud Function fans audit rows for every entity write. Don't write audit rows from client or from non-audit Cloud Functions. **Exception:** `createStake` writes the cross-stake `platformAuditLog` row directly (per F19). The `auditTrigger` only fans per-stake `auditLog`, not platform-level audit.
- **`{stakeId}` parameterized from day one** (per F15). The hardcoded `'csnorth'` constant was removed in Phase 12.4 (PR #157) in favour of the active-stake selector — every per-stake read consumes the active stake.
- **No secrets in code.** Secret Manager + env-var injection.

## Work discipline

- **Ask before writing implementation code.** The user decides when work starts; don't begin a task without their go-ahead. Planning-doc edits in response to a design question are fine.
- **Don't spill scope.** If a need isn't part of the task you were given and isn't listed under its "Out of scope", stop and ask.
- **Keep it simple.** Target scale is 12 wards, ~250 seats, 1–2 requests/week. Don't pre-build pagination, polling, batching, or feature flags. See `architecture.md` §1 "Scale targets".

### Subagent dispatch: pick the model from the brief, not the agent

The model is a deliberate call — Opus where the work is judgement, Sonnet where it's transcription — because parallel agents and PR review runs draw on one subscription pool and have hit the session limit. The pins below run both directions.

- **`docs-keeper` is pinned to `model: opus`** in its frontmatter — docs work here is judgement, not transcription. **`infra-engineer` is pinned to `model: sonnet`.**
- **`backend-engineer`, `web-engineer`, and `extension-engineer` are decided per dispatch.** Judge the brief that was actually written: one that names the file, the line, and the replacement is a targeted change and gets `model: "sonnet"`; one that states a goal and leaves the design open gets Opus, which is what an omitted override already means. Make the call **before** launching — the same agent transcribes on one dispatch and designs on the next, so the model rides on the brief, not on the agent's name.
- **`effort: high` on every agent, never `xhigh`.** The frontmatter key is `effort`; accepted values are `low | medium | high | xhigh | max`.

## Commit & push

- Commit only when the user asks.
- Push only when the user asks.
- Never `--no-verify`, `--force`, or skip hooks. If a hook fails, fix the cause.

### PR reviews are batched, not per-push

`.github/workflows/claude-code-review.yml` fires on every push to an open non-draft PR, and it runs on **the operator's Claude subscription** (`claude_code_oauth_token`), not on API billing. So a review is not free: it draws from the same token pool as the session doing the work, and a full run re-reads `spec.md`, every `CLAUDE.md`, and the whole diff from cold. T-104 (PR #289) burned five of them on one PR because each review finding was fixed and pushed the moment it arrived.

- **Open a PR as a draft.** Pushes still fire the workflow, but the job's `draft == false` gate skips it at no cost. `gh pr ready` when the work is ready to be looked at — that is one review, deliberately requested.
- **Batch review fixes into one push.** Address everything a review round raised, verify locally, then push once. Re-request with `gh pr ready --undo && gh pr ready`.
- **Don't disable the reviewer to save tokens.** It has caught real defects in shipped code that local suites and human reading both missed (T-104's hourly slot drift, and a malformed-row throw that stranded a whole stake's schedule). Fewer, later reviews — not fewer eyes.

The in-flight-visibility convention still holds: open the PR after the first commit. Draft is what makes that cheap.

## Dev loops

- `pnpm dev` — Firebase emulators, state persisted in `.firebase/emulator-data`. Run the SPA alongside with `pnpm --filter @kindoo/web dev`.
- `pnpm test` — full test suite (unit + integration + rules + E2E).
- `pnpm deploy:staging` / `pnpm deploy:prod` — operator-triggered deploys.

**Operator runs `firebase deploy` themselves** unless explicitly delegated.

## Current status

**Live in production at `kindoo-prod`** as of 2026-05-03. Both `stakebuildingaccess.org` (F17 brand apex, live 2026-05-13) and the legacy `kindoo.csnorth.org` resolve to Firebase Hosting; dual-hosting is the final state (no redirect, no takedown). Bootstrap admin `admin@csnorth.org`; data live in Firestore (originally seeded from the LCR Sheet via the `runImportNow` callable). 1–2 requests/week. See [`docs/changelog/phase-11-cutover.md`](docs/changelog/phase-11-cutover.md).

**Open follow-ups:**

- B-1 — iPhone PWA notification deep-link.
- T-26 — finish Phase 11 SA hardening (pin remaining functions to `kindoo-app@`, audit IAM, revoke project-default `roles/editor`). The D33 `serviceAccountTokenCreator` self-grant is part of this surface — do not revoke it while tidying IAM.
- Phase 10.6 (push expansion) — operator-deferred.

### Shipped features: invariants not to undo

The rationale for each line is the cited row in `docs/architecture.md`; the history is in the matching `docs/changelog/` entry.

- **Branches (D31, D32).** A unit whose name ends in `" Branch"` is a branch, decided only in `packages/shared/src/unitName.ts`. Otherwise a branch *is* a ward, so "ward" in prose and identifiers covers both kinds and is not drift to sweep to "unit". Absent `unitType` reads as ward, and the kind never comes from `scope` — a `ward_code` is a slug.
- **Remote apply (D27, `spec.md` §16).** A manager's phone queues work in `remoteApply/{canonicalEmail}`; their own desktop extension provisions it. The web half is inert until a presence doc exists.
- **Extension email sign-in (D33, `spec.md` §4.1).** Two gates guard `mintExtensionToken`, both load-bearing: `isAllowedRedirectUri` (an allowlist — every extension's callback origin has the same shape) and an explicit click on the confirm card. Deploy prerequisites outside the repo: `kindoo-app@` holds `roles/iam.serviceAccountTokenCreator` on itself; each extension build's `VITE_WEB_BASE_URL` matches its `VITE_FIREBASE_*`; every non-production SPA build sets `VITE_EXTENSION_IDS`.
- **Expired temp seats (D34).** The rule lives only in `packages/shared/src/tempExpiry.ts`. Edit is withheld from everyone (an `edit_temp` would re-add the expired grant); Kindoo Managers keep Remove, which also survives on a seat with other grants (`syncWillClearSeat`). Re-granting is an `add_temp`, possible only after Sync clears the row.
- **Audit fan-in (D35).** Protected by `retry: true` on all nine `auditTrigger` registrations plus the deterministic `auditDocId`, not by a sweep. Only gRPC `INVALID_ARGUMENT` is dropped (logged as `audit-row-dropped`, unalerted, unrecoverable); every other code rethrows. `auditTrigger.registration.test.ts` is what catches an uninstrumented collection.
- **Audit retention (D36).** `AUDIT_TTL_MS` in `packages/shared/src/types/audit.ts` is the only window, so retention is a code change, never a `gcloud` change; it moves `apps/web/src/routes/privacy.tsx` and its `LAST_UPDATED` in the same commit. `platformAuditLog` never gets a `ttl` field or a TTL policy.
- **Scheduled tasks (D38, `spec.md` §17).** One hourly `dispatchScheduledTasks` and one `runScheduledTask`; a new scheduled feature is a `SCHEDULED_JOBS` entry, never a new job, because the Cloud Scheduler free tier is spent. Enqueue happens before the stamp, so every handler is idempotent within its window; `nextTriggerTime` advances from the stored value; seeding only adds; `defaultEnabled` is `false` for everything. `DISPATCH_DONE_MESSAGE` is pinned by a test because an infra alert matches it. IAM `firebase deploy` does not grant: `roles/cloudtasks.enqueuer` on the queue, and `roles/iam.serviceAccountUser` for `kindoo-app@` on itself.
- **Sync reminder (D37, D39, D40, `spec.md` §9).** Lists only seats `syncWillClearSeat` says Sync clears; push is a separate `notificationPrefs.push.syncReminder` opt-in. `runScheduledTask` binds `RESEND_API_KEY`. The dispatcher's stamp is a transaction that re-applies only its own changes, so a manager's concurrent toggle survives. `notifications_enabled` is email-only — a greyed row still stamps and pushes. An absent `syncHeartbeats` doc is silent; staleness is seven days, backoff three.
- **Quarterly manual-seat review (D41, D42).** No `quarterly` schedule shape: a monthly check plus `MANUAL_SEAT_REVIEW_INTERVAL_DAYS = 75`. Jitter is deterministic (`jitterDelaySeconds`), and a job's special case lives on its registry entry (`skipJitter`), never in the dispatcher. No recipient fallback. The stamp is written once at least one scope sends (or the kill-switch suppresses it) and is never deleted. Dry run (`stake.manual_seat_review_dry_run`): recipient resolution stays ahead of the kill-switch, nothing may clear the flag, and on prod it is three passes — kill-switched, then mailed to Kindoo Managers only, then real — never collapsed. Procedure: `docs/changelog/manual-seat-review-dry-run.md`.
