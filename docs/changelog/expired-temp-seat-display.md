# Expired temp seats — marked and inert on the roster surfaces

**Shipped:** 2026-08-17
**Commits:** PR TBD (branch `feat/expired-temp-seat-display`)

## What shipped

A temp seat whose end date has passed now renders on the roster pages with an `Expired` badge, muted, and with neither the Remove nor the Edit control — replaced by a line saying the seat clears at the next Sync and no request is needed. Kindoo Managers keep **Remove** (they are the ones who clear the stale row) and get the badge on All Seats too. **Edit is withheld from everyone including them** — `provisionEdit` throws `ProvisionEditUserMissingError` when the Kindoo lookup misses, so the button could only produce a request the extension must fail.

## Why

Kindoo ends a temp user's access on the end date; the SBA seat only goes away when a manager's next Sync detects it as `sba-only` and clears it (§7, D19). Days can pass between the two. Wards read the lingering row as a seat needing cleanup and filed `remove` requests for access that had already ended — each one a no-op the manager then had to close (§6 R-1).

## Decisions made

- **Mark the row; don't hide it** — recorded as D34. Hiding was the first proposal. An early draft ruled it out on the grounds that a hidden row could conceal a seat still live in Kindoo; the operator retracted that premise (expiry means Kindoo already removed the access), and the reason that survives is that the seat is still *in SBA* — still counted in the scope's utilization bar, still work in a manager's Sync backlog. A row that vanished while the record persisted would misreport SBA's own state.
- **Kindoo Managers keep Remove** — they are the only principal who can clear the seat. The explanatory note is withheld from them instead; "no request needed" contradicts a button sitting beside it.
- **Expiry is per grant, in the stake's timezone, starting the day AFTER `end_date`** — §7 holds the seat THROUGH its end date, and a member with an expired grant in one ward and a live one in another is marked only on the lapsed ward.

## Review findings folded in

- **The note contradicted the `Pending Removal` badge.** A ward files a remove, the manager doesn't process it before the seat crosses `end_date`, and the card showed both the danger badge and "no request needed." That's the population this feature exists for, plus everything queued at rollout. The note is now withheld whenever a remove is in flight.
- **`opacity: 0.72` on the card broke contrast.** It composites the text against the page: the note landed near 2.9:1, under the 4.5:1 AA floor, and the member name near 3.6:1. The muting is now background-only (`#eef0f4` card, charcoal inset rule) with the note at `--kd-fg-2` — about 6.8:1.
- **"Submit a new request" was a dead end.** `NewRequestForm` disables Submit whenever the member already holds a seat in the scope (`dupHit`), and the lingering expired row is that seat — the premise of the feature. Spec §7 and both guides now say what actually unblocks it: Sync clears the row, then the request goes through.
- **The note fired on rows where the promise was false.** It gated on `!canRemove`, which is also false when the viewer simply lacks authority over the scope — on Ward Rosters that is every row for a Stake Presidency principal, multi-grant rows included. `isStrandedByExpiry` is now its own prop carrying the condition the pages already compute.
- **The note promised a Sync that may never run.** `sba-only` — the only fix that deletes an SBA seat — is raised only when the member has no Kindoo user at all, so on a seat carrying other grants the expired grant is never reaped. Withholding Remove there stranded the row with a false explanation and no remedy. `syncWillClearSeat` narrows the suppression to single-grant seats; multi-grant seats keep the badge and keep Remove, and the All Seats tooltip says which case it is.
- **The manager's Edit couldn't work either.** Gated for every principal, no manager exemption — but the rationale needed correcting after a follow-up round: `provisionEdit`'s `ProvisionEditUserMissingError` comes from a *member* lookup, so it only fires on single-grant seats. The reason that holds everywhere is grant-level — Kindoo drops the temp AccessSchedule at expiry, so an `edit_temp` would re-add it, which is an add. Unlike Remove, Edit is deliberately NOT narrowed to single-grant; the cost (Remove → manager completion → fresh `add_temp` to extend a multi-grant member's lapsed grant) is accepted and recorded.
- **The "divergent date" case isn't one.** Two drafts chased a scenario where Kindoo's expiry outlasts SBA's `end_date`, leaving a live seat the ward can't report — first documenting Edit as the escape hatch (wrong: `EditSeatDialog` submits an `edit_temp` *request*, so nothing moves until a manager completes it), then documenting the gap as open. The operator closed it: Kindoo is the system of record, so an expired temp seat means Kindoo has already removed it and the SBA row is simply stale. There is no editing a record that doesn't exist, and no removing one either — so Edit is now gated exactly as Remove is, and someone who needs access again submits a new request. Spec §7 and D34 now say that; D34's hide-vs-mark rationale was rewritten too, since it had rested on the same phantom.
- **`useFirestoreDoc` generic unpinned** — `.timezone` was `any`. Now `useFirestoreDoc<Stake>`.

## Implementation

- `apps/web/src/lib/tempExpiry.ts` — `isExpiredTempGrant(grant, today)`, `todayInStakeTz(timezone, now?)`, and `syncWillClearSeat(seat)`. The only place the rules are expressed.
- `apps/web/src/lib/useStakeTimezone.ts` — the active stake's `timezone` for pages that don't otherwise read the stake doc. Shares the cached `useFirestoreDoc` listener rather than opening a second one.
- `PerGrantRosterCard` takes `isExpired`: badge + `is-expired` class, and the note when the caller also withheld `canRemove` and no remove is pending.
- `Badge` gains an `expired` variant — the set's only dark-filled chip, chosen because the seat types already own blue and amber and `danger` owns red, and this badge can appear beside any of them.
- Bishopric Roster, Stake Roster, Ward Rosters compute `isExpired` per row: `canRemove` gates on `isManager || !isExpired`, `canEdit` on `!isExpired` with no exemption. All Seats renders the badge.
- Test clocks in the four affected page suites are pinned (`vi.useFakeTimers({ toFake: ['Date'] })` at 2026-05-20) — without that, every existing temp fixture's `end_date` would silently change meaning as the real calendar crossed it.

## Resolved by shipping

- **`open-questions.md` T-2 `[P1]` "Same-day expiry semantics"** — the question was "confirm with stakeholders so the UX text is right," and this PR *is* that UX text. Marked resolved: the seat is alive on its end date and expires the following morning, in the stake's timezone. The stakeholder half answered itself — leaders filing removes against these rows is what prompted the work.

## Spec / doc edits

- `docs/spec.md` — §7 rewritten to cover the display rule; §5.1 and §5.3 note the badge and the withheld control; §5.2's Ward Rosters bullet notes the manager exemption.
- `docs/architecture.md` — D34.
- `docs/open-questions.md` — T-2 resolved.
- `docs/user-guide/creating-requests.html`, `docs/user-guide/kindoo-managers.html` — what a leader sees and what the manager does about it.

## Not in scope

- Remove requests already filed against expired seats. They resolve through the existing R-1 no-op path.
- Any change to the rules, the schema, or the request path. This is display-only.
