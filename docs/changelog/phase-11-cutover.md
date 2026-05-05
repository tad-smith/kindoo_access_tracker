# Phase 11 — Data migration + cutover

**Shipped:** 2026-05-03
**Commits:** see PRs [#48](https://github.com/tad-smith/kindoo_access_tracker/pull/48) (env-file split), [#49](https://github.com/tad-smith/kindoo_access_tracker/pull/49) (kindoo-app SA role grants), [#50](https://github.com/tad-smith/kindoo_access_tracker/pull/50) (hosting predeploy fix). The cutover itself was an operator-driven sequence of staging-side rehearsal, prod stand-up, and DNS flip rather than a single feature commit.

## What shipped

The Firebase app is live in production at `kindoo-prod`; `kindoo.csnorth.org` resolves to Firebase Hosting; the Apps Script app is no longer in any user's request path. Live data was moved from the LCR Sheet into Firestore via the existing manager-triggered importer; no separate migration script was written. Bootstrap admin `admin@csnorth.org` walked the setup wizard cleanly on prod. End of Phase A.

The cutover is a milestone, not a single PR. The three PRs that landed during cutover bring-up are bug fixes the operator surfaced while standing the prod environment up — they are referenced inline against the migration-plan sub-tasks they touch in the section below. Most of the migration plan's Phase 11 sub-tasks were intentionally not executed; see "What did not happen, and why" for the reasoning.

## Migration approach: importer-as-migrator

The migration plan called for a dedicated `infra/scripts/migrate-sheet-to-firestore.ts` plus a `--dry-run` flag plus `infra/scripts/diff-sheet-vs-firestore.ts` plus rehearsal on a snapshot. None of that was written. Instead the operator ran the existing `runImportNow` callable — the same Cloud Function manager-button path that pulls per-tab calling rows from the LCR Sheet on every weekly import — against a freshly-bootstrapped `kindoo-prod`. That was sufficient for v1's data because:

- Auto seats and importer-sourced access entries are exactly what the importer produces; running it against a clean Firestore reproduces the live state by construction.
- Manual seats and manual access grants were re-entered through the manager UI rather than migrated. At v1 scale (one stake, ~250 seats) the manual surface is small enough that hand re-entry was cheaper than writing a transformation script.
- Audit log history from the Apps Script Sheet tab was deliberately not preserved. The new audit log starts at cutover; the legacy Sheet still exists as a read-only archive if a historical lookup is ever needed.

This collapsed the migration-script-plus-rehearsal-plus-diff-helper-plus-counts-verification scope to one button click. The trade-off is that audit history and any manually-edited Sheet state did not cross over. For v1 that is acceptable.

## DNS flip

`kindoo.csnorth.org` previously resolved to GitHub Pages, where the static `website/index.html` iframe wrapper at the root re-pointed users at the Apps Script `/exec` URL. After the cutover the same hostname resolves to Firebase Hosting on `kindoo-prod`. Procedure followed `infra/runbooks/custom-domain.md`.

The Apps Script Main and Identity deployments still exist as Apps Script projects (their source is in `src/` and `identity-project/` for reference), but no DNS hop reaches them and no user-facing URL points at them. They are effectively decommissioned by virtue of being unreachable.

`stakebuildingaccess.org` (the F17 brand domain) is NOT live yet. That apex flip is Phase B branding work and stays explicitly out of Phase 11 scope per the migration plan.

## Cutover ops gotchas

These surfaced during prod bring-up; runbook fold-ins are referenced where they happened.

**Eventarc Service Agent first-time-2nd-gen-functions propagation delay.** The first deploy of any 2nd-gen Cloud Function on a fresh project provisions the Eventarc Service Agent asynchronously. Until that lands, Firestore-trigger function deploys fail with an opaque permission error. The wait-and-retry loop the operator ran through eventually succeeded; subsequent deploys were clean. The runbook's provision step now mentions this in passing.

**`kindoo-app` SA role grants.** Two roles were missing from the original step 1.8 of `infra/runbooks/provision-firebase-projects.md`: `roles/eventarc.eventReceiver` (required for any 2nd-gen function pinned to `kindoo-app@` that consumes a Firestore-Eventarc event — the email and FCM push triggers both qualify) and `roles/firebasecloudmessaging.admin` (required for `messaging.send()` from the FCM push trigger). PR #49 added both to the runbook so step 1.8 grants five roles instead of three. T-26 still tracks the broader hardening pass — pin every remaining function to `kindoo-app@`, audit `gcloud projects get-iam-policy`, and revoke the project-default `roles/editor` on the default compute SA.

**Hosting predeploy hook clobbered the staging build mode.** The original `firebase.json` had `hosting.predeploy` running `pnpm --filter @kindoo/web build` (T-09 close), which always built with the production Vite mode regardless of which `--project` was passed to `firebase deploy`. PR #50 removed the predeploy hook entirely. The deploy script now invokes the appropriate `pnpm build` mode explicitly before `firebase deploy --only hosting`. T-09's original concern (operator forgetting to rebuild before deploy) is handled by the deploy script rather than by the predeploy hook.

**Per-mode env files.** PR #48 split web env from a single `.env` into per-mode `.env.staging` / `.env.production`. The split was needed once `kindoo-staging` and `kindoo-prod` had distinct Firebase configs; the prior single-env shape conflated them.

**Bootstrap-admin claim seeding race.** The setup-gate logic in `apps/web` was using `??` to fall back when the principal had no claims yet, but the bootstrap admin's first sign-in writes the `userIndex` doc via `onAuthUserCreate` and then needs the canonical claim minted before the bootstrap-admin gate predicate can match. With `??` the gate took the wrong branch on the first render and bounced the user away from the wizard. The correct fallback operator is `||`, treating an empty-string claim the same as an absent one. This is captured as B-2; not yet filed in `BUGS.md`.

## Known issues at cutover time

- **B-1** — iPhone PWA notification tap does not deep-link to `/manager/queue?focus=<rid>`. Push delivery itself works; the `notificationclick` chain breaks somewhere on iOS. Open; investigation has not started. Workaround: manual navigation.
- **B-2** — bootstrap-admin setupGate fallback used `??` instead of `||`, so an empty-string claim took the wrong code path on first render. Fixed during cutover bring-up; the bug entry has not been filed in `BUGS.md` yet.

## What did not happen, and why

The migration plan's Phase 11 sub-task list is long and spans rehearsal, smoke tests as each role, banner-and-comm steps, formal Apps Script disable, sheet write-access revocation, post-cutover monitoring, and repo cleanup. The pragmatic-cutover reality executed a much smaller subset. Each deferral below is a deliberate scope choice, not a miss.

**Migration script (`infra/scripts/migrate-sheet-to-firestore.ts`, `--dry-run` flag, `diff-sheet-vs-firestore.ts`).** Never written. The existing importer reproduces the live state by construction; manual seats and manual access were re-entered by hand. At v1 scale this was cheaper than building, testing, and rehearsing a transformation script. Phase 12 (multi-stake) is the natural place to revisit if cross-stake migration ever needs an automated path.

**Pre-cutover staging rehearsal (snapshot Sheet → staging-source, walk as each role, sample-20 audit-row comparison, performance baselines, full importer / expiry / email-per-type cycle, real-device PWA install).** Not executed as a discrete phase. The operator instead exercised the same surfaces incrementally during phases 4-10 of the migration. By the time prod stood up there was no remaining rehearsal value worth a separate window.

**Banner on Apps Script app 24h pre-cutover; communication to managers + bishopric leads.** Skipped. The user volume (1-2 requests/week, ~12 wards) made the in-band communication channel sufficient and the banner not worth wiring through a soon-to-be-decommissioned codebase.

**Formal Apps Script disable / web-app archive.** Not done. The DNS flip alone removes Apps Script from the request path; no user URL points at it. The codebase is still in `src/` and `identity-project/` for reference but is no longer executed in production. T-33 (the Apps Script `notifications_enabled` flip) was technically the only required pre-flip step in the cutover sequence and is no longer relevant — both worlds were briefly co-running during phases 9-11 but the duplicate-email window is over now that DNS does not route to Apps Script.

**Legacy Sheet write-access revocation.** Not yet done. The operator left the legacy LCR Sheet write-accessible. Not blocking — the Apps Script importer is no longer consuming it, and the new Firebase importer reads it through a separate service account — but worth doing eventually so accidental edits do not surprise anyone. Tracked as a follow-up.

**Post-cutover monitoring (24-48h Cloud Functions logs review, Firestore rules-denied count, error-rate threshold, push-delivery rate; one-week Apps Script archive-as-rollback; nightly reconcile-audit-gaps verification).** Not formalized. The operator is monitoring opportunistically rather than running a structured 48-hour review. Acceptable at this scale; the audit log itself is the source of truth if anything looks off.

**Repo cleanup (delete `src/`, `identity-project/`, `.clasp.json`, clasp deps, `pnpm-workspace.yaml` updates, root `CLAUDE.md` Apps Script-specific guidance removal).** Not in this commit. Root `CLAUDE.md` is updated by this PR to reflect that Apps Script is decommissioned, but the source itself stays in the tree as historical reference. Deletion can land later as a focused cleanup PR; git history would preserve the Apps Script code regardless.

**`docs/data-model.md` rewrite to redirect to `firebase-schema.md`; `docs/build-plan.md` Chunk 11 supersession marker; identity-project README archive.** Not in this commit. Phase 11 close prioritizes `spec.md` and the live-state docs; the historical-reference docs (`build-plan.md`, the chunk plan, the identity-project README) stay untouched for now.

## Spec / doc edits in this phase

Spec.md is rewritten from describing Apps Script reality to describing Firebase reality. This is the largest spec edit of the migration; per the migration-plan instruction, Phase 11 cutover commits update `spec.md` to describe Firebase reality.

- `docs/spec.md` — full rewrite. Section 2 (Stack) is now Firebase Auth + Firestore + Cloud Functions + Hosting. Section 3 (Data model) cross-references `firebase-schema.md` rather than restating Sheet tabs. Section 4 (Role resolution) is custom-claims-based. Sections 6 (Request lifecycle), 8 (Importer), 9 (Email), 10 (Bootstrap), 11 (Concurrency), 12 (Custom domain) updated to Firebase implementations. Section 14 (Build order — 11 chunks) marked historical.
- `docs/firebase-migration.md` — Phase 11 status flipped to `[DONE]`; sub-tasks not executed are tagged `(deferred — see Phase 11 close note in changelog)` rather than ticked. Phase dependency overview language updated.
- `docs/changelog/phase-11-cutover.md` — this entry.
- `CLAUDE.md` (root) — "Current status" rewritten. "Two worlds during migration" framing removed; Firebase is the only world now.
- `docs/CLAUDE.md` — migration-period special-handling block updated to past tense.
- `docs/architecture.md` — NOT touched in this commit. The Apps Script-era D-numbers (D1-D10) remain as historical record per the migration-plan instruction; Firebase decisions are already captured as D11. A future doc-cleanup pass can add `[Historical: pre-Phase 11]` tags to Apps Script-specific sections if the architecture doc starts feeling cluttered.

## Deferred / follow-ups

- **B-1** (open) — iPhone PWA notification deep-link.
- **B-2** (not yet filed) — setupGate `??` → `||` fallback. Bug entry to be added to `BUGS.md` separately.
- **`stakebuildingaccess.org` apex flip** (F17 / Phase B branding) — explicitly deferred per migration plan line 1432 ("the legacy `kindoo.csnorth.org` GitHub-Pages-iframe-wrapper URL is decommissioned at Phase 11 cutover; the apex-pointing procedure is part of Phase B").
- **Legacy LCR Sheet write-access revocation** — operator follow-up.
- **Post-cutover monitoring sweep** — formalized 48-hour review still owed if any signal warrants it; opportunistic monitoring covers the no-signal case.
- **Repo cleanup** (delete `src/`, `identity-project/`, clasp tooling) — separate PR when convenient.
- **Migration plan's "Doc updates" list** — `data-model.md` rewrite, `build-plan.md` Chunk 11 marker, identity-project README archive — separate doc-cleanup pass.
- **T-26** (open) — Phase 11 SA hardening (pin remaining functions to `kindoo-app@`, audit IAM, revoke project-default `roles/editor`). Runbook fold-in landed via PR #49; the SA pinning + audit work remains.
- **Phase 12** (multi-stake) — deferred until at least one second stake is in scope.

## Next

Phase A is closed. No phase is gated on Phase 11 anymore. Open work surfaces:

- B-1 investigation when the operator schedules it.
- F17 apex-domain flip if/when branding moves to `stakebuildingaccess.org`.
- Phase 10.1 (left-rail nav redesign) and Phase 10.6 (push expansion) remain operator-deferred.
- Phase 12 (multi-stake) remains gated on a second-stake commitment.
