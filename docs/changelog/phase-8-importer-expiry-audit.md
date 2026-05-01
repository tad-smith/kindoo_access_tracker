# Phase 8 — Importer + Expiry + audit triggers

**Shipped:** 2026-04-29
**Commits:** see PR [#31](https://github.com/tad-smith/kindoo_access_tracker/pull/31) (5 commits on `phase-8-importer-expiry-audit`); the audit trigger itself shipped earlier in PR [#21](https://github.com/tad-smith/kindoo_access_tracker/pull/21) and is augmented here for `auto_expire`.

## What shipped

The whole Phase 8 backend lane: weekly LCR importer, daily temp-seat expiry, the unified `auditTrigger`'s `auto_expire` action, the three Cloud Scheduler dispatchers (`runImporter` / `runExpiry` / `reconcileAuditGaps`), the manager-invoked `runImportNow` callable, the bootstrap-wizard `installScheduledJobs` callable, the `removeSeatOnRequestComplete` Admin-SDK trigger that completes Phase 6's deferred remove-flow, and the operator runbook for granting the importer service account Viewer access on the LCR sheet. Acceptance criteria from `firebase-migration.md` line 1100 onward — daily expiry, weekly import, manual Import Now, idempotency, audit trigger fan-in within 1s, reconciliation alerts — all met. Tests: 52 unit (diff math, parser, schedule dispatch, over-cap math) + 32 integration (full importer cycles, expiry behaviour, scheduled-dispatcher gating, remove-completion fan-in) + the existing 39 trigger tests still green; new fixtures cover the eleven importer integration cases enumerated in the migration plan minus the structural-no-op (deviation #1) and the YAGNI'd concurrent-run guard (deviation #2).

The phase shipped over 5 commits, three milestone commits with two follow-ups in response to the docs-keeper's acceptance-walk.

### Milestone 1 — `auditTrigger` `auto_expire` (`1633a35`)

The unified audit trigger from PR #21 emitted `delete_seat` on every seat delete. Phase 8's expiry path needs the trigger to distinguish operator-initiated deletes from the daily expiry sweep. Fix: detect a seat delete with `BEFORE.lastActor.canonical === 'ExpiryTrigger'` and emit `auto_expire` instead. The Expiry service stamps the synthetic actor on the seat just before deletion (a bookkeeping-only update the trigger silently skips via the existing same-state-skip), then deletes; the trigger sees the stamped BEFORE state on the delete event and routes accordingly. Two new auditTrigger tests cover the discrimination path; the same-state-skip bookkeeping-update path is already covered by existing trigger tests.

### Milestone 2 — Importer + Expiry services (`2adb532`)

`functions/src/services/Importer.ts` (~540 LoC) ports `Importer.gs` against the Firebase data model:

- **Parser (`functions/src/lib/parser.ts`):** header location anywhere in the top 5 rows; `Position` / `Name` / `Personal Email` column resolution; ward-tab prefix stripping (`CO Bishop` → `Bishop`) vs. stake-tab verbatim; calling-template matching (exact wins, then `*` wildcards in sheet-order); multi-name cell split with comma-delimit + email overflow; `GoogleAccount` cell extraction.
- **Diff planner (`functions/src/lib/diff.ts`):** pure function, groups parsed rows by canonical email, collapses multi-calling rows to one Seat doc with `callings[]` (Q3), enforces primary-scope priority `stake > ward (alphabetical)`, routes cross-scope auto findings to `duplicate_grants[]`. Critically: `manual_grants` is never touched (`importer_callings[scope]` is replaced wholesale per processed scope; the manual map is left alone — the field-level split-ownership boundary that rules also enforce).
- **Sheets API client (`functions/src/lib/sheets.ts`):** `googleapis` npm package, test-injectable fetcher.
- **Service:** applies the diff via Admin SDK; stamps `lastActor={email,canonical:'Importer'}` on each access + seat write so the `auditTrigger` fans per-row audit rows automatically with `actor_canonical='Importer'`. `import_start` / `import_end` / `over_cap_warning` audit rows are written directly because there's no entity write to fan from.
- **Over-cap (`functions/src/lib/overCaps.ts`):** ward `seat_count` vs `wards.seat_cap`; stake portion-cap is `stake_seat_cap - sum(ward seats)`. Persists snapshot to `stakes.{sid}.last_over_caps_json`; emits `over_cap_warning` when non-empty; emails best-effort (deferred to Phase 9).

`functions/src/services/Expiry.ts` (~100 LoC):

- Scans `stakes/{sid}/seats` for `type=='temp' AND end_date < today (in stake.timezone)` (strict less-than — `end_date == today` survives).
- Two-step delete: (1) update the seat with `lastActor={canonical:'ExpiryTrigger'}` (bookkeeping-only update; the auditTrigger's same-state predicate skips it), then (2) delete; the trigger sees the stamped BEFORE state and emits `auto_expire`.

`functions/src/lib/schedule.ts`: pure `shouldRunImporter(stake, now)` / `shouldRunExpiry(stake, now)` against `(day, hour)` in `stake.timezone`; loops-over-stakes pattern per F15.

### Milestone 3 — scheduled dispatchers + callables + remove-on-complete trigger (`2aeba76`)

Scheduled jobs (single-job-loops-over-stakes per F15):

- `runImporter`: hourly Cloud Scheduler fire; loops over stakes whose `(import_day, import_hour)` match the current local time per `stake.timezone`. Skips stakes with `setup_complete=false`.
- `runExpiry`: hourly Cloud Scheduler fire; loops over stakes whose `expiry_hour` matches the current hour. Skips stakes with `setup_complete=false`.
- `reconcileAuditGaps`: nightly Cloud Scheduler fire; counts entity docs vs `auditLog` rows per stake; logs warn when gap > 1%. Read-only — no Firestore writes, no side-effects beyond the log line.

Callables:

- `runImportNow`: manager-invoked. Verifies the caller via Admin SDK lookup against `kindooManagers/` (stronger than relying on potentially-stale custom claims, per the Phase 6 force-refresh-token learnings). Returns the `ImportSummary`.
- `installScheduledJobs`: bootstrap-wizard hook. Idempotent — Cloud Scheduler jobs are platform-managed and already exist after deploy; the callable validates the stake's schedule fields and acknowledges. The job creation itself is a deploy-time concern, not a runtime callable.

Trigger:

- `removeSeatOnRequestComplete`: fires on `stakes/{sid}/requests/{rid}` writes. When status flips `pending → complete` AND `type=='remove'` AND a corresponding seat exists, deletes the seat via Admin SDK. The audit trigger fans `delete_seat` from the resulting seat-delete event. R-1 race safe: no-op when the seat is already gone (the Phase 6 client transaction handled the no-op-if-already-deleted case; this trigger handles the seat-still-exists case). Fills the gap left by Phase 6 — Firestore rules' `delete` operations don't have access to incoming data, so a client-side `runTransaction` couldn't enforce the request-status precondition on the seat delete; only an Admin-SDK trigger can.

### Milestone 4 — service-account share runbook (`22c2350`)

`infra/runbooks/granting-importer-sheet-access.md` — per-stake bootstrap step: file → share → add `kindoo-app@<project>.iam.gserviceaccount.com` as Viewer. Standalone checklist so the bootstrap admin can complete it during the Phase 7 wizard's Configuration step. Closes [T-05](../../docs/TASKS.md).

### Milestone 5 — acceptance-criteria sweep (`4468fd3`)

Three test gaps closed against the migration plan's acceptance list:

- **Removed-calling-from-template → auto seat deleted.** Integration test in `Importer.test.ts` covers a full importer cycle where the template loses a row mid-deploy.
- **`lastActor=Importer` stamped on access + seats** — explicit assertion that an importer-shaped access write produces `actor_canonical='Importer'` end-to-end via the audit trigger. Plugs the gap between "the importer stamps lastActor" and "the audit trigger reads lastActor" — both sides verified independently before; this asserts the integration.
- **Scheduled dispatchers skip stakes with `setup_complete=false`** — two cases in `scheduled.test.ts` covering both `runImporter` and `runExpiry`.

## Deviations from the pre-phase spec

Three deviations from the migration plan's letter, all resolved before close.

- **Promotion-on-empty-callings** (sub-task line 1014). The migration plan specified a path where an `auto`-primary seat whose callings empty out promotes a manual/temp duplicate to primary. Under the doc-per-person split-ownership model shipped in Phase 3 and exercised here, this scenario is **structurally unreachable**. `seats/{canonical}` has manager-driven primary (`type='manual'`/`'temp'`) iff any manual/temp grant exists for that person; an `type='auto'` primary therefore cannot have a manual/temp entry in `duplicate_grants[]`. Cross-scope auto-to-auto promotion is implicit in the diff planner's per-run rebuild of `desiredAutoSeats` (`functions/src/lib/diff.ts:202–235`), not via `duplicate_grants[]`. Annotated `[RESOLVED 2026-04-29]` inline in `firebase-migration.md` §Phase 8 sub-tasks and tests.
- **Concurrent-run guard** (test line 1079). The migration plan called for a Firestore-based mutex against simultaneous expiry + manual-import invocations. YAGNI'd for v1: Cloud Functions 2nd-gen scheduled jobs default to `max-instances=1` (single-runner per scheduled fire); the importer's idempotent design means concurrent manual `runImportNow` invocations converge to the same Firestore state. At 1–2 imports/week scale, contention risk is minimal. Annotated `[RESOLVED 2026-04-29 — YAGNI]` in `firebase-migration.md`. Revisit if contention is observed.
- **Import Now E2E spec** (Phase 8 E2E test list, lines 1093–1097). The Playwright specs ("Manager clicks Import Now → status updates", Configuration `import_day` / `import_hour` persistence, live audit log entries appear) target the manager UI, not the backend. Deferred to web-engineer's plate alongside the Phase 7 manager-UI close. Tracked as a follow-up task; not blocking Phase 8 acceptance which is backend-only.

## Decisions made during the phase

The load-bearing decision was the **`ExpiryTrigger` synthetic actor stamping pattern** — a bookkeeping-only update to mark `lastActor.canonical='ExpiryTrigger'` on a seat before deletion, so the existing unified `auditTrigger` can route the resulting delete event to `auto_expire` rather than `delete_seat`. The auditTrigger's same-state-skip predicate silently elides the bookkeeping update. This is the cleanest way to discriminate system-actor deletes from operator-initiated deletes without splitting the trigger or adding side-channel state. The pattern generalises if other system actors need similar discrimination later (e.g., a future stake-deactivation sweeper).

The **`runImportNow` callable verifies the caller via Admin SDK lookup against `kindooManagers/`** rather than relying on the manager custom claim. Phase 6's force-refresh-ID-token saga (multi-round Issue 16 investigation) demonstrated that claim staleness is real and that Cloud Functions seeing a stale claim is a worse failure mode than the extra Firestore round-trip on a manually-triggered import. For interactive write callables in Phase 8+, the canonical pattern is: ID-token verifies the user is signed in; Firestore lookup against the role doc verifies authority.

No new architecture D-numbers earned. The doc-per-person split-ownership shape is the canonical schema in `firebase-schema.md` §4.5–§4.6 and was already locked in at Phase 3 close (PR #20); Phase 8 is the first phase to exercise its load-bearing implications for the importer + expiry diff logic, but no new design decision was made — the existing schema dictated the importer's shape.

## Spec / doc edits in this phase

`docs/spec.md` is **not** touched. Phase 8 is a behaviour-port of the Apps Script importer + expiry; `spec.md` describes Apps Script reality until Phase 11 cutover.

- `docs/architecture.md` — unchanged. The doc-per-person split-ownership model is already canonical via `firebase-schema.md` §4.5–§4.6; no new D-number earned.
- `docs/firebase-migration.md` — three `[RESOLVED 2026-04-29]` annotations on §Phase 8 sub-tasks and tests covering the structural promotion no-op, the YAGNI'd concurrent-run guard, and (implicit in the audit trigger augmentation) the `auto_expire` action. Original wording preserved.
- `docs/firebase-schema.md` — unchanged. Schema shipped at Phase 3 close; Phase 8 consumes it.
- `docs/changelog/phase-8-importer-expiry-audit.md` — this entry.
- `docs/TASKS.md` — T-05 (LCR sheet sharing) already marked done by infra-engineer; no new task entries surface from this phase.

## Deferred / follow-ups

- **Cloud Scheduler verification on first deploy.** The three scheduled jobs (`runImporter`, `runExpiry`, `reconcileAuditGaps`) deploy as 2nd-gen scheduled functions. First-deploy verification (jobs visible in Cloud Scheduler console; firing on schedule; logs reaching Cloud Logging) is on infra-engineer's plate during the Phase 8 production deploy. No code change anticipated; failure surface is platform-side.
- **Resend integration → Phase 9.** The over-cap email is wired up to "log only" today; the real send-via-Resend wrapper lands with the rest of the Phase 9 notifications.
- **Operator walks `granting-importer-sheet-access.md` once.** First per-stake bootstrap to exercise the runbook is the v1 cutover; T-05 is already closed but the runbook itself hasn't been walked yet on a real bootstrap admin's account.
- **Concurrent-run guard.** Not implemented. Revisit if contention is observed at scale (Phase 12 multi-stake era is the natural re-evaluation point).
- **Import Now E2E spec.** Web-engineer follow-up alongside Phase 7 close; not blocking.

## Next

Phase 9 — email triggers via Resend. Backend-engineer's lane. The Phase 8 stake-doc `last_over_caps_json` field and the request-lifecycle audit rows already shipped are the trigger sources Phase 9 wires up. The `auditTrigger` deterministic-ID idempotency (`{writeTime}_{collection}_{docId}`) and the `lastActor` actor-stamping pattern are both load-bearing for any Phase 9 trigger that needs to distinguish system-emitted writes from operator writes.
