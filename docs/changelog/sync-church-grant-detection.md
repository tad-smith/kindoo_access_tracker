# Sync — church-direct grants identified by grantor, not `AccessScheduleID`

**Shipped:** 2026-06-03
**Commits:** PR #188 (`fix/sync-church-grant-detection`) — code `b472cde` + `0d1a581`, docs (this commit)

## What shipped

The Sync detector now recognises a Church Access Automation **direct grant** by its **grantor**, not by `AccessScheduleID`. A door-grant row is church-granted when `GrantedBy.Username` is the church automation account (`sentry@groups.churchofjesuschrist.org`, the new exported const `CHURCH_AUTOMATION_USERNAME`) or `GrantedBy.IsSuperApi === true` — the predicate `isChurchGrantedRow` in `endpoints.ts`. `UserDoorGrantRow.accessScheduleId` is replaced by a `churchGranted: boolean`; `buildingsFromDoors` derives the `direct` / `directGrantBuildings` set from that flag. The `all` / `derivedBuildings` set (every door the user can open) is unchanged.

## The bug

PR #179 keyed "this door is a church direct grant" off `AccessScheduleID === 0`. That was wrong: real church grants carry **`AccessScheduleID: -1`**, not `0`. With the `=== 0` test, no church grant was ever recognised → `directGrantBuildings` came back **empty** for church-backed users → `isChurchBacked` returned false → auto seats whose building doors are fully backed by Church Access Automation grants were classified `!church-backed` and **falsely demoted `auto → manual`**.

`AccessScheduleID` simply isn't the auto/manual signal. The grantor is: the church owns the grant (`auto`) when the door's `GrantedBy` is the Church Access Automation or any super-API grantor; otherwise SBA/a manager owns it via an AccessRule (`manual`). The grantor field was already in hand — the per-user door fetch already requests it via `FetchGrantedByData: 'true'`.

## Why it surfaced now (latent on `main`)

The defect was latent on `main` since PR #179. PR #181 had scoped grant reconciliation to Kindoo Guests by reading a per-user `UserRole`; the affected church-granted users were skipped under that gate, so the empty `directGrantBuildings` never reached a demote decision. **PR #187 dropped the Guest gate** and ran grant reconciliation for all seat roles — which removed the mask and exposed the false demotes. So the user-visible regression rode in on #187, but the root cause predates it. Fixing the gate (#187) was correct; this change fixes the detection the gate had been hiding.

## What changed

- `endpoints.ts` — new `export const CHURCH_AUTOMATION_USERNAME`; new `isChurchGrantedRow(GrantedBy)` (account-match or `IsSuperApi`); `UserDoorGrantRow.accessScheduleId: number` → `churchGranted: boolean`; the per-door collapse now prefers the **church** grant (`churchGranted: true` wins, order-independent) instead of preferring `accessScheduleId: 0`.
- `buildingsFromDoors.ts` — `getUserDoorGrants` partitions `direct` from the `churchGranted` flag instead of `accessScheduleId === 0`; `directGrantBuildings` is the strict-subset over the church-granted door subset.
- `detector.ts` — the `directGrantBuildings` doc comment now points at the `GrantedBy` signal and notes real church grants carry `AccessScheduleID: -1`.

## What didn't change

- The strict-subset coverage algorithm (`deriveEffectiveRuleIds`, `isChurchBacked`, `grantsBackAuto`) — only the per-door provenance predicate it consumes changed.
- `derivedBuildings` (the all-doors effective-access set) — door membership is grantor-agnostic, so it is untouched.
- The per-check provenance-unknown skips — a failed per-user door fetch still nulls `directGrantBuildings` / `derivedBuildings` and skips the relevant check.
- No shared-type or callable change. `UserDoorGrantRow` is internal to the extension; the `syncApplyFix` payloads are unaffected.

## Deviations from the pre-change spec

None silently. `spec.md` §8 and `extension/docs/sync-design.md` described the church direct-grant signal as `AccessScheduleID === 0`; both are corrected in this commit to the grantor-based signal.

## Spec / doc edits in this change

- `docs/spec.md` — §8 "Grant-derived seat type": church direct grants are identified by grantor (Church Access Automation account / `IsSuperApi`), not `AccessScheduleID` (real church grants are `-1`).
- `extension/docs/sync-design.md` — "The detector" section algorithm, the (b) shipped-status paragraph, and the "Prefer-church door dedup" implementation note: `AccessScheduleID === 0` → grantor-based `churchGranted`; `directDoorIds` → `churchDoorIds`; the auto-user buildings-derivation note. The one surviving `AccessScheduleID` mention is the corrected "`-1`, not the signal" clarification.
- `docs/TASKS.md` — T-62 (b) bullet annotated with the correction; new **T-63** records the change.

`docs/architecture.md` and `docs/firebase-schema.md` needed no edits — neither described the door-grant → direct-grant derivation in terms of `AccessScheduleID`.
