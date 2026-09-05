# Sync reminder for expired temp seats — shipped without a trigger

**Shipped:** 2026-09-04
**Commits:** PR #288 (`feat/t103-sync-reminders`) — shared/push extraction `fad4ff7`, push toggle `54c57b8`, service `0f2ca19`, backoff `fed23ac`, review `16ca06f`, narrowing `ae86bf8`, fold `9e91534`, docs (this commit)

## What shipped

D34 marks an expired temp seat on the roster and tells the ward not to file a removal request, because Sync will clear it. Nothing prompts the manager to run that Sync. This is the prompt — and it does not run yet.

- **`sendSyncReminderIfDue(stakeId, now)`** (`functions/src/services/SyncReminderService.ts`). One stake, one decision: skip unless `setup_complete === true`; resolve the stake's calendar day from `stake.timezone`; take yesterday as the cutoff so "expired more than a day ago" is the canonical `isExpiredTempGrant` against a moved boundary rather than a second comparison; select the qualifying grants; apply a three-day backoff; email the active Kindoo Managers; push to the ones opted in; stamp last. Ordinary "nothing to do" outcomes are statuses on the return value, not throws, so a caller can log an outcome without a try/catch.
- **No trigger.** It is not exported from `functions/src/index.ts`, nothing wraps it, and no scheduled job exists. **The reminder runs when something calls it, and nothing does.** Its invoker arrives with the scheduled-task dispatcher ([T-104]).
- **Selection narrowed by `syncWillClearSeat`** — the same D34 predicate that decides whether to withhold the Remove control. An expired grant on a multi-grant seat is excluded.
- **A seventh notification email.** Subject `[Stake Building Access] One temporary seat has expired but is still on the roster`, count spelled out to twelve off the existing `COUNT_WORDS` table. Body: the lead, the instruction naming the extension's Sync, a `Member` / `Scope` / `Ended` table oldest-first, a **View seats** button. Scopes resolve to ward display names through `loadScopeLabeller`, one wards read per send.
- **A second push category.** `notificationPrefs.push.syncReminder`, its own switch in the Push Notifications panel, absent-reads-OFF for everyone including existing `newRequest` subscribers. `newRequest` became optional in the type and the zod schema to match.
- **The push fanout extracted** to `functions/src/lib/push.ts` — token collection, data-only payload, FCM invalid-token pruning — now shared by `pushOnRequestSubmit` and the reminder.
- **A module move.** `apps/web/src/lib/tempExpiry.ts` → `packages/shared/src/tempExpiry.ts`, and the stake-timezone helpers out of `apps/web/src/lib/datetime.ts` → `packages/shared/src/stakeTime.ts`. `ExpirableGrant` is `{type: SeatType, end_date?}` — structural, and narrow enough that a typo'd `'tmp'` is a compile error.
- **`stakes/{sid}.last_sync_reminder_date`**, a stake-local `YYYY-MM-DD`, added to `BOOKKEEPING_FIELDS`.

## Why

**The move was forced, not chosen.** Root `CLAUDE.md` and D34 both say the expiry rule lives in one file "and nowhere else". The server needed the same rule, so the only options were to move the module or to break the one sentence the decision rests on. `todayInStakeTz` pulls in `formatDateInStakeTz`, so the timezone helpers moved with it; both files are `Intl`-only, so `@kindoo/shared` stays runtime-dep-free and nothing about the web's behaviour changed.

**Merging without a trigger is the deliberate part, and it is a scheduling-economics decision.** Cloud Scheduler's free tier is three jobs per billing account and this stack spends two on any single job, because staging and prod each get a copy. One `onSchedule` per scheduled feature therefore stops working at the second feature. [T-104] replaces that shape with one hourly dispatcher over per-stake trigger rows, and shipping the handler first proves the contract it will call — a plain async function of `(stakeId, now)` that knows nothing about hours or dispatch. The accepted cost is real: this merges code nothing runs, which is exactly the kind of thing that rots quietly, so the "no invoker yet" fact is stated in root `CLAUDE.md`, `spec.md` §9, `firebase-schema.md` §7, and D37 rather than in one place someone might not read.

**The narrowing is a copy decision that had to be enforced in code.** The mail's one instruction is "run Sync in the extension". `sba-only` is the only Sync fix that deletes an SBA seat and the detector raises it only when the member has no Kindoo user at all, so on a seat carrying other grants that instruction is false. A recurring email whose call to action is wrong for some of its rows teaches managers to ignore all of them — which costs more than the rows it would have surfaced. Reusing `syncWillClearSeat` rather than writing a second test means the badge and the mail cannot disagree about which seats Sync will reap.

**A separate push category over reusing `newRequest`.** That switch is labelled "New request notifications" and its Enable-button copy promises a notification "when a new access request is submitted". Folding a differently-shaped alert under it would broaden a promise the user already answered. Absent-reads-OFF follows from the same premise — an unanswered question must not read as "yes" — and it is also why there was nothing to backfill: every existing subscriber starts off.

**The backoff lives in the service, not in a schedule.** "Don't repeat while the same condition holds, but send immediately on a fresh one" is not expressible as a cadence even in principle; only the code that can see the condition can apply it. Stamping stake-local `YYYY-MM-DD` rather than a timestamp keeps the field in the same units as the expiry rule. Deleting the stamp when nothing is expired is what makes a fresh occurrence a fresh first send rather than the tail of an unrelated wait. Writing it **last** means a fault anywhere earlier leaves the reminder due rather than silently consumed.

## What didn't change that you'd expect to

- **SBA still runs zero scheduled Cloud Functions, and still deploys twenty-seven.** D35 is intact and `firebase-schema.md` §7's count sentence is unchanged. There is no new deployable in this PR at all — only a service module, a shared lib, and shared-package moves.
- **Sync itself is untouched.** The reminder nudges the reaper that exists; it does not add a second expiry clock. That was D19's design and D34 already rejected re-proposing it.
- **No new Firestore rule and no new index.** The `userIndex` self-write rule gates on `hasOnly(['fcmTokens','notificationPrefs','lastActor'])` and never enumerates push categories, so the new key needed nothing. The seat scan reads the collection and filters in memory — ~250 seats at target scale does not earn a composite index.
- **No per-user email preference.** The reminder is gated only by the stake-level `notifications_enabled` kill-switch, like every other email. Push is an accelerant, not a condition: an active manager who never enabled push still gets the mail.
- **`lastActor` on the stake doc is left alone** when the backoff stamp is written. A reminder went out; nothing about the stake changed, and the doc should keep naming whoever last really edited it.
- **The old paths stay in the trail files.** `docs/changelog/expired-temp-seat-display.md`, `docs/changelog/audit-tz-filter-remove-installscheduledjobs.md`, and the `[RESOLVED]` T-2 entry in `open-questions.md` still name `apps/web/src/lib/tempExpiry.ts` and `apps/web/src/lib/datetime.ts`. They are records of what was true when they were written. D34 and D20 carry the in-place amendments instead.

## Spec / doc edits

- `docs/architecture.md` — new **D37**; D34 amended in place for the moved module and the shared `syncWillClearSeat`; D20 amended in place for the moved timezone helpers and for its "consumed only by stake-local rendering" clause, which the server-side reminder falsifies (the "never by a scheduler" half still holds).
- `docs/spec.md` — §2 push bullet (two categories); §5.3 Notifications panel (two category switches, merge-write semantics, what Enable opts you into); §7 (moved paths, and an honest note that the prompt exists but is not dispatched); §9 (six emails → seven, new table row, a **Sync reminder** subsection covering the conditions and the exclusion, and the push paragraph rewritten for two categories).
- `docs/firebase-schema.md` — §3.1 gains `fcmTokens` / `notificationPrefs` / `lastActor`, the absent-reads-OFF rule, and a corrected "writes server-only" line that was already wrong before this PR; §4.1 gains `last_sync_reminder_date` and its writer; §7 gains the service-module paragraph and keeps the deployed count at twenty-seven.
- Root `CLAUDE.md` — the D34 bullet's "and nowhere else" path corrected to the shared home, and a new bullet recording the reminder as shipped-but-inert.
- `docs/TASKS.md` — [T-103] closed with a note on the one departure from its own plan; [T-104] and [T-105] added.

## Known issues / deferred

- **[T-104] — the dispatcher.** Until it lands, `SyncReminderService.ts` is code nothing runs. It is the whole reason this shipped inert, and it is also where the seeding and opt-in questions live.
- **[T-105] — expired grants on multi-grant seats have no reaper and no reminder.** Sync structurally cannot clear them and this feature deliberately does not list them, so the roster badge is now the only signal, and only to whoever happens to look. Worth deciding whether a distinct reminder naming the remove-request remedy is warranted, or whether the badge plus the ordinary request flow is enough.
- **The backoff stamp dedupes sequential redelivery, not concurrent.** Two invocations for the same stake overlapping in time both read the pre-write stamp and both send. That is acceptable for an at-least-once invoker delivering twice in sequence, which is what the stamp was for. The dispatcher inherits the concurrent case: deterministic Cloud Tasks names per (stake, trigger, window), or a lease. It belongs there, not in the handler — the handler cannot see that another copy of itself is running.
- **[T-106] — case (1) of the original reminder request, "no Sync in ≥ 7 days".** The condition the operator named first, and the one this feature can only catch a symptom of. Nothing records when a Sync ran, so it needs the extension to write a per-Kindoo-site heartbeat, which puts it behind a Chrome Web Store release — the whole reason the two cases were split.
- **The reminder has no dead-letter behaviour.** A push failure is reported on the outcome and logged; an email failure lands as an `email_send_failed` audit row keyed on the oldest expired grant's end date. Neither retries, and both are invisible unless someone reads logs — the same unwired-alerting gap [T-102] left behind.
