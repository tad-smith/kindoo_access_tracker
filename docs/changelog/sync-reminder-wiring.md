# Sync reminder wiring — the third of three PRs

**Shipped:** 2026-09-05
**Commits:** PR #290 (`feat/t107-sync-reminder-wiring`) — docs (open) `4dfde8b`, backend `f6ecf0a`, web `5093d52` / `9e8b300`, docs (this commit)

## What shipped

The two halves T-103 and T-104 shipped inert are now joined, and a Kindoo Manager can turn the join on without operator help.

`SCHEDULED_JOBS` (`functions/src/lib/taskRegistry.ts`) carries its first entry: `syncReminder → sendSyncReminderIfDue`, `{type:'daily', hour: 6}`, `defaultEnabled: false`. `SYNC_REMINDER_JOB` — the literal string that joins the registry key to the toggle — moved to `packages/shared/src/scheduledTasks.ts` so both sides read the same constant instead of two copies that could drift.

The Configuration page's Config tab gets a **Sync Reminder** card, below the stake-config form, visible to Kindoo Managers. It reads the stake's `syncReminder` row (`useStakeSchedule`) and renders one of three states — not yet seeded (switch disabled, "check back within the hour"), seeded and off, seeded and on with a "Next check" time. The switch calls `useSetSyncReminderEnabledMutation`, a transacted read-modify-write over `stakeSchedules/{stakeId}.tasks` that changes `enabled` on the `syncReminder` row alone. It never creates the row.

Registering the job exposed a pre-existing bug in the dispatcher's stamp write, and this PR fixes it rather than filing it. `dispatchDue` used to read the schedule doc once, mutate the in-memory `tasks` array over the whole per-stake pass, and write the whole array back at the end; a manager's `enabled` write landing inside that window was silently reverted. `commitScheduleChanges` now performs the stamp write inside `db.runTransaction`, re-reading the document and re-applying only that pass's computed stamps and newly seeded rows onto the array as it stands at commit time. Enqueue stays outside and before the transaction, unconditional, so delivery is still at-least-once.

## Why

D37 and D38 each shipped a piece nothing exercised, on the same explicit trade: land it reviewable, accept that code nothing runs rots, and let a follow-up PR finish the join. This is that PR for both.

Registering the job in the registry was mechanical once the dispatcher existed. The harder call was whether a manager could flip it on without an operator's Firestore console access. The answer was yes, but only once the clobber race was fixed — a self-service toggle sitting on top of a write that could silently lose a concurrent update would read to a manager as "I turned it on and it turned itself back off" (or the reverse), with no diagnostic short of reading server logs. The toggle exposed the bug rather than caused it: the race existed the moment T-104 shipped a manager-writable document a dispatcher also rewrote, but it was invisible with no client ever writing to the row. It is fixed here rather than filed and deferred, because the toggle this PR ships is what makes it observable — shipping the toggle without the fix would have shipped a control that intermittently discards its own input.

Two stake-level switches now bear on the same mail, and the card is explicit that they don't do the same thing. `notifications_enabled` is email-only — it always has been, spec.md §9 already said so — but T-107 is the first surface where flipping it interacts with something a manager can watch. Graying the Sync Reminder switch out under the kill-switch was considered and rejected: the switch is not inert there. Push still reaches subscribers of `notificationPrefs.push.syncReminder`, and the three-day backoff stamp is still consumed whether or not the email actually sent. Disabling the control would assert something false about what it does, so the card warns beside a live switch instead.

Daily rather than weekly for the check cadence, keeping T-107's own registry entry in line with D37's rationale: the handler's `SYNC_REMINDER_BACKOFF_DAYS = 3` is what actually paces mail, so a daily check just keeps a brand-new expiry from waiting up to a week for its first nudge. A weekly check would reintroduce exactly the delay the reminder exists to remove.

Stamp-last was reconsidered and kept, deliberately, not left alone by oversight. Delivery is at-least-once, so `sendSyncReminderIfDue` reading its backoff stamp before sending and writing it after means two overlapping executions can both mail. Claiming the stamp first would trade that rare duplicate for up to three days of silence about seats that are actively expired — the worse failure, against a mail whose one instruction ("run Sync") costs nothing to repeat.

## What didn't change that you'd expect to

- **Stamp-last.** `sendSyncReminderIfDue` still reads its backoff stamp before sending and writes it after. See "Why" above — this is a decision reconsidered and kept, not an oversight.
- **Delivery is still at-least-once.** Enqueue still happens before the stamp in `dispatchDue`; the transaction wraps only the stamp/seed write, not the enqueue. Every handler still has to be idempotent within its own window.
- **`defaultEnabled: false`.** The registry entry seeds the same as every job would — off. A stake gets the row on its next hourly dispatch pass; nothing sends until a manager flips it.
- **Seeding still only ever adds.** `seedMissingTasks` is untouched. An existing row is never re-enabled, re-scheduled, or pruned by a deploy.
- **`SyncReminderService.ts` itself.** Same signature, same five-status return (`stake-missing`, `setup-incomplete`, `nothing-expired`, `backed-off`, `no-managers`), same selection narrowed by `syncWillClearSeat`, same separate push opt-in. Only the caller changed.
- **No new Cloud Function, no new queue, no new Cloud Scheduler job.** This PR is entirely inside the shape D38 built — one registry entry and one UI surface.
- **T-105 (multi-grant seats) is still open.** Nothing here changes what the reminder selects.
- **T-106 (no-Sync-in-seven-days reminder) is unaffected**, still pending on the extension-side heartbeat.

## Spec / doc edits

- `docs/spec.md` — §17 gains the registered job, the manager toggle and its role gate, the two-switches interaction, and the transactional stamp fix; §9 drops "not yet dispatched" / "nothing calls it yet" language throughout.
- `docs/architecture.md` — new **D39**, with in-place `[Amended 2026-09-05, D39]` annotations on D38(f)'s "no manager UI" clause and D37's "still has no caller" clause, following the annotation convention D38 itself used on D35/D37.
- `docs/firebase-schema.md` — §1 overview bullet, §3.5's Written-by / Read-by lines, and §7's `dispatchScheduledTasks` row and sync-reminder paragraph.
- `docs/TASKS.md` / `docs/TASKS-archive.md` — T-107 closed and moved to the archive.
- `CLAUDE.md` — #288 and #289 bullets corrected (both said the reminder was uncalled / the dispatcher scheduled nothing); new #290 bullet added.

## Known issues / deferred

- **No manager UI for `schedule` or the timestamps.** The rules still permit a Kindoo Manager to write any field in the envelope; only `enabled` has a client control. Editing `schedule` — moving the check hour, say — is still a Firestore console edit.
- **T-105** — expired grants on multi-grant seats still have no proactive signal. Unaffected by this PR.
- **Cloud Scheduler's free tier is still fully spent** (D38) — this PR adds no scheduled job, so that headline is unchanged.
