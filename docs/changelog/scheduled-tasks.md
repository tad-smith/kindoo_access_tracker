# Per-stake scheduled tasks — one dispatcher, many jobs

**Shipped:** 2026-09-05
**Commits:** PR #289 (`feat/t104-scheduled-tasks`) — design `e4aba86`, backend `92a0b3a` / `4c6fd13`, infra `0105c45` / `73df9ec` / `0d710dd` / `c6075b6`, docs (this commit)

## What shipped

The system's one cron, and nothing that uses it. An hourly Cloud Function walks every stake, finds the jobs whose slot has arrived, and enqueues one Cloud Tasks task per (stake, job); a single generic runner picks each task up and calls the handler. Adding a scheduled feature from here is one entry in a registry.

**The registry ships empty.** `SCHEDULED_JOBS` in `functions/src/lib/taskRegistry.ts` is `{}`. The dispatcher deploys, runs on the hour, walks the stakes, seeds nothing, enqueues nothing, and writes nothing. `runScheduledTask` is never invoked. `sendSyncReminderIfDue` is still code nothing runs. **No user-visible behaviour changed in this PR, and no email or push can be sent by it.**

Added:

- `functions/src/scheduled/dispatchScheduledTasks.ts` — `onSchedule`, cron `0 * * * *`, `Etc/UTC`, `256MiB`, pinned to `APP_SA`. `dispatchDue(db, {registry, enqueue, now})` is the whole body with the moving parts injected, so it is testable without Cloud Scheduler or Cloud Tasks. Also exports `scheduledTaskId`, `TASK_RUNNER_NAME`, `DISPATCHER_ACTOR`, and `DISPATCH_DONE_MESSAGE`.
- `functions/src/tasks/runScheduledTask.ts` — `onTaskDispatched`, `maxAttempts: 3`, pinned to `APP_SA`. Resolves `{stakeId, job}` against the registry and calls the handler with `(stakeId, now)`.
- `functions/src/lib/taskRegistry.ts` — the extension point: job name → `{handler, defaultSchedule, defaultEnabled}`. Empty.
- `packages/shared/src/scheduledTasks.ts` — `TaskSchedule` / `ScheduledTask` / `StakeSchedule`, plus `advanceTriggerTime`, `nextTriggerTime`, `isTaskDue`, `MAX_SCHEDULE_ADVANCES`. `Intl` only, so `@kindoo/shared` stays runtime-dep-free. New calendar helpers in `packages/shared/src/stakeTime.ts` (`addIsoDays`, `isoDateWeekday`, `wallClockInStakeTz`, `toDate`) back it.
- A top-level `stakeSchedules/{stakeId}` rules block, and `firestore/tests/stakeSchedules.test.ts` covering it.
- A `tasks` emulator port in `firebase.json`.
- Operational surface: `infra/monitoring/metrics/scheduled-dispatch-completed.yaml` and `scheduled-task-failures.yaml`, the "First deploy after T-104" walkthrough in `infra/runbooks/deploy.md`, and the `onSchedule` / `onTaskDispatched` probe classification in `infra/scripts/lib/verify-deploy.sh`.

Changed:

- `keysAreExactly` moved out of the `remoteApply` block in `firestore/firestore.rules` into the shared helpers, so the new top-level block could reach it. The only edit this PR makes to an existing rules path.
- Deployed function count 27 → 29.

## Why

The per-feature cost of a scheduled feature was the problem, not the absence of a scheduler. Cloud Scheduler's free tier is three jobs **per billing account**, and this stack spends two on any single job because staging and prod each get a copy. So `onSchedule`-per-feature does not survive the second feature — which is exactly why D37 merged the sync reminder with no trigger at all rather than paying a slot for it. Moving the cost into a row of an array makes the second, third and fourth scheduled features free. The hourly wake is what lets a per-stake timezone matter without a job per zone.

That is also why there is one generic `onTaskDispatched` rather than one per job. T-104's own first shape was a function per handler, which removes the Scheduler cost and reintroduces the identical per-feature cost in deploy shape and queues. The generic runner is the point of the design, not a tidy-up.

Four smaller decisions are load-bearing, and all four are in `architecture.md` D38 with their alternatives:

- **Top-level, unaudited storage.** A sub-collection under `stakes/{stakeId}` would sit inside the slice `auditTrigger.registration.test.ts` derives the audited set from, forcing an audit trigger onto a document the dispatcher rewrites hourly. The array on the stake parent doc would fan an `auditStakeWrites` row every stamp, and the `BOOKKEEPING_FIELDS` escape would also silence a manager toggling `enabled` — the one write here worth auditing. Top level dodges both, at the accepted cost that **writes to `stakeSchedules` are not audited at all**.
- **Managers can write the timing fields.** Rules cannot see inside array elements, so `isManager(stakeId)` covers `next_trigger_time` as much as `enabled` however the document is split. Splitting config from state to fix that buys machinery for a worst case of a manager making their own stake's own job fire early, at most once an hour, against a handler that has to be idempotent regardless.
- **`nextTriggerTime` advances from the stored value, never from `now`.** Drift is prevented by the slots themselves: Every shape's slots are anchored to a wall-clock boundary — `hourly` to the top of the hour, the other three to their configured hour — so no trigger can inherit the second at which some dispatch happened to run. `hourly` shipped adding an hour to whatever instant it was handed, which inherited the dispatcher's own start second and silently skipped a run whenever one dispatch started earlier in the hour than the last; caught in review and fixed to snap.
- **Enqueue first, stamp second.** The reverse order loses a fire silently whenever the process dies between the two. A lost fire is invisible; a double run is not. So dispatch is **at-least-once** and every handler must be idempotent within its own window — the deterministic task id per (stake, job, UTC hour) and each handler's own guard narrow that gap without closing it.

Seeding belongs to the dispatcher and every job seeds **disabled**. That replaces T-104's original `createStake`-seeds-plus-backfill plan with one code path that covers a brand-new stake and a newly shipped job alike, and it means a job that appears on a stake by seeding cannot start acting on that stake's behalf before a human turns it on. With no manager UI, that flip is a Firestore console edit.

## What didn't change that you'd expect to

- **The sync reminder still has no caller.** `sendSyncReminderIfDue` is not exported from `functions/src/index.ts`, nothing wraps it, and it is registered as no job. What changed is only the *reason*: before this PR there was no dispatcher; now there is one and its registry is empty. `spec.md` §9's "Nothing calls it yet" and `firebase-schema.md` §7's "still has no caller" are both still true statements about the deployed system.
- **No email, push, or Firestore write results from a dispatcher run** while the registry is empty. A run reads `stakes`, reads each `stakeSchedules` doc, finds nothing to seed and nothing due, and writes nothing.
- **No manager UI.** There is no surface anywhere in the SPA that reads or writes `stakeSchedules`. Read access exists in the rules so a member can see the document; nothing renders it. Enabling a job is a console edit, deliberately (D38(f)).
- **`createStake` seeds nothing.** A new stake gets its rows from the dispatcher's next hourly pass, which is the same path that covers a stake created before a job existed. The bootstrap wizard still installs nothing at setup time (`spec.md` §10).
- **No index on `stakeSchedules`.** The dispatcher addresses each document by id inside a loop over `stakes`; nothing queries the collection. The `collectionGroup`-on-a-hoisted-minimum option T-104 sketched — zero reads on a quiet hour — was not built. At the 1–2 stake target scale the reads it saves are a rounding error against the machinery it adds.
- **`stakes` is still read in full each hour.** One `.get()` on the collection plus one doc read per stake. At target scale that is a handful of reads an hour; there is no pagination, no cursor, and no "stakes with work" query.
- **The weekly Firestore export is untouched.** Still prod-only, still an operator-created Cloud Scheduler job against the Firestore admin API, still not a Function.
- **D35's audit-fan-in half stands entirely.** `retry: true` on the nine triggers, the one-code-wide permanent-failure carve-out, and the registration test are all unchanged. The only clause of D35 this amends is the count of scheduled functions.

## Not proven locally

Three things in this change have no local equivalent, and the green suite says nothing about any of them. All three are first exercised on staging.

- **Cloud Scheduler actually firing the dispatcher.** The cron string and timezone are asserted on the deploy manifest, which is the artifact `firebase-tools` reads; that the platform then invokes the function on the hour is not testable here.
- **Real Cloud Tasks id dedupe.** The unit tests use a fake enqueuer and the integration tests stub it, so the `functions/task-already-exists` path is exercised against a thrown fake, not against the service. That Cloud Tasks holds a used id for roughly an hour after execution — the property the whole (stake, job, hour) id scheme rests on — is a platform contract, not something this repo verifies.
- **The queue's OIDC auth into `runScheduledTask`.** The runner is `onTaskDispatched`, so the queue calls it with an OIDC token for `kindoo-app@`. Nothing local stands that up.

**Two IAM bindings must be granted by hand, per project.** `firebase deploy` grants neither, nothing fails at deploy time, and the failure mode is a runtime `PERMISSION_DENIED` on every hourly dispatch:

- `roles/cloudtasks.enqueuer` on the `runScheduledTask` queue, member `kindoo-app@<project>`. `firebase-tools`' `upsertTaskQueue` calls `setEnqueuer` only when the endpoint declares an explicit `invoker`, and a plain `onTaskDispatched` declares none — so the queue is created with no principal permitted to enqueue onto it.
- `roles/iam.serviceAccountUser` on `kindoo-app@<project>` **on itself**. Creating an HTTP-target task with an `OidcToken` requires `iam.serviceAccounts.actAs` on the service account the token names. This is a **second, distinct self-binding**; it does not replace D33's `roles/iam.serviceAccountTokenCreator`, which carries signing permissions and not `actAs`. Both must be present, and T-26's IAM tidy-up must not revoke either.

Commands and verification steps: `infra/runbooks/deploy.md`, "First deploy after T-104".

## Spec / doc edits

- `docs/spec.md` — §2 Database bullet (three top-level collections → five: the list had already omitted `remoteApply` before this PR, so that pre-existing drift is fixed here too), Server-compute bullet, and Scheduling bullet (rewritten: one scheduled function, and it is a dispatcher whose registry is empty); §3.1 gains `stakeSchedules`; §7's expired-seat paragraph and §9's "Nothing calls it yet" now say *why* the reminder is uncalled; §10 Bootstrap (the "no scheduled jobs" premise replaced — a single-loop job needs no per-stake install); new **§17 Scheduled tasks**.
- `docs/architecture.md` — new **D38**. D35 and D37 each carry an in-place `[Amended 2026-09-05, D38]` annotation on their "zero scheduled Cloud Functions" clauses; both original texts are otherwise untouched, per the convention D35 itself used on D19/D20.
- `docs/firebase-schema.md` — §1 overview bullet; new **§3.5 `stakeSchedules/{stakeId}`** (shape, writers, rules, and the unaudited-by-design decision); §6's embedded rules copy (helper hoisted, new block); §7 gains two rows, the count goes 27 → 29, the "None is scheduled" clause is replaced, and the sync-reminder paragraph is rewritten around the empty registry.
- `CLAUDE.md` — the T-102 bullet is re-headlined and its "zero scheduled Cloud Functions" claim marked as no longer true, keeping the T-102 trail intact; new T-104 bullet; the T-103 bullet now points at the empty registry rather than at a pending dispatcher.
- `docs/TASKS.md` — T-104 closed with the empty-registry fact stated plainly; T-106 notes that its trigger path now exists.
- `functions/CLAUDE.md`, `infra/runbooks/*`, `infra/monitoring/*`, `.claude/agents/infra-engineer.md` — updated on the code branches by their owning agents.

## Known issues / deferred

- **The whole system is inert until a job is registered.** That is this PR's shape, not a defect — but it means the dispatcher is code nothing exercises, the same debt D37 took on with the sync reminder. Registering `sendSyncReminderIfDue` as `syncReminder` is the next PR.
- **Neither new metric has an alert routed to it.** `scheduled-dispatch-completed` alerts on the *absence* of `dispatchScheduledTasks: done`, which is the only way to detect a run where every stake failed, since the dispatcher swallows per-stake failures and still exits 0. It joins `audit-row-dropped` and `audit-trigger-failures` under "Not yet wired" in `infra/runbooks/observability.md`.
- **`DISPATCH_DONE_MESSAGE` is a cross-repo coupling.** The constant is exported and pinned by a test because the metric matches the literal string. Reword it and the metric silently reads zero, which is indistinguishable from the outage it detects. Change both sides together.
- **The overlap hazard T-103 inherited is narrowed, not closed.** Two invocations for the same stake overlapping in time both read a pre-write backoff stamp. The deterministic task id makes a same-hour double enqueue a no-op, which covers the common case; it does not serialise a retry landing on top of a still-running attempt. A lease is the remedy if it ever matters.
- **Cloud Scheduler's free tier is now fully spent** — staging dispatcher, prod dispatcher, prod weekly export, 3 of 3 on a per-billing-account limit. A future scheduled feature that reaches for a fourth job is the mistake this design exists to prevent.
- **[T-105] is unaffected.** Expired temp grants on multi-grant seats still have no reaper and no reminder, and nothing here changes that.
