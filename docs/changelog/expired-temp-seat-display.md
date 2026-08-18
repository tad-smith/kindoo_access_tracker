# Expired temp seats — marked and inert on the roster surfaces

**Shipped:** 2026-08-17
**Commits:** PR TBD (branch `feat/expired-temp-seat-display`)

## What shipped

A temp seat whose end date has passed now renders on the roster pages with an `Expired` badge, muted, and with no Remove control — replaced by a line saying the seat clears at the next Sync and no request is needed. Kindoo Managers keep the Remove control and get the badge on All Seats too.

## Why

Kindoo ends a temp user's access on the end date; the SBA seat only goes away when a manager's next Sync detects it as `sba-only` and clears it (§7, D19). Days can pass between the two. Wards read the lingering row as a seat needing cleanup and filed `remove` requests for access that had already ended — each one a no-op the manager then had to close (§6 R-1).

## Decisions made

- **Mark the row; don't hide it** — recorded as D34. Hiding was the first proposal. It was ruled out because SBA's `end_date` mirrors what was provisioned, not what Kindoo currently holds: if the manager set a different date in Kindoo, or provisioned none, a live seat would go invisible to the ward, un-removable and unreported. The row also keeps counting against the scope's utilization bar, since the seat is still there until Sync clears it.
- **Kindoo Managers keep Remove** — they are the only principal who can clear the seat. The explanatory note is withheld from them instead; "no request needed" contradicts a button sitting beside it.
- **Expiry is per grant, in the stake's timezone, starting the day AFTER `end_date`** — §7 holds the seat THROUGH its end date, and a member with an expired grant in one ward and a live one in another is marked only on the lapsed ward.

## Review findings folded in

- **The note contradicted the `Pending Removal` badge.** A ward files a remove, the manager doesn't process it before the seat crosses `end_date`, and the card showed both the danger badge and "no request needed." That's the population this feature exists for, plus everything queued at rollout. The note is now withheld whenever a remove is in flight.
- **`opacity: 0.72` on the card broke contrast.** It composites the text against the page: the note landed near 2.9:1, under the 4.5:1 AA floor, and the member name near 3.6:1. The muting is now background-only (`#eef0f4` card, charcoal inset rule) with the note at `--kd-fg-2` — about 6.8:1.
- **The divergent-date case has no owner — still open.** If Kindoo's expiry is later than SBA's `end_date`, the seat is live, the row asserts it isn't, and Sync never raises it (the user is present in both systems). A first attempt documented Edit as the ward's channel; that was wrong — `EditSeatDialog` submits an `edit_temp` **request**, so the row un-expires only after a manager completes it, which is the same manager latency this feature routes around, and it asks the ward to extend access in order to remove it. Spec §7, D34, and the guide FAQ now state the gap accurately: contact a Kindoo Manager out of band. Awaiting an operator decision on whether to give it an in-app channel.
- **`useFirestoreDoc` generic unpinned** — `.timezone` was `any`. Now `useFirestoreDoc<Stake>`.

## Implementation

- `apps/web/src/lib/tempExpiry.ts` — `isExpiredTempGrant(grant, today)` + `todayInStakeTz(timezone, now?)`. The only place the rule is expressed.
- `apps/web/src/lib/useStakeTimezone.ts` — the active stake's `timezone` for pages that don't otherwise read the stake doc. Shares the cached `useFirestoreDoc` listener rather than opening a second one.
- `PerGrantRosterCard` takes `isExpired`: badge + `is-expired` class, and the note when the caller also withheld `canRemove` and no remove is pending.
- `Badge` gains an `expired` variant — the set's only dark-filled chip, chosen because the seat types already own blue and amber and `danger` owns red, and this badge can appear beside any of them.
- Bishopric Roster, Stake Roster, Ward Rosters compute `isExpired` per row and gate `canRemove` on `isManager || !isExpired`. All Seats renders the badge.
- Test clocks in the four affected page suites are pinned (`vi.useFakeTimers({ toFake: ['Date'] })` at 2026-05-20) — without that, every existing temp fixture's `end_date` would silently change meaning as the real calendar crossed it.

## Spec / doc edits

- `docs/spec.md` — §7 rewritten to cover the display rule; §5.1 and §5.3 note the badge and the withheld control; §5.2's Ward Rosters bullet notes the manager exemption.
- `docs/architecture.md` — D34.
- `docs/user-guide/creating-requests.html`, `docs/user-guide/kindoo-managers.html` — what a leader sees and what the manager does about it.

## Not in scope

- Remove requests already filed against expired seats. They resolve through the existing R-1 no-op path.
- Any change to the rules, the schema, or the request path. This is display-only.
