# Extend audit retention to five years; pin `platformAuditLog` non-expiring

**Shipped:** 2026-08-18
**Commits:** PR #287 (`chore/t101-audit-retention`) — web `9ffef25`, infra `85813cb`, backend `4e8c9e4`, docs (this commit)

## What shipped

Audit rows now live five years instead of one, the window has a single definition, and the cross-stake platform trail is guaranteed not to expire.

Added:

- `AUDIT_TTL_MS` in `packages/shared/src/types/audit.ts` — `5 * 365 * 24 * 60 * 60 * 1000`, the only definition of the retention window. `auditTrigger`, `EmailService`'s `email_send_failed` writer, and the new backfill all read it from there. Leap days are ignored; day-level precision is irrelevant to a retention window.
- `backfillAuditTtl({stakeId})` in `functions/src/callable/backfillAuditTtl.ts` — a platform-superadmin-gated callable that restamps `ttl = timestamp + AUDIT_TTL_MS` on existing rows. Registered in `apps/web/src/features/superadmin/fixes.ts` as **Backfill audit log retention**, so it runs from the Stake List page's per-row Apply Fixes menu with no new UI code.
- `infra/runbooks/provision-firebase-projects.md` §1.6.1 (enable the `auditLog` TTL policy) and §5.4.1 (verify it landed, and that nothing else picked one up).

Changed:

- Three private `TTL_MS = 365 * 24 * 60 * 60 * 1000` literals collapsed to the one export. The copies were in `functions/src/triggers/auditTrigger.ts`, `functions/src/services/EmailService.ts`, and `functions/src/callable/createStake.ts`.
- `apps/web/src/routes/privacy.tsx` §4 — "retained for accountability purposes for 365 days" became "for five years". `LAST_UPDATED` bumped to 2026-08-18.

Removed:

- The `ttl` stamp on `platformAuditLog` rows. `createStake` no longer writes the field; `PlatformAuditLog.ttl` is optional in the shared type and in `packages/shared/src/schemas/audit.ts`.

## Why

The audit log exists to answer one question: who granted this person building access, and when. That question is routinely a multi-year one — a calling outlasts a year, and the access record should outlast the calling — so a twelve-month window fails at the log's own purpose. Cost was never on the other side. Rows carry full `before` / `after` snapshots at roughly 2 KB each; even the stale ~300–500 rows/week figure in `architecture.md` §1 is ~40 MB/year, and five years of that sits inside Firestore's 1 GiB free allowance. That estimate predates D14 anyway — with the importer gone, real volume is a fraction of it.

**The 365-day figure turned out to have a rationale after all, and it was not where anyone looked.** T-101 opened on the premise that the number had no recorded justification: no `F` or `D` decision covered retention, and the literal simply appeared in three files. That was true of the repo's decision record and false of the product. The published privacy policy had been telling members that audit records "are retained for accountability purposes for 365 days, after which they are deleted" — a commitment to the people whose names and access grants are in those rows. Extending retention was therefore a change to a published promise, made deliberately and with the operator's explicit approval, not a constant edit that happened to have a number attached.

That is most of why the three literals collapsed into one export rather than being edited three times. Three copies is exactly how a retention figure drifts out of agreement with what the app tells the people in the rows; one export, cited from `spec.md` and `architecture.md` D36, makes the coupling between the constant and the privacy page visible to whoever next considers moving it.

`platformAuditLog` went the opposite direction for the same reason retention is a purpose question rather than a storage question. It records stake creation and superadmin membership — a few rows a year, no volume argument on any side — and "how did this stake come to exist" has no expiry date. It was *already* immortal, but accidentally: `createStake` stamped a `ttl` and no TTL policy had ever been enabled on that collection group, so the field was inert. Dropping the field converts the accident into a guarantee. A future `--enable-ttl` on that collection group would now find nothing to delete against, which is a stronger property than a policy nobody happened to enable.

The backfill exists because `ttl` is computed at write time, so moving the constant reaches new rows only. It derives each row's new value from that row's own `timestamp` rather than wall-clock now — using now would push every historical row a full retention window past the date it should actually expire. It reads with a `.select('timestamp','ttl')` projection and writes through a `BulkWriter`: `auditLog` is the one unbounded collection in the schema (the other backfills iterate ≤250-doc collections), so the fat `before` / `after` maps must not land in memory and sequential awaited writes would risk the 540s ceiling.

Recorded as `architecture.md` D36. Q20, which had defaulted `platformAuditLog` to 365 days and wondered whether superadmin records warranted longer, resolves there: the answer to "longer" is "never".

## Operator step

**The backfill is not automatic.** Extending the constant changed nothing about rows already on disk. For each stake, open the Stake List page, choose **Backfill audit log retention** from that row's Apply Fixes menu, and apply. It is idempotent — skip-if-equal, so a second run reports `rows_updated: 0` — and it fans no audit rows of its own, because `auditTrigger` is registered on the entity collections and not on `auditLog`.

**It is only meaningful before ~2027-05.** Prod went live 2026-05-03, so the earliest 365-day deletions are a year after that. A run before then loses nothing. A run after then finds some rows already gone, and no backfill can bring them back.

There is also a deploy-time prerequisite that only bites a freshly provisioned project: the `auditLog` TTL policy is project configuration, not source. Nothing in `firestore/` declares it. Runbook §1.6.1 enables it; §5.4.1 proves it landed and that `auditLog` is the only collection group carrying one.

## What didn't change that you'd expect to

- **No `gcloud` change for the retention move.** The TTL policy carries no duration — it says only "delete the document once `ttl` has passed" — so the window lives entirely in the stamped value. Retention is a code change. `--expiration-offset` stays unset; a non-zero value would push deletion out by that much *on top of* the stamped value.
- **Pre-existing `platformAuditLog` rows keep their stamped `ttl`.** Clearing them was optional and deliberately skipped. Nothing reads the field, no policy enforces it, and a sweep over the platform trail to delete an inert value buys nothing.
- **`auditLog` rows are still fanned non-transactionally.** F8's trade-off and D35's retry mitigation are untouched. This change moves a number and a field; it does not revisit how the rows get written.
- **No test for expiry itself.** Firestore TTL deletion is a platform behaviour with no local equivalent — the emulator neither enforces the policy nor sweeps. `functions/tests/backfillAuditTtl.test.ts` covers the backfill against the emulator (auth gate, derivation from the row's own timestamp, the missing-`timestamp` skip, idempotence, per-stake scoping); the deletion is untested, and always was.
- **The `ttl` field name.** It reads like a duration and holds an absolute timestamp, which is Firestore's own convention for TTL fields. Renaming it would mean a migration over the one unbounded collection to fix a naming quibble.

## Spec / doc edits

- `docs/spec.md` — §3.2 `auditLog` bullet (five years, sourced to `AUDIT_TTL_MS`, plus the `platformAuditLog` non-expiry note); §5.0 `/privacy` route bullet (the published retention figure and the constant move together); §5.4 Apply Fixes (two registered fixes now, both superadmin-gated).
- `docs/architecture.md` — new D36.
- `docs/firebase-schema.md` — §3.3 (`ttl` optional, the non-expiry rule); §4.10 field comment and TTL invariant; §5.2 (the "optionally also on `platformAuditLog`" line replaced by the prohibition, plus the note that the duration is not in the policy, pointing at the runbook); §7 (`backfillAuditTtl` row, function count 26 → 27); §8.5 Q20 resolved in place.
- `docs/TASKS.md` — T-101 closed. Its body is left as written, including the premise about the missing rationale that turned out to be wrong; the closing paragraph says so.
- `infra/runbooks/provision-firebase-projects.md` — §1.6.1 and §5.4.1, written on the infra branch.

## Known issues / deferred

- **The backfill has to be remembered.** Nothing prompts for it and nothing detects that a stake still holds 365-day stamps; the only symptom would be audit rows disappearing in 2027 that were supposed to last until 2031. The window in which running it is free closes ~2027-05.
- **Nothing enforces the `platformAuditLog` prohibition mechanically.** The guarantee rests on the field being absent, which defeats a policy enabled later — but a policy enabled later against a *different* field, or against rows re-stamped by some future writer, would still delete. The rule is written in `firebase-schema.md` §3.3 / §5.2, `architecture.md` D36, and runbook §1.6.1; there is no test for it, because there is nothing in the repo that declares TTL policies to test against.
- **`rows_failed` is reported, not retried.** A row whose write fails after `BulkWriter`'s own retries is logged at ERROR with its coordinates and counted. The operator's recovery is to re-run the fix, which the skip-if-equal branch makes cheap.
