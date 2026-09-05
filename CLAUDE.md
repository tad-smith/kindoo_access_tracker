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

**Per-workspace `CLAUDE.md` files** describe local conventions for each. Read the one for the workspace you're working in. Cross-workspace coordination via root `TASKS.md`.

**End-user help guides** are hand-authored HTML in `docs/user-guide/`, synced into `apps/web/public/help/` by `apps/web/scripts/sync-help.mjs` and served at `/help/*.html`. See `apps/web/CLAUDE.md` and `docs/CLAUDE.md`.

## Start each session by reading

1. `docs/spec.md` — live source of truth for runtime behaviour.
2. `docs/firebase-schema.md` — data model + rules + indexes.
3. The latest `docs/changelog/phase-N-*.md` — what shipped most recently.
4. `docs/firebase-migration.md` — phase plan (Phase A complete; Phase 12 complete).
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
- **Audit rows are server-written.** The parameterized `auditTrigger` Cloud Function fans audit rows for every entity write. Don't write audit rows from client or from non-audit Cloud Functions. **Exception:** `createStake` writes the cross-stake `platformAuditLog` row directly (per F19). The `auditTrigger` only fans per-stake `auditLog`, not platform-level audit.
- **`{stakeId}` parameterized from day one** (per F15). The hardcoded `'csnorth'` constant was removed in Phase 12.4 (PR #157) in favour of the active-stake selector — every per-stake read consumes the active stake.
- **No secrets in code.** Secret Manager + env-var injection.

## Work discipline

- **Ask before writing implementation code.** The user directs phase starts; don't begin Phase N work without their go-ahead. Planning-doc edits in response to a design question are fine.
- **Don't spill scope across phases.** If a need isn't in the current phase's sub-tasks and isn't listed under "Out of scope", stop and ask.
- **Keep it simple.** Target scale is 12 wards, ~250 seats, 1–2 requests/week. Don't pre-build pagination, polling, batching, or feature flags. See `architecture.md` §1 "Scale targets".

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

- `pnpm dev` — emulators + Vite + functions in parallel.
- `pnpm test` — full test suite (unit + integration + rules + E2E).
- `pnpm deploy:staging` / `pnpm deploy:prod` — operator-triggered deploys.

**Operator runs `firebase deploy` themselves** unless explicitly delegated.

## Current status

**Live in production at `kindoo-prod`** as of 2026-05-03. Both `stakebuildingaccess.org` (F17 brand apex, live 2026-05-13) and the legacy `kindoo.csnorth.org` resolve to Firebase Hosting; dual-hosting is the final state (no redirect, no takedown). Bootstrap admin `admin@csnorth.org`; data live in Firestore (originally seeded from the LCR Sheet via the `runImportNow` callable). 1–2 requests/week. See [`docs/changelog/phase-11-cutover.md`](docs/changelog/phase-11-cutover.md).

**Open follow-ups:**

- Phase 12 (multi-stake) — **complete** as of 2026-05-20; all five sub-deliverables (12.1 → 12.5) shipped. See `docs/firebase-migration.md` Phase 12, T-46, and the per-PR changelogs under `docs/changelog/phase-12.N-*.md`.
- **Remote apply** (PR #250, `architecture.md` D27, `spec.md` §16) — shipped. A manager taps **Apply via extension** on their phone's Requests Queue and their own desktop extension provisions it, via the `remoteApply/{canonicalEmail}` mailbox. The web half is live and inert until a presence doc exists; the extension half is gated on Chrome Web Store review. See `docs/changelog/remote-apply.md`.
- **Branches** (PR #268, `architecture.md` D31) — shipped. A unit whose name ends in `" Branch"` is a branch; `packages/shared/src/unitName.ts` is the only place that decides. **Otherwise a branch *is* a ward** — same collection, fields, rules, and surfaces — so "ward" in prose and in identifiers covers both kinds and is not drift to be swept to "unit", and an undeterminable kind assumes ward (D31(f)). See `docs/changelog/branch-units.md`.
- **Branch callings** (PR #270, `architecture.md` D32, T-96) — shipped. A third app-access set (`BRANCH_APP_ACCESS_CALLINGS`), seven branch entries interleaved into the sort table, and `AppAccessOptions.unitType` selecting between the three. Absent `unitType` reads as ward, and the kind can never come from `scope` — a `ward_code` is a slug. See `docs/changelog/branch-callings.md`. Follow-ups T-99 and T-100 are both **done** (PR #272): the web typeahead now projects the two exported bands instead of duplicating the table, and the typeahead is covered in a real browser. That spec immediately found **B-22** — every Popover inside a modal was rendering behind it, so no calling suggestion and no Create Stake timezone could be clicked. Fixed in the same PR.
- **Extension sign-in for managers without a Google account** (PR #282, `architecture.md` D33, `spec.md` §4.1) — shipped. The extension's signed-out panel has a second button, **Sign in with email**, that opens the SPA's `/auth/extension` route in `chrome.identity.launchWebAuthFlow`; the manager signs in there by whichever provider they have and the SPA hands back a Firebase **custom** token (via the `mintExtensionToken` callable) that the service worker exchanges. The two paths are alternatives, not a fallback chain. **Two gates guard the mint and both are load-bearing** — the `redirect_uri` must name an extension on the build's allowlist (`isAllowedRedirectUri`; shape alone is not a boundary, since every extension's callback origin has the same shape), and nothing is minted without an explicit click on the confirm card (a non-interactive flow renders no UI, so it can never produce one). Don't weaken either. Three deploy prerequisites, all set outside the repo: `kindoo-app@<project>` needs `roles/iam.serviceAccountTokenCreator` **on itself**; each extension build's `VITE_WEB_BASE_URL` must match its `VITE_FIREBASE_*` environment; and every **non-production** SPA build needs `VITE_EXTENSION_IDS`, because `CHROME_EXTENSION_ID` is a production-only default and each environment's unpacked extension carries its own keypair-derived ID. The first two fail only at runtime in a deployed environment; the third fails the build. See `docs/changelog/extension-web-signin.md`.
- **Expired temp seats** (`architecture.md` D34, `spec.md` §7) — shipped. A temp grant past its `end_date` renders muted with an `Expired` badge and **neither the Remove nor the Edit control**, replaced by a line saying the seat clears at the next Sync. Kindoo Managers keep Remove; **Edit is withheld from everyone** and, unlike Remove, is NOT narrowed to the single-grant shape: the temp grant's Kindoo AccessSchedule is gone the moment Kindoo expires it, so an `edit_temp` would re-add it — an add wearing an edit's clothes. (`provisionEdit`'s `ProvisionEditUserMissingError` throw is a *member* lookup, so it only fires on single-grant seats; don't cite it as the universal reason.) Re-granting is an `add_temp`. Two carve-outs that are load-bearing: **Remove survives on a seat with other grants**, since `sba-only` needs the member absent from Kindoo entirely and would never reap that one (`syncWillClearSeat`); and a leader can only re-request **after** Sync clears the row, because `NewRequestForm`'s duplicate gate counts the leftover seat. Marked rather than hidden because the seat is still in SBA and still in the manager's backlog — **not** because it might still be live in Kindoo; expiry means Kindoo already removed it. Display-only; the rule lives in `packages/shared/src/tempExpiry.ts` and nowhere else. It moved out of `apps/web/src/lib/` on 2026-09-04 when the sync reminder (below) became its second consumer — "nowhere else" is the whole point of the line, so a server-side copy was never an option. See `docs/changelog/expired-temp-seat-display.md`.
- **Audit fan-in is protected by trigger retries, not a reconciliation sweep** (PR #286, `architecture.md` D35, T-102) — shipped. `reconcileAuditGaps` and the whole `functions/src/scheduled/` directory were deleted. **The "zero scheduled Cloud Functions" headline this bullet used to carry is no longer true** — T-104's dispatcher restored exactly one (see the next bullet); everything else here stands, and no reconciliation job is coming back. **Supersedes D19's and D20's "exactly one scheduled job" framing and amends F8's "nightly reconciliation catches any gaps" clause** — the compensating control is now `{ document, retry: true }` on all nine `auditTrigger` registrations, giving Eventarc a 24-hour redelivery window that the deterministic `auditDocId` makes idempotent. One carve-out, deliberately one error code wide: `isPermanentAuditWriteError` classifies gRPC `INVALID_ARGUMENT` and `emitAuditRow` logs the row's coordinates and drops it — two reachable causes, the 1 MiB document limit and the 1500-byte index-entry limit tripped by a long value inside `before` / `after`. Every other code rethrows, `PERMISSION_DENIED` included. Retries are blind to an invocation that succeeds without writing, so `auditTrigger.registration.test.ts` derives the audited-collection set from `firestore/firestore.rules` and set-compares it against the deploy manifests; that test, not a sweep, is what catches an uninstrumented collection. **The constraint to keep in mind: `audit-row-dropped` is the only signal that a row was permanently lost, a lost row cannot be reconstructed, and no alert is routed to it** (`infra/runbooks/observability.md`, "Not yet wired"). See `docs/changelog/remove-audit-gap-reconciliation.md`.
- **Audit retention** (PR #287, `architecture.md` D36, T-101) — shipped. The window is `AUDIT_TTL_MS` in `packages/shared/src/types/audit.ts` and nowhere else; it replaced three duplicated `TTL_MS` literals, and `auditTrigger`, `EmailService`'s `email_send_failed` writer, and the backfill all read it from there. The Firestore TTL policy carries no duration, so **retention is a code change, never a `gcloud` change**. Two things move with the constant. First, `apps/web/src/routes/privacy.tsx` states the window to members in plain language — that sentence is a commitment to the people named in the rows, so it changes in the same commit and bumps `LAST_UPDATED`. Second, **`platformAuditLog` carries no `ttl` at all and must never get a TTL policy**; the field's absence is what makes the platform trail non-expiring by construction rather than by nobody having enabled one. **Operator step, because it does not happen by itself:** `ttl` is stamped at write time, so the constant reaches new rows only — the **Backfill audit log retention** fix must be run once per stake from the superadmin Stake List → Apply Fixes menu. It is idempotent, and it only matters before roughly May 2027, after which the rows it would have saved are already gone. See `docs/changelog/extend-audit-retention.md`.
- **Sync reminder for expired temp seats** (PR #288, `architecture.md` D37, `spec.md` §9, T-103) — shipped, and **nothing calls it yet**. `sendSyncReminderIfDue(stakeId, now)` in `functions/src/services/SyncReminderService.ts` is a complete per-stake unit of work with no trigger and no export from `functions/src/index.ts`. The dispatcher that will call it now exists (next bullet) but its job registry is **empty**, so the reminder is registered as no job and still nothing sends it; registering it is a third PR. Don't add a `onSchedule` wrapper as a stopgap — the whole reason it merged inert is that Cloud Scheduler's free tier is three jobs and this stack spends two per job. Two decisions are load-bearing: the mail lists **only seats `syncWillClearSeat` says Sync will actually clear**, because its one instruction is "run Sync" (the excluded multi-grant shape is T-105); and push is a **separate** `notificationPrefs.push.syncReminder` opt-in, absent-reads-off for everyone including existing `newRequest` subscribers. Backoff is stamped as `stake.last_sync_reminder_date`, which is in `BOOKKEEPING_FIELDS` and so fans no audit row. See `docs/changelog/sync-reminder-expired-temp-seats.md`.
- **Per-stake scheduled tasks** (PR #289, `architecture.md` D38, `spec.md` §17, T-104) — shipped, and **it schedules nothing**. `functions/src/lib/taskRegistry.ts` exports an empty `SCHEDULED_JOBS`, so the hourly `dispatchScheduledTasks` walks the stakes, seeds nothing, enqueues nothing, and no user-visible behaviour changed; `sendSyncReminderIfDue` is still uncalled. Two functions (inventory 27 → 29), both pinning `kindoo-app@`: the `onSchedule` dispatcher on cron `0 * * * *` in `Etc/UTC`, and one generic `onTaskDispatched` runner, `runScheduledTask`. **Adding a scheduled feature is a registry entry, never a new job** — Cloud Scheduler's free tier is three jobs per billing account and this deploy spends all three (staging dispatcher, prod dispatcher, prod weekly export). State is the new top-level `stakeSchedules/{stakeId}` (`{tasks, lastActor}`, manager-writable, `tasks` capped at 50 by rules) — top-level and **unaudited by design**, because a per-stake home would make the hourly stamp fan an audit row and the only fix would also silence a manager toggling `enabled`. Four things not to undo: enqueue happens **before** the stamp, so delivery is at-least-once and **every handler must be idempotent within its window**; `nextTriggerTime` advances from the **stored** value, and every slot is anchored to a wall-clock boundary (`hourly` to the top of the hour) so no trigger inherits the second a dispatch happened to run at; seeding only ever adds, so a manager's `enabled: false` survives a deploy; and `defaultEnabled` is `false` for everything, so turning a job on is a deliberate Firestore console edit (there is no manager UI). `DISPATCH_DONE_MESSAGE` is pinned by a test because an infra metric matches the string and alerts on its absence. **Operator step:** two IAM bindings per project that `firebase deploy` does not grant — `roles/cloudtasks.enqueuer` on the `runScheduledTask` queue, and `roles/iam.serviceAccountUser` on `kindoo-app@` *on itself* (a second self-binding, distinct from D33's `serviceAccountTokenCreator`) — and the failure without them is a runtime `PERMISSION_DENIED`, not a deploy error. See `docs/changelog/scheduled-tasks.md` and `infra/runbooks/deploy.md`.
- B-1 — iPhone PWA notification deep-link.
- T-26 — finish Phase 11 SA hardening (pin remaining functions to `kindoo-app@`, audit IAM, revoke project-default `roles/editor`). **The D33 `serviceAccountTokenCreator` self-grant is now part of this surface** — do not revoke it while tidying IAM.
- Phase 10.6 (push expansion) — operator-deferred.
