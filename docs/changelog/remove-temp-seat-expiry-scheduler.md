# Remove temp-seat expiry scheduler

**Shipped:** 2026-06-05
**Commits:** PR #210 (`chore/remove-temp-seat-expiry-scheduler`) — backend foundation `ada2207`, web + e2e `330073a`, extension `ad96e4e`, docs (this commit)

## What shipped

The Phase 8 SBA-side temp-seat expiry scheduler is gone. SBA no longer mutates seats on a schedule; Kindoo is the sole authority for seat lifecycle.

Deleted:

- `runExpiry` Cloud Function, `functions/src/services/Expiry.ts`, and `functions/src/lib/schedule.ts` (the single-loop hour-matching helper), plus the Cloud Scheduler job that fired the wrapper.
- The `auto_expire` audit action and the `"ExpiryTrigger"` synthetic actor — removed **entirely** from `packages/shared` (`AuditAction`, the `actor_email` doc comment, `AUTOMATED_ACTOR_NAMES`). Operator decided against retaining legacy audit support: no fresh writes produce them, and the few historical rows (if any survive the 365-day TTL) are not worth carrying a dead filter option. The web Audit Log drops the `auto_expire` `<option>` and the `ExpiryTrigger` placeholder text.
- The `expiry_hour`, `last_expiry_at`, and `last_expiry_summary` fields on the `Stake` type / zod schema. `timezone` stays — it now feeds only audit-log date filtering.
- The Dashboard's fifth "Last Operations" card (it displayed only `last_expiry_at`). Four cards remain: Pending Requests, Utilization, Warnings, Recent Activity.
- The Configuration Config-tab `expiry_hour` input and its validation.

Kept and unchanged:

- `reconcileAuditGaps` — the nightly audit-gap reconciliation job. It is now SBA's only scheduled job.
- `installScheduledJobs` — the bootstrap-wizard "Complete Setup" callable. It still verifies the caller is an active manager and that `stake.timezone` is set, then returns; it no longer reads `expiry_hour`.

## Why

Kindoo is authoritative for seats, and temp seats are already time-bound **in Kindoo**. When Kindoo expires a temp user's access, the extension's Sync detects the now-orphaned SBA seat as `sba-only` and removes it through the existing "Remove From SBA" path (`syncApplyFix`, `spec.md` §8) — the same path that reaps every other Kindoo-side removal. The SBA-side scheduler was a second, independent expiry clock racing Kindoo's: it could delete a seat Kindoo still considered live, or lag one Kindoo had already expired, and it duplicated removal logic Sync already owns. Removing it collapses SBA to one source of truth for seat lifecycle and one scheduled job. This continues the consolidation D14 began (the importer's removal) and the Kindoo-authoritative Sync direction settled in `sync-kindoo-authoritative.md`. Recorded as `architecture.md` D19.

## What didn't change that you'd expect to

- **`timezone` stays on the stake doc and in the wizard.** It still scopes audit-log date filtering (and `createStake` still seeds it); only its expiry-scheduling role went away.
- **Temp seats still exist as a seat type.** The seat-type model (`temp`, with `start_date` / `end_date`) is unchanged — `edit_temp` requests, the New Request `add_temp` flow, and roster date display all stand. What changed is only how the seat is *removed* at end-of-life: Kindoo + Sync, not an SBA scheduler.
- **`reconcileAuditGaps` and `installScheduledJobs` survive.** The single-loop scheduling pattern is intact for the one remaining job.
- **The over-cap recompute deferral is unchanged for Sync.** `syncApplyFix` still does not recompute over-caps; the next request completion catches up. The spec sentence that previously also named the expiry trigger here was trimmed (the trigger no longer exists), not the behaviour.

## Spec / doc edits

- `docs/spec.md` — §1 Temporary-seat Lifecycle cell rewritten to the Kindoo-expires + Sync-removes model; §2 Server-compute and Scheduling bullets (only `reconcileAuditGaps` remains); §3.2 stake fields (dropped `expiry_hour` / `last_expiry_at`); §3.3 automated actors (dropped `"ExpiryTrigger"`); §5.3 Dashboard (five → four cards), Configuration (dropped `expiry_hour`), Audit Log (actor-filter list reworded); §6 R-1 race example reworded; §7 body rewritten (heading kept to avoid renumbering); §8 over-cap paragraph (dropped the expiry-trigger half); §10 Bootstrap `installScheduledJobs` description.
- `docs/architecture.md` — added D19 recording the retirement; cites D14 ("one scheduled job" now) and the Phase 8 deliverable it supersedes.
- `docs/firebase-schema.md` — §4.1 stake doc (removed three fields; `timezone` comment updated); §4.10 audit action enum (dropped `auto_expire`) and actor comment; §7 Cloud Functions inventory (removed `runExpiry`).
- `docs/firebase-migration.md` — Phase 8 carries a `[SUPERSEDED — in part]` note (history preserved per convention).

## Known issues / deferred

- **`functions/CLAUDE.md` still references `runExpiry` / `Expiry.ts` / `ExpiryTrigger`** in its file-layout and don't-write-audit notes. That file's content is owned by `backend-engineer`; flagged for the foundation branch — see `docs/TASKS.md` T-69.
- **Historical `auto_expire` audit rows** (pre-removal) are no longer surfaced in the action-filter palette by deliberate operator choice. They are not deleted; they age out with the 365-day audit TTL.
