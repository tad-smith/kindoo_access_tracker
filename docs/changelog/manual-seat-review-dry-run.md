# Quarterly manual-seat review — operator dry run

**Shipped:** 2026-09-08
**Commits:** PR #300 (`feat/msr-dry-run`) — dry-run mode `24082fd`, observability at both layers `6ce77dd`, docs `72ff8b3` (T-109)

## What shipped

A hidden operator-only flag on the stake doc, `manual_seat_review_dry_run`, that lets the quarterly manual-seat review (D41) be run against a real stake's real data with every mail redirected to the stake's active Kindoo Managers — and enough logging on both sides that the run can be verified even when nothing is allowed to send.

D41 is a one-way door. Turning **Quarterly access reviews** on for a real stake means that at the next firing every ward's bishopric receives mail, computed from importer-sourced callings that no test fixture can vouch for. The recipient rule is the part most likely to be wrong and it is the part with no safe place to check it. This mode is that place.

## What it does

**`stake.manual_seat_review_dry_run?: boolean`** — no UI anywhere, set by hand in the Firestore console, never written by any code path, expected to be removed again after the run. It is deliberately modelled on `web_base_url_override` (`spec.md` §9, "Per-stake base URL"), the escape hatch it now sits beside on the stake doc; same shape, same lifecycle, same "there is no writer for this in the repo."

- **Every scope's mail goes to the active Kindoo Managers.** The real recipient rule still runs — its answer is **reported, not obeyed**. Each mail marks `[DRY RUN]` in the subject ahead of the scope label, and carries a banner naming the intended recipients. The subject mark and the banner come from one `DRY_RUN_MARK` / `dryRunBannerLines` pair in `EmailService.ts`, and the HTML and text parts render the same lines, so the two parts cannot say different things.
- **The ward and branch CTA points at the manager view.** A real ward mail links `/bishopric/roster?ward=…&stake=…`, and that page builds its ward list from the **bishopric claim**, not from the manager superset — so a manager with no bishopric claim would land on "You have no bishopric wards assigned in this stake", and a manager who sits in one bishopric would silently get *that* ward's roster whichever ward the mail concerned. Under a dry run the ward and branch link is `/manager/seats?ward=<scope>&type=manual&stake=<stakeId>` instead: that ward's manual grants on the All Seats view, the same list the mail just rendered. The stake-scope link (`/stake/roster?stake=…`) is unchanged, because a manager passes that gate through the superset. **Real-run links are unchanged in every case.**
- **The banner names the substitution, and names the cleanup.** Beyond the intended-recipient list, every mail carries a line saying to delete `manual_seat_review_dry_run` from the stake document once the rehearsal has been read, and a ward or branch mail carries a second one saying the button points at the manager view because this is a rehearsal, naming the `/bishopric/roster` path a real mail would carry. A stake-scope mail has no substitution to name: its link is unchanged. Its opening claim is conditional for the same reason — on the stake scope the redirect is a no-op, because the Kindoo Managers reading the mail are that scope's real recipients, so the banner does not tell them the mail reached nobody real.
- **A scope whose real recipient set is empty still sends**, saying that a real run would have reached nobody and would have skipped the scope silently. It still counts into `scopesSkipped`, which under a dry run reads as the finding rather than as the consequence.
- **`ScheduledJob.skipJitter?: (stake) => boolean`** is a new seam on D38's dispatcher. `manualSeatReview` supplies `(stake) => stake.manual_seat_review_dry_run === true`, so a dry run fires at its slot instead of waiting out D41(b)'s 0–20 hour offset. **The dispatcher never names any job's field.** `jitterDelaySeconds` is untouched and still pure.
- **Observability at both layers that read the flag.** The dispatcher logs one INFO per successful enqueue carrying `delaySeconds`; the handler logs one INFO per scope before the send carrying `dryRun`, `recipients`, `intendedRecipients` and `emailSuppressed`. `ManualSeatReviewOutcome` gained `dryRunRecipients` — per scope, who was mailed and who would have been.
- **The stamp is still written.** A dry run consumes the quarter.
- **`notifications_enabled: false` still suppresses**, dry run or not, with a dedicated WARN naming that cause.
- **`no-recipients` keeps its meaning and loses one cause.** A scope with no real recipients now mails the managers, so under a dry run that status can only mean "no active Kindoo Manager to show the run to."

## The operator procedure

Two variants. The staging one proves the machinery cheaply. The prod one runs in **three passes**, and its ordering is the whole safety property — see "Why three passes" below before following it.

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

**Staging stops here — there is deliberately no mailed pass on staging.** The mailed pass below exists to inspect a real stake's rendered lists in a real inbox, and staging's seats, callings and manager set are fixtures, so a staging mail would render data that proves nothing about the stake you are actually about to enable. A staging send would also exercise staging's Resend key and sending domain rather than production's. If a template change needs a cheap visual check, turning `notifications_enabled` on for a staging dry run is harmless and available — it is just not part of this procedure.

### Production rehearsal — three passes

The flag stays set across the first two passes. Clear `last_manual_seat_review_date` and back-date `next_trigger_time` between **every** pass: each pass consumes the quarter, and the dispatcher stamps `next_trigger_time` forward to the next monthly slot on each one.

**Pass 1 — kill-switched. Proves the flag is read on this document while nothing *can* send.**

1. Configuration → Config: turn **Email Notifications Enabled** off. This suppresses *all* of the stake's mail while it is off, so keep the window short and do it outside working hours.
2. On `stakes/{stakeId}`: set `manual_seat_review_dry_run` to boolean `true`, and read the field name back off the document. See "The limitation" below for why that is not paranoia.
3. On `stakes/{stakeId}`: delete `last_manual_seat_review_date`. On `stakeSchedules/{stakeId}`, back-date the `manualSeatReview` row's `next_trigger_time` to a past instant and confirm `enabled: true`.
4. Wait for the next hourly dispatch pass, then read the logs: `delaySeconds: 0`, one `mailing scope` line per scope with `dryRun: true` and `emailSuppressed: true`, and the WARN naming the kill-switch.
5. **Check every scope's `intendedRecipients` against who you expect that ward's bishopric to be.** This is the check the whole mode exists for. An empty list is a finding, not a blank. If anything here is wrong, fix the callings data or the rule and repeat pass 1 — do not go on to pass 2.

**Pass 2 — mailed, to the Kindoo Managers only. The flag stays set.**

6. Delete `last_manual_seat_review_date` again, and back-date `next_trigger_time` again.
7. Turn **Email Notifications Enabled** back on. **Leave `manual_seat_review_dry_run` set.**
8. Wait for the dispatch pass. One `[DRY RUN]`-marked mail per scope lands in the Kindoo Managers' inboxes, each naming in its banner who it would really have gone to.
9. Read them as mail, not as logs: the subject mark, the banner's wording — the cleanup line on every mail, plus the line naming the `/bishopric/roster` path a real run would carry on a ward or branch mail, which a stake mail does not carry and should not, since on that scope the managers reading it are the real recipients and the link is unchanged — the intended-recipient list as rendered, the grant table, and the CTA link. **Click the link.** A ward or branch mail opens the All Seats view filtered to that ward's manual grants (`/manager/seats?ward=…&type=manual`); the stake mail opens the Stake Roster. **Compare the two renderings on ward, scope and membership**: the ward in the URL is the ward in the subject, and everyone in the mail's table is on the screen and everyone on the screen is in the mail. **Do not compare them row for row.** A member listed twice in the mail and once on screen is the collapse, not a discrepancy — the mail lists each manual *grant*, so `manualGrantsByScope` emits a row for the primary and a row for each same-scope manual duplicate, while All Seats runs `collapseSameScopeGrants` and merges those into one row carrying the union of their buildings. Same data, two correct renderings, so a row's building list can legitimately be longer on screen than in the mail. What is a finding is a member on one side and not the other, or a ward that doesn't match. This link is deliberately **not** the one a bishopric receives — a real ward mail links `/bishopric/roster`, which builds its ward list from the bishopric claim and so would show you either nothing or the wrong ward — so what this step proves is that the mail's scope, its rendered grant table and its live destination all agree, on a page the dry run's actual reader can open. These are the things no log line can check.

**Pass 3 — the real run. The first time bishoprics are in scope at all.**

10. Delete `last_manual_seat_review_date`, and remove `manual_seat_review_dry_run` from the document — delete the field rather than setting it `false`; the field's absence is the state the schema documents.
11. Either back-date `next_trigger_time` to run it now, or leave it and let the next monthly slot fire it. Pass 3 is a real run, so there is no reason to hurry it.

### Why three passes

The ordering is the point, and it is worth stating rather than inferring from the step list. **Pass 1 proves the flag is read on that exact document while nothing is permitted to send** — the kill-switch, not the flag, is what protects it, so a misread flag costs nothing. **Pass 2 trusts that proof to send something real, and sends it only to the managers** — the mail is genuine, so the templates, the marking, the banner, the rendered recipient list and the live CTA links are all exercised, but a mistake still reaches nobody outside the people running the rehearsal. **Pass 3 is the first moment bishoprics can receive anything**, and by then the flag has been observed working twice on that document, once with mail impossible and once with mail flowing. Collapsing 1 and 2 into a single pass would mean the first mail the feature ever sends is sent on an unverified flag; skipping 2 would mean the first mail it ever sends goes to bishoprics. Either inverts the safety property the whole change exists for.

### The limitation

Both layers read the same field off the same document, so **a misspelled field name fails both together**, and the run then looks exactly like a stake that simply is not in dry run: a non-zero `delaySeconds`, no `dryRun: true` anywhere, and — if `notifications_enabled` is on — real mail to real bishoprics. The observability proves the flag was read and acted on; it cannot prove you typed the right key. Reading the field back off the document is the only check for that, which is why it sits in pass 1 rather than in a footnote. Pass 1's kill-switch is the other half of the answer: it makes that failure harmless rather than merely unlikely, which is precisely why pass 2 is not allowed to be the first pass.

## Why

**Why not a script.** The obvious alternative was a one-off operator script that resolved the recipients and printed them without sending. It was rejected because it would be a *second* implementation of D41(c)'s recipient rule, and a second implementation proves nothing about the first. The only rehearsal worth having is the real handler, on the real dispatch path, making the real decision — which is also why the flag is read where the decision is made rather than checked once at the top.

**Why redirect to the Kindoo Managers rather than to a single operator address.** The managers are already an addressable, correctly-scoped set that D41(c) computes for the stake scope anyway, so redirecting costs no new lookup and no new configuration field. And a manager receiving a dry-run mail is exactly the right reader: they are who would act on the real one.

**Why the ward CTA changes too.** Redirecting the recipients without redirecting their links leaves a mail whose button the recipient cannot use: `/bishopric/roster` gates on the bishopric claim, and the managers a dry run mails are chosen for being managers, not for holding that claim. A dry run's audience is not the real mail's audience, so a link correct for one is wrong for the other. The failure was worse than a dead end, because it was silent — a manager who happens to sit in one bishopric would have been shown that ward's roster whatever ward the mail named, and would have read it as the check passing. Pass 2's step 9 exists to click that link, so a link that cannot resolve makes the step unperformable rather than merely inconvenient.

**Why the flag is not cleared automatically.** Nothing but this procedure stops the flag being left set, and a flag left set redirects the *next* real quarter too — roughly 150 days in which the bishoprics hear nothing and the managers get mail they have already read. Auto-clearing after a run looks like the fix and is not: the three-pass procedure deliberately holds the flag set across passes 1 and 2, so a handler that cleared its own flag would make pass 2 a real send to bishoprics — the exact outcome the three passes exist to prevent. The answer is a banner line in every dry-run mail telling the reader to delete the field, plus pass 3's step 10. Procedural, and deliberately so.

**Why an empty-recipient scope still sends.** This is the sharpest call in the change, because it makes the dry run diverge from production, which is normally the one thing a rehearsal must not do. It was taken because the divergence *is* the finding. D41(c)'s "a scope with nobody qualifying sends nothing and logs" is silent from the operator's side — the ward's manual seats go unreviewed forever and the only trace is a log line nobody is reading. A rehearsal that faithfully reproduced that silence would report nothing. Don't tidy the branch back into an unconditional skip.

**Why the stamp is still written.** A dry run consumes the quarter. The alternative — a mode that does everything except stamp — is repeatable, and repeatable is the hazard: a flag left set would re-fire on every hourly pass. Consuming the quarter makes the run self-limiting and puts the cost where an operator can see it. The console deletion is the price, and it is written into the procedure above rather than left as an inference.

**Why `skipJitter` is a predicate on the registry.** D41(b)'s jitter window is 20 hours and `csnorth`'s offset is 6h 34m, so an operator cannot sit through a rehearsal. But jitter's reason — stopping dozens of stakes bursting the estate's mail into one minute — simply does not apply to one deliberate run on one stake, so waiving it costs nothing. It is a predicate the job owns rather than a field the dispatcher checks because the moment the dispatcher names one job's field, every future job's special case has a precedent to follow. The predicate runs against a hand-edited document, so a throw is caught and read as "no skip": a bad hand-edit must not strand that stake's *other* jobs over a question that only affects delivery timing.

**Why the handler's log lands before the send.** So a rehearsal with the kill-switch off is legible. Resolution and redirect happen outside `notifyScopeManualSeatReview`; if they were moved inside it, a suppressed run would emit nothing and the safest way to rehearse would also be the blindest.

## What didn't change that you'd expect to

- **`jitterDelaySeconds`.** Still pure, still deterministic, still "stake X runs at second N, always." The waiver is decided in the dispatcher's enqueue step, not inside the hash — a function that sometimes consults a document is no longer a function you can reason about during an incident.
- **The dispatcher's generality.** It reads the whole stake document now instead of just `timezone`, but that is the same read it was already making, and it still names no job's field. Adding a scheduled feature is still a registry entry (D38).
- **`notifications_enabled`.** Still the kill-switch, still email-only, still absolute. A dry run does not bypass it and must not.
- **Real-run links.** Only the dry run's ward and branch CTA moves, and only while the flag is set. A real review still links `/bishopric/roster?ward=…&stake=…` for a ward or branch and `/stake/roster?stake=…` for the stake, which are the right pages for the people who actually receive it.
- **The production recipient rule.** D41(c) is untouched. Under a dry run it runs and its answer is reported; it is not modified, not relaxed, and not shadowed by a second implementation.
- **The seat data.** A dry run reads exactly what a real run reads and writes nothing but the stamp. It is not a sandbox and it does not need one.
- **No UI, no callable, no toggle.** Deliberately. A dry run that a manager can start is a dry run a manager can leave running.

## Deferred

- Nothing. The flag is expected to be removed from a stake after each use; if it accumulates a second consumer or a longer life, that is when it earns a UI, and that is a different decision.
