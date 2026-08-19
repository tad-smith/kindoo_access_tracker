# Remove audit-gap reconciliation; retry the audit triggers instead

**Shipped:** 2026-08-18
**Commits:** PR #286 (`chore/t102-audit-retries`) — backend `dd14b86` / `9ffd7a8` / `3efafb1` / `4c9041f`, infra `e08af8b` / `a02eb74`, docs (this commit)

## What shipped

The nightly audit-gap reconciliation job is gone, and the failure it was supposed to compensate for is now handled at the source: the nine audit triggers retry.

Deleted:

- `reconcileAuditGaps` and `functions/src/scheduled/` — the only file in that directory, so the directory goes with it. Its export leaves `functions/src/index.ts`, its `verify-deploy` scheduled-function classification block leaves `infra/scripts/tests/verify-deploy.test.sh`, and it drops out of the enumerations in `infra/runbooks/provision-firebase-projects.md`.
- **SBA now runs zero scheduled Cloud Functions.** The prod-only weekly Firestore export survives, but it is an operator-created Cloud Scheduler job hitting the Firestore admin API — not a Function, and nothing in this repo deploys it.

Added:

- `{ document, retry: true }` on all nine `onDocumentWritten` registrations in `functions/src/triggers/auditTrigger.ts`. Inline options objects, no helper, matching the file's explicit-repetition idiom.
- `isPermanentAuditWriteError` plus a try/catch around the final `set()` in `emitAuditRow`. A gRPC `INVALID_ARGUMENT` (code 3) is logged at ERROR with the row's coordinates and dropped; everything else rethrows.
- `functions/src/triggers/auditTrigger.registration.test.ts` — derives the audited-collection set from `firestore/firestore.rules` and set-compares it against the nine exports' deploy manifests, asserting `retry === true` on each. Second block covers the classifier table and the drop path against a fake `Firestore`.
- `infra/monitoring/metrics/audit-row-dropped.yaml`, and a rewrite of `audit-trigger-failures.yaml`.

Kept and unchanged:

- **What the nine triggers do.** Action resolution, actor resolution, the out-of-band sentinel, the no-op-update skip, `entity_id` overrides for the stake-bucketed collections, the 365-day `ttl` stamp — all untouched. The only change to `emitAuditRow` is the try/catch around its last line and an injectable `db` parameter for the drop-path test.
- **`auditId` determinism.** It was already `(writeTime, collection_docId)` and the write was already a `set()`. That is what made retries safe to switch on rather than something to build.
- **`verify-deploy`'s export-count floor.** It is a `>= 10` sanity check against the live `functions/src/index.ts`; one export fewer clears it with room. What did go was the scheduled-function misclassification block, which asserted the job's name was absent from the callables list and so passes vacuously once the job is gone; the `auditAccessWrites` trigger-misclassification check above it keeps the guard shape.

## Why

F8 chose trigger-based audit — the audit row is a separate, non-transactional write fanned after the entity write — and paid for that choice with one compensating control: "nightly reconciliation job catches any gaps." The control did not work. `reconcileAuditGaps` compared `totalEntities` (docs existing right now) against `auditCount` (audit rows existing right now, all time) and warned when they differed by more than 1%. There is no time window in it and no per-document lookup. The two quantities line up only on a brand-new stake; after any history the cumulative row count runs past the entity count, the gap clamps to zero, and the check reads permanently green whether or not `auditTrigger` is still firing. In the other direction the audit TTL eventually sheds rows from a quiet stake and trips the gate nightly for nothing. When it did fire it named a stake and a percentage, which is why Q14's alerting channel was never definable — there was nothing to act on.

Meanwhile the failure F8 actually worried about was unmitigated. 2nd-gen event functions do not retry by default, and all nine registrations used the bare `onDocumentWritten(path, handler)` form, so a failed audit write — after the entity write had already committed — simply dropped the event. Turning retries on moves the mitigation from after-the-fact detection to prevention: Eventarc redelivers with exponential backoff for up to 24 hours. Recorded as `architecture.md` D35, which also supersedes D19's and D20's "SBA runs exactly one scheduled job" framing.

The 24-hour window is what forces the one carve-out. A row Firestore will reject identically on every attempt would otherwise occupy the whole window to land nowhere, so `isPermanentAuditWriteError` classifies gRPC code 3 and `emitAuditRow` logs and drops. It stays exactly one code wide on purpose: `PERMISSION_DENIED` rethrows, because the Admin SDK bypasses rules and a 7 can therefore only mean SA/IAM misconfiguration — operator-fixable inside the window, and retrying turns an ops mistake into late rows rather than permanent loss.

Retries cannot see everything. They act on a *failed* invocation, so an invocation that succeeds without writing is invisible to them, and a collection with no trigger registered at all is invisible twice over. That is what the new registration test covers, and it is the one thing in this change the deleted job structurally never could have caught: omitting a collection *lowered* `totalEntities` and biased the check toward green.

## What didn't change that you'd expect to

- **Audit rows are still non-transactional with the entity write.** Retries narrow the window in which a row can be lost; they do not close it, and F8's underlying trade-off stands. Option B (embedded history with `getAfter()`) was not reopened.
- **The no-op-write skip stays.** `isNoOpUpdate` still returns before the write for bookkeeping-only diffs, and those invocations still succeed without writing a row. That is intended behaviour, not a gap — but it is why the registration test exists rather than a runtime check.
- **No `serviceAccount` on the nine registrations.** Adding an options object to all nine is the moment pinning them to `kindoo-app@` would cost nothing extra, and it was deliberately not taken: that is T-26's call and its IAM review, not a rider here.
- **No emulator test for either retry or the oversize path.** Redelivery is an Eventarc platform contract with no local equivalent, and the emulator does not reliably enforce the 1 MiB document limit. The classifier and the drop path are unit-tested against a fake `Firestore`; the retry flag is asserted on the deploy manifest, which is the same artifact `firebase-tools` reads. Stated in the trigger file's section comment so nobody goes looking for the missing integration test.
- **The Phase 8 plan body in `firebase-migration.md` still describes the job.** It already sits under a `[SUPERSEDED — in part]` banner and is retained as the historical record of what Phase 8 shipped, per convention. Same for D19, D20, and the changelogs that named the job as the last survivor.

## Spec / doc edits

- `docs/spec.md` — §2 Server-compute bullet (dropped the reconciliation clause) and Scheduling bullet (rewritten: no scheduled Functions; the weekly export is an operator-level Scheduler job); §10 Bootstrap (nothing to install at setup time); §11 Concurrency (the retry contract and the permanent-drop carve-out replace the "safety net" sentence).
- `docs/architecture.md` — new D35.
- `docs/firebase-schema.md` — §1 overview bullet; §4.11 / §4.12 invariants (dropped "reconciled by the nightly job"); §7 inventory (job row deleted, `auditTrigger` row notes retries and the drop, count sentence corrected); §7 PR #224 organizations delta annotated; §8.4 Q14 and §8.5 Q21 amended in place.
- `docs/firebase-migration.md` — F8's Decision cell carries an in-place `[Corrected 2026-08-18]` annotation on its "nightly reconciliation" clause.
- `docs/TASKS.md` — T-102 closed; T-101's "Side effect worth having" paragraph marked moot.
- `functions/CLAUDE.md` and `infra/runbooks/*` — updated on the code branches by their owning agents.

## Known issues / deferred

- **Neither monitoring metric has an alert routed to it.** `audit-row-dropped` is now the only signal that an audit row was permanently lost, and a lost row cannot be reconstructed — so `count > 0` is the highest-value alert on the list. It and `audit-trigger-failures` sit under "Not yet wired" in `infra/runbooks/observability.md`. Until one is wired, detection depends on someone reading logs.
- **Truncated-row fallback, deliberately not built.** On a code-3 rejection `emitAuditRow` could write a row whose `before` / `after` are replaced by a `{ _truncated: true }` marker instead of dropping the row entirely — the audit *fact* (who, what, when, which entity, which action) survives even when the payload cannot be persisted, which is strictly better than a log line nobody reads. Left out of this PR to keep the change to one behaviour: the retry opt-in and the guard that makes it safe. Worth doing if `audit-row-dropped` ever counts above zero, and worth doing before it does if the 1500-byte index-entry limit turns out to fire on ordinary data.
- **Q14's need is transferred, not closed.** The question as posed is obsolete — no job, and retries prevent the failure it was meant to detect — but the alerting channel it asked for is still undefined, now pointing at `audit-row-dropped` instead of at a nightly sweep. The amendment in `firebase-schema.md` §8.4 says so rather than marking it resolved.
- **First deploy to each project prompts to delete `reconcileAuditGaps`.** Answer yes; deleting the function also deletes its Cloud Scheduler job, which is what actually frees the two slots (it deployed to staging and prod alike). Procedure in `infra/runbooks/deploy.md`.
