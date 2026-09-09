# Quarterly manual-seat review — operator dry run

**Shipped:** 2026-09-08
**Commits:** PR #300 (`feat/msr-dry-run`) — dry-run mode `24082fd`, observability at both layers `6ce77dd`, docs `<this commit>` (T-109)

## What shipped

A hidden operator-only flag on the stake doc, `manual_seat_review_dry_run`, that lets the quarterly manual-seat review (D41) be run against a real stake's real data with every mail redirected to the stake's active Kindoo Managers — and enough logging on both sides that the run can be verified even when nothing is allowed to send.

D41 is a one-way door. Turning **Quarterly access reviews** on for a real stake means that at the next firing every ward's bishopric receives mail, computed from importer-sourced callings that no test fixture can vouch for. The recipient rule is the part most likely to be wrong and it is the part with no safe place to check it. This mode is that place.

## What it does

**`stake.manual_seat_review_dry_run?: boolean`** — no UI anywhere, set by hand in the Firestore console, never written by any code path, expected to be removed again after the run. It is deliberately modelled on `web_base_url_override` (`spec.md` §9, "Per-stake base URL"), the escape hatch it now sits beside on the stake doc; same shape, same lifecycle, same "there is no writer for this in the repo."

- **Every scope's mail goes to the active Kindoo Managers.** The real recipient rule still runs — its answer is **reported, not obeyed**. Each mail marks `[DRY RUN]` in the subject ahead of the scope label, and carries a banner naming the intended recipients. The subject mark and the banner come from one `DRY_RUN_MARK` / `dryRunBannerLines` pair in `EmailService.ts`, and the HTML and text parts render the same lines, so the two parts cannot say different things.
- **A scope whose real recipient set is empty still sends**, saying that a real run would have reached nobody and would have skipped the scope silently. It still counts into `scopesSkipped`, which under a dry run reads as the finding rather than as the consequence.
- **`ScheduledJob.skipJitter?: (stake) => boolean`** is a new seam on D38's dispatcher. `manualSeatReview` supplies `(stake) => stake.manual_seat_review_dry_run === true`, so a dry run fires at its slot instead of waiting out D41(b)'s 0–20 hour offset. **The dispatcher never names any job's field.** `jitterDelaySeconds` is untouched and still pure.
- **Observability at both layers that read the flag.** The dispatcher logs one INFO per successful enqueue carrying `delaySeconds`; the handler logs one INFO per scope before the send carrying `dryRun`, `recipients`, `intendedRecipients` and `emailSuppressed`. `ManualSeatReviewOutcome` gained `dryRunRecipients` — per scope, who was mailed and who would have been.
- **The stamp is still written.** A dry run consumes the quarter.
- **`notifications_enabled: false` still suppresses**, dry run or not, with a dedicated WARN naming that cause.
- **`no-recipients` keeps its meaning and loses one cause.** A scope with no real recipients now mails the managers, so under a dry run that status can only mean "no active Kindoo Manager to show the run to."

## The operator procedure

Two variants. The staging one proves the machinery. The prod one is what removes the last place you would be trusting the flag rather than observing it.

### Staging rehearsal

Read the log, not the inbox. On staging you can — and should — leave `notifications_enabled: false`, which means nothing can send at all, and the run still emits a complete and truthful record of the decision it would have made. That is possible only because recipient resolution and the dry-run redirect both happen in `sendManualSeatReviewIfDue`, *before* `notifyScopeManualSeatReview`, which is where the kill-switch gate lives.

1. In the Firestore console, on `stakes/{stakeId}`: set `manual_seat_review_dry_run` to boolean `true`. Read the field name back off the document before continuing — see "The limitation" below for why that step is not paranoia.
2. Delete `last_manual_seat_review_date` if it is present, so the interval says the review is due.
3. Make sure the stake's `stakeSchedules/{stakeId}` row for `manualSeatReview` has `enabled: true`, and that its `next_trigger_time` is in the past (a row that has sat disabled usually is). If it is not, wait for the slot.
4. Wait for the next hourly dispatch pass, then read the logs.

**What proves the dispatcher read the flag:** `dispatchScheduledTasks: enqueued` with `job: 'manualSeatReview'` and **`delaySeconds: 0`**. Without the flag that field carries the stake's deterministic offset instead — `csnorth`'s is `23643` (6h 34m) and it is the same number every time, which is exactly what makes `0` legible as a decision rather than as noise.

**What proves the handler read the flag:** one `manualSeatReview: mailing scope` line per scope, carrying `dryRun: true`, a `recipients` list that is the Kindoo Managers, and a populated (or deliberately empty) `intendedRecipients`. Read every line: `intendedRecipients: []` on a ward is the finding the whole mode exists to surface — that ward's manual seats would go unreviewed in production and nothing would say so.

**With `notifications_enabled: false` you will also see** `manualSeatReview: DRY RUN suppressed by notifications_enabled=false — no mail` at WARN. That line exists so an operator staring at an empty inbox can tell suppression from a broken flag.

5. **Clear the stamp.** The run wrote `last_manual_seat_review_date` even though nothing sent. Delete it in the console, or the next real run will decline for a quarter.
6. **Remove `manual_seat_review_dry_run`** from the document. Deleting the field is preferred over setting it `false`: the field's absence is the state the schema documents, and a `false` left lying around is a thing a future reader has to interpret.

### Production rehearsal

Same shape, with the kill-switch doing the protecting instead of the environment. This is the variant worth the trouble, because it runs against the callings data the real mail would use.

1. Configuration → Config: turn **Email Notifications Enabled** off. Note that this suppresses *all* of the stake's mail while it is off, so keep the window short and do it outside working hours.
2. Set `manual_seat_review_dry_run: true` on `stakes/{stakeId}`; delete `last_manual_seat_review_date`.
3. Wait for the dispatch pass. Read the logs exactly as above — `delaySeconds: 0`, then one `mailing scope` line per scope with `dryRun: true`, `emailSuppressed: true`, and the two recipient lists.
4. Check the `intendedRecipients` lists against what you expect each ward's bishopric to be. This is the whole exercise; everything else is scaffolding for it.
5. Delete `last_manual_seat_review_date`, remove `manual_seat_review_dry_run`, turn **Email Notifications Enabled** back on.
6. Delete `last_manual_seat_review_date` once more if step 5's ordering left one, then let the next pass run for real.

If step 4 turns up a wrong or empty recipient list, fix the callings data (or the rule) and rehearse again before re-enabling mail — that is the entire point of having spent the quarter.

### The limitation

Both layers read the same field off the same document, so **a misspelled field name fails both together**, and the run then looks exactly like a stake that simply is not in dry run: a non-zero `delaySeconds`, no `dryRun: true` anywhere, and — if `notifications_enabled` is on — real mail to real bishoprics. The observability proves the flag was read and acted on; it cannot prove you typed the right key. Reading the field back off the document is the only check for that, which is why it is step 1 and not a footnote. Doing the first rehearsal with the kill-switch off makes the failure harmless rather than merely unlikely.

## Why

**Why not a script.** The obvious alternative was a one-off operator script that resolved the recipients and printed them without sending. It was rejected because it would be a *second* implementation of D41(c)'s recipient rule, and a second implementation proves nothing about the first. The only rehearsal worth having is the real handler, on the real dispatch path, making the real decision — which is also why the flag is read where the decision is made rather than checked once at the top.

**Why redirect to the Kindoo Managers rather than to a single operator address.** The managers are already an addressable, correctly-scoped set that D41(c) computes for the stake scope anyway, so redirecting costs no new lookup and no new configuration field. And a manager receiving a dry-run mail is exactly the right reader: they are who would act on the real one.

**Why an empty-recipient scope still sends.** This is the sharpest call in the change, because it makes the dry run diverge from production, which is normally the one thing a rehearsal must not do. It was taken because the divergence *is* the finding. D41(c)'s "a scope with nobody qualifying sends nothing and logs" is silent from the operator's side — the ward's manual seats go unreviewed forever and the only trace is a log line nobody is reading. A rehearsal that faithfully reproduced that silence would report nothing. Don't tidy the branch back into an unconditional skip.

**Why the stamp is still written.** A dry run consumes the quarter. The alternative — a mode that does everything except stamp — is repeatable, and repeatable is the hazard: a flag left set would re-fire on every hourly pass. Consuming the quarter makes the run self-limiting and puts the cost where an operator can see it. The console deletion is the price, and it is written into the procedure above rather than left as an inference.

**Why `skipJitter` is a predicate on the registry.** D41(b)'s jitter window is 20 hours and `csnorth`'s offset is 6h 34m, so an operator cannot sit through a rehearsal. But jitter's reason — stopping dozens of stakes bursting the estate's mail into one minute — simply does not apply to one deliberate run on one stake, so waiving it costs nothing. It is a predicate the job owns rather than a field the dispatcher checks because the moment the dispatcher names one job's field, every future job's special case has a precedent to follow. The predicate runs against a hand-edited document, so a throw is caught and read as "no skip": a bad hand-edit must not strand that stake's *other* jobs over a question that only affects delivery timing.

**Why the handler's log lands before the send.** So a rehearsal with the kill-switch off is legible. Resolution and redirect happen outside `notifyScopeManualSeatReview`; if they were moved inside it, a suppressed run would emit nothing and the safest way to rehearse would also be the blindest.

## What didn't change that you'd expect to

- **`jitterDelaySeconds`.** Still pure, still deterministic, still "stake X runs at second N, always." The waiver is decided in the dispatcher's enqueue step, not inside the hash — a function that sometimes consults a document is no longer a function you can reason about during an incident.
- **The dispatcher's generality.** It reads the whole stake document now instead of just `timezone`, but that is the same read it was already making, and it still names no job's field. Adding a scheduled feature is still a registry entry (D38).
- **`notifications_enabled`.** Still the kill-switch, still email-only, still absolute. A dry run does not bypass it and must not.
- **The production recipient rule.** D41(c) is untouched. Under a dry run it runs and its answer is reported; it is not modified, not relaxed, and not shadowed by a second implementation.
- **The seat data.** A dry run reads exactly what a real run reads and writes nothing but the stamp. It is not a sandbox and it does not need one.
- **No UI, no callable, no toggle.** Deliberately. A dry run that a manager can start is a dry run a manager can leave running.

## Deferred

- Nothing. The flag is expected to be removed from a stake after each use; if it accumulates a second consumer or a longer life, that is when it earns a UI, and that is a different decision.
