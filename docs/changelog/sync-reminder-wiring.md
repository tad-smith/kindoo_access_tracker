# Sync reminder wiring — the third of three PRs

**Shipped:** 2026-09-06
**Commits:** PR #290 (`feat/t107-sync-reminder-wiring`) — docs (open) `4dfde8b`, backend `f6ecf0a`, web (original card) `5093d52` / `9e8b300`, docs (first pass) `798b46b` / `4caac97`, web (slider-stack rework) `a7d7984`, backend (secret mount) `cc687f4`, docs (this correction)

## What shipped

The two halves T-103 and T-104 shipped inert are now joined, and a Kindoo Manager can turn the join on without operator help.

`SCHEDULED_JOBS` (`functions/src/lib/taskRegistry.ts`) carries its first entry: `syncReminder → sendSyncReminderIfDue`, `{type:'daily', hour: 6}`, `defaultEnabled: false`. `SYNC_REMINDER_JOB` — the literal string that joins the registry key to the toggle — moved to `packages/shared/src/scheduledTasks.ts` so both sides read the same constant instead of two copies that could drift.

**The Config tab's UI shipped twice.** The first cut added a standalone **Sync Reminder** card below the stake-config form, with its own prose, its own first-run hint, and a warning box beside a live switch when `notifications_enabled` was off. Before merge it was reworked into a three-row slider stack below `Save config`, separated by a rule: **Email Notifications Enabled**, then **Sync reminders** indented beneath it as a sub-row, then **EQ Presidents Have SBA Access**. `notifications_enabled` and `eq_president_app_access` left the react-hook-form entirely — each now writes the instant it flips, through `useSetStakeToggleMutation`, one field per call, so `Save config` covers only the three typed form fields (stake name, seat cap, timezone) that remain in it. Every explanatory paragraph moved into a click/tap-triggered `InfoTip` (`apps/web/src/components/ui/InfoTip.tsx`, Popover-backed) beside its row, because a hover tooltip is unreachable from the phone and iPad most managers use this page from. The Sync reminders row now greys out and disables — rather than staying live with a warning beside it — whenever its parent (Email Notifications Enabled) is off or the row is unseeded; the reminder still honours its own `enabled` value regardless of the parent switch, which the interface no longer explains — the tips were trimmed to one paragraph each. The row's first-run copy, which had asserted the first check always lands within the hour, is gone rather than corrected: on rollout a stake is seeded with `next_trigger_time` at the next local 06:00, so enabling that afternoon runs the first check tomorrow morning. The behaviour is documented in `spec.md` §17; the interface states neither case.

The switch still calls `useSetSyncReminderEnabledMutation`, a transacted read-modify-write over `stakeSchedules/{stakeId}.tasks` that changes `enabled` on the `syncReminder` row alone. It never creates the row.

Registering the job exposed a pre-existing bug in the dispatcher's stamp write, and this PR fixes it rather than filing it. `dispatchDue` used to read the schedule doc once, mutate the in-memory `tasks` array over the whole per-stake pass, and write the whole array back at the end; a manager's `enabled` write landing inside that window was silently reverted. `commitScheduleChanges` now performs the stamp write inside `db.runTransaction`, re-reading the document and re-applying only that pass's computed stamps and newly seeded rows onto the array as it stands at commit time. Enqueue stays outside and before the transaction, unconditional, so delivery is still at-least-once.

**Registering the job also exposed a silent send failure, fixed in a follow-up commit on this same PR.** `sendSyncReminderIfDue` now runs inside `runScheduledTask`, but that function declared no secrets — Cloud Functions mounts a secret only onto the function that names it, and nothing about the generic task worker's own code sends email. `process.env.RESEND_API_KEY` was therefore unset at runtime: `getClient()` threw inside `sendOne`, `sendOne` wrote an `email_send_failed` audit row without rethrowing, and `sendSyncReminderIfDue` still returned `status: 'sent'` and still consumed the three-day backoff. Net effect: no reminder email ever sent, silently, and the backoff hid the gap for three more days each time it ran. Fixed by adding `secrets: [RESEND_API_KEY]` to `runScheduledTask`'s options — the same binding the three notify triggers already carry — plus a registration test asserting the key appears in `__endpoint.secretEnvironmentVariables`, since this is a runtime-only failure with no other local check.

## Why

D37 and D38 each shipped a piece nothing exercised, on the same explicit trade: land it reviewable, accept that code nothing runs rots, and let a follow-up PR finish the join. This is that PR for both.

Registering the job in the registry was mechanical once the dispatcher existed. The harder call was whether a manager could flip it on without an operator's Firestore console access. The answer was yes, but only once the clobber race was fixed — a self-service toggle sitting on top of a write that could silently lose a concurrent update would read to a manager as "I turned it on and it turned itself back off" (or the reverse), with no diagnostic short of reading server logs. The toggle exposed the bug rather than caused it: the race existed the moment T-104 shipped a manager-writable document a dispatcher also rewrote, but it was invisible with no client ever writing to the row. It is fixed here rather than filed and deferred, because the toggle this PR ships is what makes it observable — shipping the toggle without the fix would have shipped a control that intermittently discards its own input.

Two stake-level switches now bear on the same mail, and the row is explicit that they don't do the same thing. `notifications_enabled` is email-only — it always has been, spec.md §9 already said so — but T-107 is the first surface where flipping it interacts with something a manager can watch. **The first cut left the Sync reminders switch live with a warning beside it, reasoning that the switch is not inert under the kill-switch and disabling it would assert otherwise.** That shipped less legible in review: the row sits visually nested under Email Notifications Enabled specifically to say "the parent gates the child," so a switch that stayed clickable while its parent was off contradicted its own layout. The shipped version greys and disables the row instead. The "not inert" fact briefly lived in the `InfoTip`, but the tips were then trimmed to one paragraph each as too verbose for novice users, so it is recorded in `spec.md` §17 and `architecture.md` D39 and nowhere in the interface. Push still reaches subscribers of `notificationPrefs.push.syncReminder`, and the three-day backoff stamp is still consumed whether or not the email actually sent.

Daily rather than weekly for the check cadence, keeping T-107's own registry entry in line with D37's rationale: the handler's `SYNC_REMINDER_BACKOFF_DAYS = 3` is what actually paces mail, so a daily check just keeps a brand-new expiry from waiting up to a week for its first nudge. A weekly check would reintroduce exactly the delay the reminder exists to remove.

Stamp-last was reconsidered and kept, deliberately, not left alone by oversight. Delivery is at-least-once, so `sendSyncReminderIfDue` reading its backoff stamp before sending and writing it after means two overlapping executions can both mail. Claiming the stamp first would trade that rare duplicate for up to three days of silence about seats that are actively expired — the worse failure, against a mail whose one instruction ("run Sync") costs nothing to repeat.

## What didn't change that you'd expect to

- **The backend registration, the clobber-race fix, and the stamp-last decision.** All three shipped as described in the first pass and were untouched by the UI rework.
- **Stamp-last.** `sendSyncReminderIfDue` still reads its backoff stamp before sending and writes it after. See "Why" above — this is a decision reconsidered and kept, not an oversight.
- **Delivery is still at-least-once.** Enqueue still happens before the stamp in `dispatchDue`; the transaction wraps only the stamp/seed write, not the enqueue. Every handler still has to be idempotent within its own window.
- **`defaultEnabled: false`.** The registry entry seeds the same as every job would — off. A stake gets the row on its next hourly dispatch pass; nothing sends until a manager flips it.
- **Seeding still only ever adds.** `seedMissingTasks` is untouched. An existing row is never re-enabled, re-scheduled, or pruned by a deploy.
- **`SyncReminderService.ts` itself.** Same signature, same five-status return (`stake-missing`, `setup-incomplete`, `nothing-expired`, `backed-off`, `no-managers`), same selection narrowed by `syncWillClearSeat`, same separate push opt-in. Only the caller and its secret binding changed. **[Renamed 2026-09-06, T-106]** `nothing-expired` is now `nothing-due` — T-106 added a second, independent condition (a Kindoo site nobody has synced in seven days) to the same handler, and a stake with nothing expired but a stale site is not "nothing to do." This line is left as it was written, describing what was true on 2026-09-05; see `docs/changelog/sync-reminder-heartbeat.md` and `architecture.md` D40.
- **No new Cloud Function, no new queue, no new Cloud Scheduler job.** This PR is entirely inside the shape D38 built — one registry entry, its secret binding, and one UI surface.
- **T-105 (multi-grant seats) is still open.** Nothing here changes what the reminder selects.
- **T-106 (no-Sync-in-seven-days reminder) is unaffected**, still pending on the extension-side heartbeat.

## Spec / doc edits

- `docs/spec.md` — §17's "Turning a job on" rewritten for the slider-stack shape (nesting, disable rule, `InfoTip`-carries-the-prose, the conditional first-run copy); §9 points at the **Sync reminders** slider instead of a card.
- `docs/architecture.md` — **D39** amended in place: (b) rewritten for the slider stack, (c) rewritten for the grey-and-disable behaviour (still not a pause), (d) rewritten to state both first-run cases, new (g) for the `RESEND_API_KEY` binding. Not renumbered.
- `docs/firebase-schema.md` — §3.5's Read-by line, §7's `syncReminder` paragraph and the `runScheduledTask` row (new secret binding).
- `docs/TASKS-archive.md` — T-107's closing paragraph corrected to the shipped surface.
- `CLAUDE.md` — #290 bullet corrected to the shipped surface.

## Known issues / deferred

- **No manager UI for `schedule` or the timestamps.** The rules still permit a Kindoo Manager to write any field in the envelope; only `enabled` has a client control. Editing `schedule` — moving the check hour, say — is still a Firestore console edit.
- **T-105** — expired grants on multi-grant seats still have no proactive signal. Unaffected by this PR.
- **Cloud Scheduler's free tier is still fully spent** (D38) — this PR adds no scheduled job, so that headline is unchanged.
