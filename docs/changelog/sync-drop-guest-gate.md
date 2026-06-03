# Sync — drop the Guest gate from unparseable + grant reconciliation

**Shipped:** 2026-06-03
**Commits:** PR #187 (`fix/sync-drop-guest-gates`) — code `c7c65b9`, docs (this commit)

## What shipped

The Sync detector no longer gates any of its grant-derived checks on the Kindoo seat role. `kindoo-unparseable` (present-but-unparseable Description → Update SBA), `type-mismatch` (grant-based promote/demote), and `buildings-mismatch` now apply to **every seat role** — managers included. Before this change, all three were scoped to Kindoo Guests (`UserRole === 2`): non-Guests were either skipped entirely (grant reconciliation, PR #181) or downgraded to review-only (`kindoo-unparseable`, PR #184). This reverses both gates.

## Why

Two failures drove it:

- **Managers can legitimately hold seats.** Scoping grant reconciliation to Guests assumed a manager's grant shape "is none of our business," but a manager who genuinely holds a church-backed seat would never be reconciled.
- **The role-from-door-rows signal mis-skipped a real church-granted Guest.** The role was read off the per-user door-grant rows; a legitimate Guest (`gossbc`) whose direct grant produced *empty* door rows had `UserRole` read as `undefined`, which the gate treated as "skip." The seat that should have demoted/aligned was silently left alone. This was the "Known limitation — entirely-revoked Guests are NOT demoted" note in `sync-design.md` — recorded at the time as an accepted trade-off, but in practice it was this bug.

Removing the role-reading entirely is simpler and correct: provenance comes from the door grants themselves, not from who Kindoo says the user is.

## What was removed

- `skipGrantReconciliation` (the single role predicate both grant checks consulted) — `extension/src/content/kindoo/sync/detector.ts`.
- The `userRole` field and its full plumbing — `KindooEnvironmentUser.userRole`; `getUserAccessRulesWithEntryPoints` / `getUserDoorGrants` no longer return it; the `enrichUsersWithDerivedBuildings` stamp is gone (`endpoints.ts`, `sync/buildingsFromDoors.ts`).
- `KINDOO_GUEST_ROLE` (the `=== 2` constant) — `endpoints.ts`.
- The non-Guest review-only branch of `kindoo-unparseable` and its alternate `reason` string — `detector.ts`.

## What was kept (load-bearing non-changes)

- **The per-check provenance-unknown skips.** `type-mismatch` still skips when `directGrantBuildings === null`; the auto `buildings-mismatch` still skips when `derivedBuildings === null`. These fire only on a **failed** per-user door fetch — a *successful* fetch with zero rows yields `[]`, not `null`, so a fully-revoked Guest now demotes normally (the previous limitation is gone, not relocated).
- **The home-site gate on `kindoo-unparseable`.** "Apply to stake scope" is a home/stake concept; on a foreign Kindoo site the row is still suppressed entirely (`isHomeSite`).
- **The already-aligned suppression** (`unparseableAligned`) and the defensive parsed-but-no-primary `review` fallback.
- **SBA still provisions every seat as a Guest.** The invite wire shape (`KindooInviteUserPayload.UserRole: 2`) is unchanged — only the detector's *reading* of the role was removed.

## Deviations from the pre-change spec

None silently. `spec.md` §8 and `extension/docs/sync-design.md` carried the Guest-only language; both are updated in this commit to match the shipped code.

## Spec / doc edits in this change

- `docs/spec.md` — §8: `kindoo-unparseable` bullet and the review-row enumeration drop the non-Guest variant; "Grant-derived seat type" paragraph drops the Guests-only scoping and the `skipGrantReconciliation` reference (now "applies to all seat roles, skip only on provenance-unknown"), notes SBA still provisions as Guest; the stale "Known limitation — entirely-revoked Guests not demoted" paragraph removed (it was the `gossbc` bug, now fixed).
- `extension/docs/sync-design.md` — locked-in decisions #5 (PR #184) and #6 (PR #181) annotated as superseded; discrepancy catalogue / severity / review-invariant / gate enumeration / fix-action catalogue updated to all-roles; the "Role-based grant-reconciliation scope" implementation note carries a superseded banner and is otherwise kept verbatim as historical record.
- `docs/TASKS.md` — T-60 annotated with the superseded gate; new **T-62** records the change.

`docs/architecture.md` and `docs/firebase-schema.md` needed no edits — neither referenced the Guest gate or `userRole`.

## Reverses

- **PR #181** — grant reconciliation scoped to Guests (`UserRole === 2`).
- **PR #184** — non-Guest present-but-unparseable downgraded to review-only.

## Next

The shared type (`KindooUnparseablePayload`) and the `applyKindooUnparseable` callable are untouched — this is a detector-side behavioural change only, no backend or shared-package work.
