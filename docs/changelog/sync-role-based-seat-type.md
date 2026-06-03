# Sync — role-based seat type (`DepartmentType`) + any-church-grant ruleset

**Shipped:** 2026-06-03
**Commits:** PR #189 (`fix/sync-role-from-department-type`) — code `d492534` (role branch) + `0e1ecd6` (any-church-grant), docs (this commit)

## What shipped

The Sync detector now decides a seat's `type` (`auto` / `manual` / `temp`) by branching **first on the Kindoo role** — the `DepartmentType` enum carried on every bulk environment-user record — and only falls through to door-grant provenance for **Guests**. Two changes in one PR:

1. **Role branch (`DepartmentType`).** `DepartmentType`: **0 = Administrator, 1 = Manager, 2 = Guest, 3 = Installer.** `kindooRole` (`detector.ts`) maps it to three buckets — `admin` (Administrator / Manager), `guest` (Guest, or any role we couldn't read), `installer` — and the `detect()` branches key off it. Three behaviours:
   - **Installer (`3`) → skipped entirely.** No seat, no discrepancy row of any kind. One `continue` after the `sba-only` branch (which has no Kindoo user) and before every branch that needs a live Kindoo user.
   - **Administrator / Manager (`0` / `1`) → `auto`, forced.** A non-Guest role is admin-managed church-owned access, so the seat is `auto` regardless of grant backing — the Guest grant check is bypassed. Fires a `type-mismatch` PROMOTE when an existing seat isn't already `auto`. Any concrete `DepartmentType` other than `2`/`3` collapses to this bucket; `undefined`/missing → `guest` (conservative).
   - **Guest (`2`) → grant-based** (see #2).
2. **Any-church-grant correction.** The Guest grant predicate changed from **"all of the seat's building doors are church-direct-granted"** (the all-buildings strict subset) to **"the member holds ANY church-direct grant."** `isChurchBacked` / `grantsBackAuto` now take a single argument and reduce to `directGrantBuildings !== null && directGrantBuildings.length > 0`. The seat's own `building_names` no longer enter the type decision. Promote `manual → auto` on any church-direct grant; demote `auto → manual` only on **zero** church-direct grants (`[]`, not `null`).

Temp is unchanged throughout — `IsTempUser`-driven, orthogonal to role and grant provenance, never promoted / demoted.

## Why

- **Admins/Managers and Installers aren't Guests, and grant-only classification mis-handled them.** PR #187 had (correctly, for Guests) removed the role gate and run grant reconciliation for all roles. But a Kindoo Administrator/Manager holds church-owned access that doesn't show up as *guest* door grants, so the all-roles grant logic would compute `directGrantBuildings === []` for them and demote a legitimately-`auto` seat. And Installers are a 3rd-party access vendor that SBA shouldn't seat or reconcile at all. Branching on the role fixes both: only Guests are grant-decided.
- **`DepartmentType` is the reliable role signal.** The earlier role gate (PR #181, removed by #187) read a per-user `UserRole` off the door-grant rows, which was `undefined` for users with empty door rows — the exact failure that mis-skipped a real church-granted Guest. `DepartmentType` is present on every bulk environment-user record (verified live against the operator's environment), so the role branch reintroduced here doesn't carry #181's fragility.
- **Any church-direct grant, not all-buildings coverage.** A Guest with a calling holds at least one church-direct door even when they *also* carry some SBA-provisioned access on other buildings. The all-buildings subset rule classified such a mixed user `manual` (partial coverage ⇒ not church-backed), which was wrong — the church *is* provisioning them. "Any church-direct grant ⇒ auto" matches reality: only a Guest whose access is *entirely* SBA-provisioned is `manual`.

## What didn't change

- **The `directGrantBuildings` derivation.** `buildRuleDoorMap` → `deriveEffectiveRuleIds` (strict subset over church-granted doors) → `directGrantBuildings` is untouched. Only the predicate that *reads* it for the type decision changed (subset-of-seat-buildings → non-empty). `directGrantBuildings` still drives `buildings-mismatch` exactly as before.
- **The grantor-based church-grant signal (PR #188).** A door is a church direct grant by its `GrantedBy` (`sentry@groups.churchofjesuschrist.org` / `IsSuperApi`), not `AccessScheduleID`. Still holds — it's just now consumed only on the Guest path.
- **The per-check provenance-unknown skip.** A failed per-user door fetch leaves `directGrantBuildings === null` and the Guest type check is skipped (never demote on unknown provenance). A *successful* fetch with zero rows is `[]`, which demotes normally.
- **`buildings-mismatch` for all seat types.** It compares `derivedBuildings` (all doors, grant-agnostic), not `directGrantBuildings`, so it isn't role-gated; installers simply never reach it (skipped first).
- **`kindoo-unparseable` applies to all classified roles.** The present-but-unparseable → stake-scope Update-SBA row still fires for any role (a manager with an unparseable Description still gets it); only the *grant-based* type decision is Guest-scoped.
- **SBA still provisions every seat as a Guest** (`KindooInviteUserPayload.UserRole: 2`). `DepartmentType` is the role read back off the live roster.
- **No shared-type or callable change.** `DepartmentType` is internal to the extension's `KindooEnvironmentUser`; the `syncApplyFix` payloads and write paths are unchanged. The `type-mismatch` PROMOTE that now fires for admins uses the identical `newType` / `callings` payload.

## Deviations from the pre-change spec

None silently. `spec.md` §8 and `extension/docs/sync-design.md` described the seat-type decision as grant-only and all-roles, with the all-buildings subset predicate. Both are updated in this commit to the role-first ruleset and the any-church-grant predicate.

## Builds on

- **PR #187** — dropped the (door-row `UserRole`) Guest gate so grant reconciliation ran for all roles. #189 reintroduces a role branch, but on the reliable `DepartmentType` enum, and scopes the *grant* decision to Guests (admins force-auto, installers skipped) — the all-roles behaviour was right for Guests, wrong for the other roles.
- **PR #188** — church-direct grants identified by grantor (`GrantedBy`), not `AccessScheduleID`. #189 keeps that signal; it just feeds the corrected any-church-grant predicate.

## Spec / doc edits in this change

- `docs/spec.md` — §8: the "Grant-derived seat type" paragraph is replaced by "Seat type from Kindoo role, then door grants" — the `DepartmentType` enum table (0/1/2/3) and the full ordered ruleset (Installer skip → Temp → Admin/Manager force-auto → Guest: null=unchanged / any church-direct=auto / zero=manual), plus the promote-on-any / demote-on-zero rules. The §8 intro and the `type-mismatch` fix bullet updated to the role/grant target.
- `extension/docs/sync-design.md` — new "Kindoo role (`DepartmentType`) — the first branch" subsection under "Grant-derived seat type"; the discrepancy-detector table gains the installer-skip row and the role-branched `type-mismatch` row; "The detector" predicate corrected to any-church-grant (with the superseded all-buildings subset annotated); algorithm step 3, the `isChurchBacked` / `grantsBackAuto` / `kindoo-only created type` / `Zero-grant Guests never auto` implementation notes, and the (b) shipped-status + locked-in decision #6 reconciled to the role branch.
- `docs/TASKS.md` — new **T-64** records the change; T-62's all-roles note annotated.

`docs/architecture.md` and `docs/firebase-schema.md` needed no edits — neither describes the grant-derived type predicate, `directGrantBuildings`, or the role branch (firebase-schema.md's only Sync-type reference is the Stage-1a sort-order change).

## Deferred

- Stage 2 (auto-applied promote, revoke-on-promote, provision-time grant check) is unaffected — still pending per T-57.
- T-58 (temp-vs-non-temp divergence not detected) is unchanged — temp stays orthogonal to the role branch.
