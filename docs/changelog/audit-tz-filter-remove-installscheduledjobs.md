# Audit Log stake-tz date filter + remove installScheduledJobs

**Shipped:** 2026-06-05
**Commits:** PR #214 (`chore/audit-tz-filter-remove-installscheduledjobs`) — drop callable `dd11eba`, audit-tz filter + drop web caller `e7c3489`, functions CLAUDE.md `5e21798`, docs (this commit)

## What shipped

Two cleanups landing on the heels of D19 (which retired the expiry scheduler).

**Audit Log date filter is now stake-tz-aware.** The filter computes its inclusive day boundaries in the stake's IANA `timezone` instead of UTC, so a filter for a given calendar day matches the rows that *display* on that day. Before, the timestamps rendered in stake time but the filter sliced days at UTC midnight, so "June 4" could exclude a row that read June 4 in Denver but landed June 5 UTC. New `startOfDayInStakeTz` / `endOfDayInStakeTz` helpers in `apps/web/src/lib/datetime.ts` resolve a `YYYY-MM-DD` to the absolute instant of `00:00:00.000` / `23:59:59.999` of that day in `tz` (forming the naive UTC instant, measuring `tz`'s offset for the target day via `Intl` sampled at noon to dodge the DST midnight edge, then subtracting). Both fall back to `America/Denver` when `timezone` is undefined — the same default the display formatters use, so behaviour is unchanged for the current Denver stake. The zone threads through `useAuditLogInfinite` → `buildConstraints` and joins the TanStack query key so a stake/tz change refetches.

**`installScheduledJobs` is deleted.** The callable (`functions/src/callable/installScheduledJobs.ts`), its web wrapper (`apps/web/src/features/bootstrap/callables.ts`), the bootstrap-wizard Complete-Setup invocation, and the 184-line e2e spec (`e2e/tests/manager-admin/install-scheduled-jobs.spec.ts`) are gone. After D19 it was a no-op verifier (manager-auth + `stake.timezone` check, no creates) because the only surviving scheduled job (`reconcileAuditGaps`) is single-loop and platform-managed — nothing per-stake to install. The bootstrap wizard's **"Complete Setup"** is now the rules-gated `stake.setup_complete=true` Firestore flip alone (one `updateDoc` carrying the `lastActor` integrity field); the `auditTrigger` still fans the `setup_complete` audit row, and the routing gate redirects on the flip. No callable is invoked.

## Deviations from the pre-phase spec

None. `spec.md` §5.3 already described the filter as "inclusive on both ends in stake timezone" (a forward-looking claim the code did not yet honour); this PR makes it true and the spec edits below tighten the wording and the Complete-Setup description to match the shipped code.

## Decisions made during the phase

- Stake-local time semantics resolve uniformly through `stake.timezone` (Audit Log display + filter, superadmin stake-list `created_at`), and `installScheduledJobs` is retired now that the last scheduled job needs no per-stake install. Recorded as `architecture.md` **D20** (supersedes D19's "`installScheduledJobs` survives" clause).

## Spec / doc edits

- `docs/spec.md` — §2 Server-compute (generalized "callable endpoints for the bootstrap wizard's manager-triggered actions" → manager- and superadmin-triggered actions: request completion, Sync fix application, stake creation; the bootstrap wizard no longer calls one); §5.3 Audit Log (date-filter wording tightened to note day boundaries compute in `stake.timezone`); §10 Bootstrap (Complete Setup rewritten — `setup_complete=true` flip + `auditTrigger` fan + redirect, no callable).
- `docs/architecture.md` — added **D20** recording the stake-tz filter alignment and the `installScheduledJobs` retirement; supersedes D19's survival clause.
- `docs/firebase-schema.md` — `timezone` stake-field comment reworded: consumed only by stake-local rendering (Audit Log display + filter, superadmin stake-list `created_at`), not a scheduler input. (The §7 Cloud Functions inventory never listed `installScheduledJobs`, so no removal was needed there.)
- `docs/TASKS.md` — T-26 SA-hardening list drops `installScheduledJobs` (deleted, nothing to pin) from both the function roster and the pre-req role-needs note.

## What didn't change that you'd expect to

- **`firebase-schema.md` §7 needed no edit for the function removal.** The inventory table never carried `installScheduledJobs` — it predates that callable and lists the audited-trigger + claim-sync + request-completion functions only. The brief's "remove it from §7" was already satisfied.
- **The bootstrap wizard's steps 1-3 are unchanged.** Only the final Complete-Setup action lost its callable; the stake-config / building / ward / manager steps stand.
- **`reconcileAuditGaps` is untouched.** The single-loop scheduling pattern (one Cloud Scheduler job iterating every stake) is intact for the one remaining job — which is exactly why no per-stake install hook is needed.
- **The audit-log timestamp *display* already used `stake.timezone`.** Only the *filter* drifted to UTC; this PR aligns the filter to the display, it does not change how rows render.

## Known issues / deferred

- **Sub-millisecond skew at a DST transition.** `dayBoundaryInStakeTz` samples the zone offset at noon of the target day, so a boundary landing exactly in the absent/duplicated DST hour can be off by a fraction of a second. Accepted at v1 scale (1–2 requests/week; audit rows are seconds-granular and the filter is inclusive).
- **Historical `installScheduledJobs` references in TASKS.md** remain in resolved/snapshot task bodies (T-25 deprecated context; the 2026-05-14 App-Check security-review snapshot; a directory-listing snapshot inside another task) — preserved as historical record per the "don't rewrite resolved entries" convention. Only the live T-26 list was edited.
