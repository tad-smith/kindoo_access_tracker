# Phase 9 — Email triggers via Resend

**Shipped:** 2026-04-29
**Commits:** see PR [#44](https://github.com/tad-smith/kindoo_access_tracker/pull/44) (3 commits on `phase-9-resend-email`).

## What shipped

All five notification types from `docs/spec.md` §9 send real email through Resend, fired by Firestore triggers on the relevant entity changes. Two triggers cover the surface: `notifyOnRequestWrite` watches every write to `stakes/{stakeId}/requests/{requestId}` and emits the matching lifecycle email (new request, completed, rejected, cancelled); `notifyOnOverCap` watches the parent stake doc and emits the over-cap warning when `last_over_caps_json` transitions empty → non-empty. The `notifications_enabled` flag on the stake is the operator kill-switch (email-only — push has its own per-user prefs from Phase 10.5). Resend errors land as one `email_send_failed` audit row written by `EmailService` rather than re-throwing, so a transient Resend outage never poisons a request lifecycle write.

The phase shipped over three commits:

- `4cc930a` — Phase 9 main work (Resend wrapper, EmailService, both triggers, `lib/managers.ts` shared helper, schema additions, importer touch, full test footprint).
- `1c24fde` — Operator runbook for Resend API key + `WEB_BASE_URL` env var setup.
- `4665201` — `.gitignore` entry for `functions/.env.*` files (per-project Cloud Functions env files; gitignored to keep the API-key path out of source).

### Sub-change A — Resend wrapper (`functions/src/lib/resend.ts`)

Typed `ResendSender` interface around the `resend` SDK; mirrors the `lib/messaging.ts` (FCM) shape — `defaultSender` calls the real SDK, `_setResendSender` test hook lets vitest swap in a fake without a network round-trip, `getResendSender()` returns the active sender. `EmailPayload` is the narrow subset we use (plain text only — no HTML, no attachments). `SendResult` mirrors Resend's own `data | error` shape so test fakes don't have to synthesise SDK internals. `RESEND_API_KEY` is read lazily from `process.env` on first send so a unit test that wires the fake before any send fires never trips the unset-env check.

### Sub-change B — EmailService (`functions/src/services/EmailService.ts`)

Five typed wrappers — `notifyManagersNewRequest`, `notifyRequesterCompleted`, `notifyRequesterRejected`, `notifyManagersCancelled`, `notifyManagersOverCap`. Each:

- Short-circuits if `stake.notifications_enabled === false`. One log line emitted; no Resend call.
- Builds `From:` as `<stake.stake_name> — Stake Building Access <noreply@mail.stakebuildingaccess.org>`. Stake name interpolated; envelope fixed to the verified mail subdomain (T-04).
- Sets `replyTo: stake.notifications_reply_to` if non-empty after trim; otherwise omits the header so replies bounce off `noreply@`.
- Builds plain-text body per spec §9. Type-aware lead verb (`add_manual` → "submitted a new manual-add request"; `remove` → "requested removal of"; `add_temp` → "requested temp access for"). R-1 completion body surfaces `Note: <completion_note>` when the field is set. Over-cap body lists every flagged pool with `count of cap (over by N)` and a deep link to `/manager/seats`.
- On Resend error or thrown exception, writes one `email_send_failed` audit row directly via Admin SDK with deterministic `auditId(writeTime, system_email_send_failed_<type>_<requestId|source|unknown>)`, logs `email send failed`, and returns. Never re-throws.

Body + subject builders are pure functions exported separately from the I/O wrappers so unit tests can hit them without any Firestore dependency.

`buildLink(route)` reads `process.env.WEB_BASE_URL` on every call. If unset, `safeBuildLink` catches the throw, logs `email skipped — link build failed`, writes one `email_send_failed` audit row tagged `type='config'`, and returns `undefined` so the caller skips the send rather than crashing. Visible-but-not-silent surfacing of deploy-time misconfiguration.

### Sub-change C — Triggers (`functions/src/triggers/{notifyOnRequestWrite,notifyOnOverCap}.ts`)

Both triggers `onDocumentWritten`, pinned to `APP_SA`, declare `secrets: [RESEND_API_KEY]` so Cloud Functions auto-mounts the secret as the `RESEND_API_KEY` env var at runtime. Both also `defineString('WEB_BASE_URL')` so the variable shows up on the function spec and the operator can set it via `functions/.env.<project>`.

`notifyOnRequestWrite` classifies the lifecycle transition:

- `before == null` && `after.status === 'pending'` → new request → managers.
- `before.status === 'pending'` && `after.status` flipped to `complete` → requester (`notifyRequesterCompleted`).
- … to `rejected` → requester (`notifyRequesterRejected`).
- … to `cancelled` → managers (`notifyManagersCancelled`).
- All other writes return early.

`notifyOnOverCap` fires only on the empty → non-empty transition of `stake.last_over_caps_json`. Continuing-overcap (`[A] → [A,B]`) and resolving-overcap (`[A] → []`) deliberately stay silent — operators get notified once per tip-over, not on every importer run that confirms the same condition. Source attribution (`'manual'` vs `'weekly'`) reads `stake.last_import_triggered_by`, defaulting to `'manual'` when absent (back-compat for pre-Phase-9 stake docs).

Both triggers re-exported in `functions/src/index.ts`.

### Sub-change D — Coexistence with Phase 10.5 push

`pushOnRequestSubmit` (Phase 10.5) and `notifyOnRequestWrite` (Phase 9) run as parallel triggers on the same Firestore path. No refactor merging the two — push and email are independent channels with different opt-in semantics: `notifications_enabled` is the email kill-switch on the stake; push has per-user `notificationPrefs.push.newRequest` on `userIndex`. The shared `activeManagers()` helper (sub-change G) is the only common surface; `pushOnRequestSubmit` was lightly refactored to call it instead of inlining the manager-active query.

### Sub-change E — Schema additions in `packages/shared/`

Append-only-safe additions (logged as T-32):

- `audit.ts` — `'email_send_failed'` added to `AuditAction`.
- `stake.ts` — `last_import_triggered_by?: 'manual' | 'weekly'` (read by `notifyOnOverCap` for subject attribution; importer writes it on every run); `notifications_reply_to?: string` (operator-configurable reply-to that defaults to omitted).

Both `Stake` fields are optional; absent on read is treated correctly by every consumer. No backfill required. Web consumers gain one new audit-action enum case; no surface renders distinct copy per audit action so no follow-up edit lands.

### Sub-change F — Importer touch (`functions/src/services/Importer.ts`)

`runImporterForStake` now stamps `last_import_triggered_by` on the stake doc per run. The classification is `'weekly'` iff `triggeredBy === 'weekly-trigger'` (the scheduled job's literal); everything else (manual button, callable invocation) maps to `'manual'`. Two-line edit; the field is consumed by `notifyOnOverCap` to attribute the over-cap email subject.

### Sub-change G — Shared helper (`functions/src/lib/managers.ts`)

`activeManagers(db, stakeId)` and `activeManagerEmails(db, stakeId)`. Both read `stakes/{sid}/kindooManagers` filtered to `active === true` and return `{canonical, email}` pairs / typed-email strings respectively. Used by both notification triggers (`notifyOnRequestWrite`, `notifyOnOverCap`) and as a small refactor of `pushOnRequestSubmit`. Returning the typed `member_email` (rather than the canonical doc id) matches the KindooManagers tab semantics — Resend gets the person's display address.

## Decisions made during the phase

Operator-decided departures from the pre-phase brief, plus discoveries during implementation. Operator approved all six recommendations from the plan up-front; the listed ones below are the ones worth recording.

- **Parallel triggers, no refactor of `pushOnRequestSubmit`.** Push and email are independent channels with different opt-in semantics; merging would muddle the kill-switch story. Phase 10.5's forward-reference comment expected this and is now superseded.
- **Email-only kill switch.** `notifications_enabled` on the stake gates email only. Push keeps its own per-user `notificationPrefs.push.newRequest` from Phase 10.5. Two switches, two surfaces.
- **Configurable `replyTo` field on Stake.** New optional `notifications_reply_to` lets a stake route replies to its bishopric / clerk inbox rather than the unmonitored `noreply@`. Empty/missing → no `Reply-To` header. Phase 9 ships the field but the manager UI surface to set it lands later (no Phase 9 sub-task; field is editable via direct Firestore writes for v1).
- **Shared `activeManagerEmails()` helper.** Three triggers read the same active-managers list (push + email-on-new-request + email-on-cancel). Inlining would have made the manager-active filter drift across triggers; one helper avoids it. `pushOnRequestSubmit` was lightly refactored to use the helper rather than its inline `seedClaims.ts`-style query.
- **Duplicate-email window during Phase 9 → Phase 11 transition: accepted as transient.** Apps Script Main still sends emails until cutover. Operators and requesters will receive two copies of each notification during the staging-and-rehearsal period. The cutover prerequisite is captured as T-33 (`@tad`-owned): operator flips Apps Script's `Config.notifications_enabled = FALSE` at cutover, before DNS flip.
- **Best-effort discipline on Resend retries.** Cloud Functions can re-deliver an event on transient errors. The audit row dedups via the deterministic `auditId(writeTime, suffix)` — same suffix per (request, type) pair — so re-deliveries collapse onto one audit row. The Resend send itself does not dedup; transient retries can produce duplicate sent emails, which we accept as the cost of best-effort.

## Cross-cutting decisions

- **Lazy `RESEND_API_KEY` read.** The wrapper reads the env var on first send rather than at module-load. Keeps the wrapper unit-testable without setting the env var, and matches `lib/messaging.ts` (FCM) precedent.
- **`.env.<project>` for `WEB_BASE_URL`, Secret Manager for `RESEND_API_KEY`.** Different secrecy classes — the API key is a credential (Secret Manager + IAM-bound access); the base URL is a non-secret deploy-time config (per-project env file). The runbook walks the operator through both. `.env.kindoo-staging` and `.env.kindoo-prod` are gitignored via the `functions/.env.*` glob added in `4665201`.
- **Best-effort send + visible-but-not-silent failures.** Resend send failures, link-builder throws, and audit-write throws all log + write an audit row + return — never re-throw. The trigger's calling context (the request lifecycle write) is never poisoned. The audit log is the operator's single pane for "did email actually go out?" review.
- **Verified envelope is fixed at the code level.** `noreply@mail.stakebuildingaccess.org` is hardcoded in `EmailService.ts` (`ENVELOPE` constant). Display name interpolates from `stake.stake_name`. A multi-stake future (Phase 12) where each stake has its own verified subdomain would need this lifted; v1 has one verified subdomain in Resend so the constant is correct.

No new architecture D-numbers earned. The trigger pattern reuses Phase 8's parameterized-trigger conventions; the schema additions are field-level optional; the wrapper mirrors the existing `lib/messaging.ts` shape.

## Spec / doc edits in this phase

`docs/spec.md` is **not** touched. Phase 9 ships behaviour that already exists in Apps Script Main (which `spec.md` still describes until Phase 11 cutover) — five email types fired on the same lifecycle transitions. The Firebase implementation matches the Apps Script behaviour rather than introducing new surface.

- `docs/architecture.md` — unchanged.
- `docs/firebase-migration.md` — Phase 9 entry's Status flipped to `[DONE — see docs/changelog/phase-9-resend-email.md]`. Sub-task list intact.
- `docs/firebase-schema.md` — **not** updated in this phase. The new `Stake.notifications_reply_to`, `Stake.last_import_triggered_by`, and `AuditAction = 'email_send_failed'` fields are not yet reflected in the schema reference. Same follow-up bucket as the Phase 10.3 / 10.4 / 10.5 schema-doc-sync entry in TASKS.md (T-28).
- `docs/data-model.md` — **not** updated. Same reason.
- `infra/runbooks/resend-api-key-setup.md` — new operator runbook (Phase 9 prereqs).
- `docs/TASKS.md` — T-32 (schema additions tracker, opened with the Phase 9 main commit), T-33 (Phase 11 cutover prerequisite), T-34 (`WEB_BASE_URL` cross-link to `deploy.md`).
- `docs/changelog/phase-9-resend-email.md` — this entry.

## Operator-side prerequisites

Documented in [`infra/runbooks/resend-api-key-setup.md`](../../infra/runbooks/resend-api-key-setup.md). The five steps:

1. Generate a Resend API key in the Resend dashboard, scoped **Sending access** only and bound to `mail.stakebuildingaccess.org`.
2. Stash the key in Secret Manager: `gcloud secrets create resend_api_key --data-file=-` (using `printf` not `echo` to avoid a trailing newline).
3. Grant `kindoo-app@<project>.iam.gserviceaccount.com` `roles/secretmanager.secretAccessor` on the secret.
4. Set `WEB_BASE_URL=https://stakebuildingaccess.org` in `functions/.env.kindoo-staging` and `functions/.env.kindoo-prod`. Cloud Functions auto-injects at deploy time; the file is gitignored.
5. Deploy + verify via `gcloud functions describe notifyOnRequestWrite` — the function's Secrets section should list `RESEND_API_KEY`; Environment variables should list `WEB_BASE_URL`.

The runbook also covers a six-step manual smoke test (one real send per notification type), DKIM verification (look for `via …` disclaimer absent in Gmail's "Show original"), and rotation procedure.

## Test footprint

- **Backend (functions):** 4 new test files, 40 new test cases.
  - `lib/resend.test.ts` — 2 cases: `_setResendSender` round-trip; cached client is dropped when the sender is restored.
  - `EmailService.test.ts` — 20 cases: subject + body shapes for all five notification types (lead-verb selection per request type, R-1 completion `Note:` line, over-cap pool listing); `notifications_enabled=false` short-circuit; `notifications_reply_to` plumbed through; missing `WEB_BASE_URL` lands as one `email_send_failed` audit row; Resend error path writes the deterministic audit row.
  - `notifyOnRequestWrite.test.ts` — 11 cases: each of the four lifecycle transitions invokes the right wrapper with the right payload; non-firing transitions stay silent (no-op write, status-stays-pending update, status-flip-from-already-terminal); active-manager filter respected for new-request + cancelled.
  - `notifyOnOverCap.test.ts` — 7 cases: empty → non-empty fires; continuing-overcap silent; resolving-overcap silent; `last_import_triggered_by='weekly'` produces "weekly import" subject; default `'manual'` when field absent; active-manager filter respected; sends to all flagged pools.
- **Web:** unchanged. Phase 9 is backend-only.
- **Shared:** schema round-trips updated for the three new fields; existing tests cover the new optional fields.
- **E2E:** unchanged. Real Resend sends aren't testable in Playwright; staging smoke-test path documented in the runbook covers the human-verifiable surface.

## Areas worth focused operator review during staging tests

- **Real send per notification type → DKIM passes on Gmail.** Open one of the test emails → "Show original" → look for `DKIM: PASS with domain mail.stakebuildingaccess.org` and `DMARC: PASS`. The sender line should NOT show `via …` (the legacy "via resend.dev" disclaimer).
- **`notifications_enabled=false` → no email sent; one log line emitted.** Toggle the kill-switch in Firestore directly (no UI surface yet), submit a request, confirm Cloud Functions logs show `email skipped — notifications_enabled=false` and Resend dashboard shows zero sends.
- **Send to known-bad address → `email_send_failed` audit row written; no crash.** Change a manager's `member_email` to `bounce@simulator.amazonses.com` (or any bogus domain), submit a request → confirm the trigger doesn't crash AND a row with `action=email_send_failed` appears in the audit log with the error message + code in the `after` payload.
- **Over-cap email lists pools correctly with counts/cap/over-by.** Manually nudge a ward `seat_cap` below its current count, run "Import Now" → verify the over-cap email arrives with one line per flagged pool and a working deep link to `/manager/seats`.
- **R-1 completion email surfaces `Note:` line for `completion_note`.** Mark complete with a `completion_note` set → verify the requester's email body has the `Note:` line; mark complete without a note → verify the line is absent.
- **Duplicate emails during the migration window.** Apps Script Main + Firebase will both send during staging rehearsal. Operator gets two of each notification; this is expected and tracked as T-33 — the cutover-day flip silences Apps Script.

## Risks worth recording

- **Resend free tier (100/day, 3000/month) is fine for one stake but tight at multi-stake (Phase 12).** A single stake with 12 wards generates roughly one notification per request (~1–2/week per the docs/spec.md scale targets); multi-stake fanout would add over-cap emails per stake per importer cycle. Revisit at Phase 12 — likely paid tier at that point.
- **Cloud Functions retries can re-send on transient errors.** The audit row dedups via the deterministic `auditId(writeTime, suffix)` — same suffix per (request, type) pair — so the audit log won't show duplicate failure rows. The Resend send itself does NOT dedup; a transient Cloud Functions retry that succeeds the second time will produce two delivered emails. Best-effort discipline; accepted at this scale.

## Deferred / follow-ups

- **T-32** (open) — schema-doc sync for the three new fields rolls into the existing `firebase-schema.md` / `data-model.md` sync bucket (T-28 covers Phase 10.3 fields; expand the next sync pass to include T-32 fields too).
- **T-33** (open, `@tad`) — Phase 11 cutover prerequisite: flip Apps Script Main's `Config.notifications_enabled = FALSE` at cutover before DNS / traffic flip. Bake into the Phase 11 cutover runbook.
- **T-34** (open, `@infra-engineer`) — cross-link `WEB_BASE_URL` env var into `infra/runbooks/deploy.md` so the per-project deploy checklist surfaces it without requiring the operator to follow the Resend runbook.
- **Manager UI surface for `notifications_reply_to`.** Field exists; no UI to set it. Operator edits via direct Firestore write for v1. UI surface lands when the broader Configuration page revisits notifications.
- **Per-category email opt-out.** Out of scope for v1. Same shape as the Phase 10.5 push per-category toggles deferral — revisit if measured need emerges.

## Next

Phase 11 (data migration + cutover) is the open critical-path lane. T-33 (Apps Script `notifications_enabled` flip) is a cutover-day prerequisite — bake into the cutover runbook before the rehearsal-pass. Phase 10.1 (left-rail nav redesign) remains operator-deferred. No new phase gated on Phase 9 closing.
