# Branch callings and app access — a third calling set, chosen by the unit's kind

**Shipped:** 2026-08-09
**Commits:** `feat/t96-branch-callings` (PR #270), docs on `feat/t96-docs`

## What shipped

A branch's leaders are now first-class: they sort where they belong, they derive app access, and they are selectable in the request typeahead. #268 taught the system what a branch *is* (`architecture.md` D31). This teaches it what a branch's people are called. Until now a Branch President parsed to a valid scope and an unknown calling — bottom of the sort band, no app access, unselectable on the New Request form — so the branch stake was not actually workable.

**Three app-access calling sets, not two.** `BRANCH_APP_ACCESS_CALLINGS` (`packages/shared/src/appAccessCallings.ts`) holds exactly four names: Branch President, Branch Presidency First Counselor, Branch Presidency Second Counselor, Branch Clerk. `AppAccessOptions` gains `unitType`, and `appAccessCallingsForScope` resolves stake / branch / ward. `stake.eq_president_app_access` extends to branches on identical terms, tier included.

| scope | set | with the Elders Quorum President opt-in on |
|---|---|---|
| `'stake'` | 6 stake callings | unchanged — the stake set is never gated |
| a unit, `unitType: 'ward'` (or absent) | 5 ward callings | + Elders Quorum President, limited tier |
| a unit, `unitType: 'branch'` | 4 branch callings | + Elders Quorum President, limited tier |

**Seven branch callings join the sort table**, each immediately after its ward counterpart, in a band relabelled from "ward callings" to "unit callings": the four above plus Branch Assistant Clerk and its `--Membership` and `--Finance` variants, which rank a seat and grant nothing. `CALLING_ORDER` is 92 entries; the 42-entry stake band is untouched.

**Three call sites in `functions/src/callable/syncApplyFix.ts` had to learn the unit's kind before choosing a set.** `applyKindooOnly`'s existing Kindoo-site read is hoisted above the calling-set choice and `needsSiteResolve` becomes `isUnitScope`, so the site and the kind come from one snapshot in one transaction. `applyCallingsMismatch` and `applyTypeMismatch`'s promote branch each take one `tx.get`, unit scopes only. `applyKindooUnparseable` is stake-literal and reads nothing.

**The web request typeahead was duplicating the shared table and nobody knew.** `apps/web/src/features/requests/standardCallings.ts` kept its own hardcoded copy of all 92 names and never imported `@kindoo/shared`, so the seven new entries reached the sort table, the app-access sets, and the extension — and not the one surface a manager types into. Nothing failed; a Branch President was simply unselectable. `callingsForScope(scope, wards)` now splits the list by unit kind.

**The user guide's app-access table has a Branch row** (`docs/user-guide/kindoo-managers.html` §9), and the Elders Quorum President section no longer says the setting "applies to wards, not the stake" without qualification.

## Why

**`unitType` is a gate on the options bag, but not the same kind of gate as `eqPresidentAccess` — which is why it took its own D-number.** D23 established the bag as the place app-access gates live, and its headline claim is that Elders Quorum President is *the single per-stake degree of freedom*. A unit's kind adds no degree of freedom at all: nobody configures it, it is read off `ward_name`, and it is the same rule in every stake. Filing a churchwide fact as an amendment to the decision that drew the line between churchwide and per-stake would blur exactly the line D23 exists to draw. What this actually amends is **D17(a)**, whose enumeration of the fixed list was a two-way ward/stake split and is now three-way. Recorded as **D32**.

The two options share the bag because both answer "which set applies at this call". They differ in provenance, and that difference is load-bearing: `eqPresidentAccess` is read once per `syncApplyFix` invocation off the stake doc and is identical for every scope in it, while `unitType` is a property of the individual unit and differs scope by scope. A caller that reads the stake once still has to read the unit per scope.

**Absent `unitType` means ward, and the kind can never be derived from `scope`.** `appAccessCallingsForScope` is handed a `ward_code`, which D31(e) deliberately keeps un-normalised — `peterson-branch`, or a legacy two-letter `LB` that carries no name at all. The slug is not the name, so the function cannot answer the question on its own and a caller that has not read the unit doc has nothing to pass. Ward is both backward-compatible (every unit predating branches is a ward, so every pre-branch caller keeps a byte-identical set) and the fail-closed direction: the ward set holds no branch calling, so a branch scope whose caller forgot the option grants nothing. A forgetful caller under-grants; it never over-grants.

The cost of that optional shape is worth stating plainly: a forgotten option is a silent wrong answer rather than a compile error, and the three `syncApplyFix` gaps this PR fixes are exactly that failure. The tests, not the type, are what hold the call sites honest.

**An unresolvable unit refuses the fix rather than guessing.** With the unit doc gone there is no evidence either way, and both guesses fail identically and undetectably — the member simply ends up with no app access, which reads as a permissions bug rather than a data one and gets diagnosed nowhere near the unit doc. So `syncApplyFix` returns the `{ success: false, error }` soft-fail envelope the extension already renders inline, before any write. The operator restores the unit and re-clicks; the drift row re-emits on the next Sync run regardless. Manual and temp seats derive no app access, so they keep the pre-existing missing-unit tolerance (T-42) untouched.

**The sort table interleaves rather than appending a branch block.** A separate block at the tail is the cheaper diff and it reproduces the exact defect being fixed: All Seats spans units, so a mixed list has to rank a branch calling against a ward one, and a trailing block would strand a Branch President below every ward calling. Within one unit only one of each pair can occur, so the tie-break interleaving introduces is unobservable on a roster page.

**The typeahead swaps only what has a counterpart** (operator ruling, 2026-08-09). At a branch, nine ward entries are hidden — Bishop, both Bishopric counselors, Ward Clerk, all three Ward Assistant Clerk variants, and both executive secretaries — and everything else carries over: Sunday School, Relief Society, Primary, Young Women, Elders Quorum, Ward Mission Leader, Building Representative, and the rest. The two executive secretaries are the only entries hidden with **no** replacement, for the same reason the shared set omits a Branch Executive Secretary: branches have none. The four families named in T-96 are which existing entries a branch reuses, not an exhaustive whitelist of what a branch may call someone. Both lists are computed by subtraction from a `UNIT_CALLINGS` union, so a future shared-table entry reaches both automatically and only the two small hide-sets ever need editing.

**An unresolvable unit gives the typeahead the *union*, which is the opposite default from the app-access sets — deliberately.** Callers pass `wards` straight from a live query, so during every fetch no scope resolves; an empty typeahead on each form open would be a visible regression, where a superset costs nothing (the combobox filters as you type, and free text is accepted on submit regardless). A suggestion list that is too long is a cosmetic annoyance. An app-access set that is too long is an authorization defect. Different stakes, different defaults.

**The extension derives the kind per segment, never per description.** `SegmentAppAccessOptions = Omit<AppAccessOptions, 'unitType'>` is what `pickPrimarySegment` / `pickSegmentForSite` / `detect` pass; `segmentGrantsAppAccess` fills `unitType` in from `segment.rawScopeName`, which is the description text verbatim and therefore exactly the string `unitType` is defined over. One Kindoo Description routinely names a ward and a branch at once, so a description-wide value could only ever be wrong for one of them. The `Omit` makes it unpassable rather than merely discouraged.

## What didn't change that you'd expect to

- **No backfill, and none is needed today.** An access record's calling list and its tier are stamped at write time (D26), so records written before this keep their empty branch lists until that scope is next written. Nothing to repair right now — the branch stake is not onboarded — but the next reader should not be surprised to find no migration script here. A branch stake onboarded later gets its access derived on its first Sync run, like any other stake.
- **Known issue: `access.sort_order` is stale on existing docs, and that one DOES affect live data.** Interleaving the branch callings renumbered every unit-band entry after `Bishop` by up to +7 — Ward Executive Secretary 45→48, Ward Clerk 47→50, Elders Quorum President 51→58, Technology Specialist 84→91. The value is **stored, not recomputed**, and the App Access card view sorts on it directly (`apps/web/src/features/manager/access/sort.ts`). Until each doc is next rewritten, pre-merge and post-merge records are ranked against two different tables and can invert within a scope band — a stale `Ward Clerk` (47) outranks a fresh `Ward Executive Secretary` (48). Seat rosters are unaffected: `apps/web/src/lib/sort/seats.ts` re-derives from `callings` at render. So the blast radius is one page, it is cosmetic, and it self-heals per scope as Sync rewrites each access doc — which is why a one-pass recompute would cost more than the symptom. Noted because the no-backfill bullet above reasons only about branch calling lists and would otherwise read as "no stored data is affected", which is not true.
- **`backfillEqPresidentAccess` is already branch-correct with no change.** It matches on the calling name and filters `scope !== 'stake'`, so it sweeps branch seats as readily as ward ones and never asks the unit's kind. `spec.md` §8 and `firebase-schema.md` §4.5 said "ward-scope seats" where the code says "not stake"; those now say unit-scope.
- **`LIMITED_TIER_CALLINGS` is unchanged, and `filterLimitedTierCallings` still takes no scope parameter.** The set is keyed on the calling name alone, so a branch Elders Quorum President lands on the limited tier exactly as a ward one does, with no branch-specific handling anywhere (D25, D26).
- **No schema change, no rules change, no index.** A branch's callings are strings in the same `importer_callings[scope]` arrays as a ward's; nothing about the unit's kind reaches `firestore.rules`.
- **No `Branch Executive Secretary`, anywhere.** Not in the app-access set, not in the sort table, not in the typeahead. Confirmed deliberate by the operator: branches have no counterpart to Ward Executive Secretary, so the name is one nothing writes and one that could only mis-match.
- **`applyKindooUnparseable` reads no unit doc.** Its `'stake'` is a literal, not a variable, and `appAccessCallingsForScope` ignores `unitType` at stake scope — so the fourth `syncApplyFix` call site stayed inert, as T-96 predicted.
- **The stake band of the sort table is byte-identical.** Only the unit band moved, and only by insertion.

## Known issues / deferred

- **T-97 — export the ordered calling table from `packages/shared`.** The web typeahead still duplicates all 92 names, blocked only by `CALLING_ORDER` being module-private: `callingSortOrder` exports a lookup, and a lookup cannot be enumerated. Until then a conformance suite pins the copy against the shared table. It catches an insertion or a rename — the exact shape of the bug this PR fixed — but **not an append to the very end**, because the gap check bounds its range at the copy's own maximum index.
- **T-98 — Playwright coverage for the calling typeahead inside `EditSeatDialog`.** Radix Popover will not open inside Radix Dialog under jsdom, so the branch list there is unverified. A test was removed rather than contorted; faking the open state would assert against a tree the browser never produces, which reads as coverage without being any.
- **Test-suite rot this surfaced, fixed in the same PR.** The unit-band shift broke 8 integration assertions carrying hardcoded sort indices, and 13 more index literals that survived by luck were re-derived through `callingSortOrder(...)`. One (`Bishopric First Counselor` = 43) had already gone stale silently because it sat in a seed rather than an assertion. Two fixture traps went with them: `wards()` in `NewRequestForm.test.tsx` hardcoded `ward_name: \`Ward ${code}\``, making every fixture a ward, and ~25 `functions` tests scoped seats to a `CO` unit doc that was never seeded.

## Doc edits

- `docs/architecture.md` — new **D32**. Amends D17(a) (two-way list → three-way), extends D23's opt-in to branches, adds three consumers to D31(d)'s four.
- `docs/spec.md` — §6 gains the calling typeahead (it was undocumented); §8's app-access block gains the branch set, the three-way resolution and its fail-closed default, and the `syncApplyFix` refusal; the roster sort-order paragraph gains the interleaving; the `callings-mismatch`, `kindoo-unparseable`, Elders Quorum President opt-in, and `backfillEqPresidentAccess` paragraphs corrected.
- `docs/firebase-schema.md` — §4.1 `eq_president_app_access` and §4.5 `importer_callings` / `importer_limited_callings` / the two Admin-SDK writers; §4.8-9 removal note; the `backfillEqPresidentAccess` row in the Cloud Functions table.
- `docs/TASKS.md` — T-96 closed, its six-calling list reconciled to seven; T-97 and T-98 filed.
- `docs/user-guide/kindoo-managers.html` — §9's app-access table gains a Branch row; the Elders Quorum President bullet reads "units, not the stake".
- `packages/shared/CLAUDE.md` — the app-access convention names three arrays and distinguishes the two kinds of gate on the bag.
- `CLAUDE.md` — the T-96 follow-up bullet closed.
