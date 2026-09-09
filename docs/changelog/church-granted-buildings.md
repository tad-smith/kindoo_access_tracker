# Church-granted building provenance — an `edit_auto` can finally remove a building

**Shipped:** 2026-09-08
**Commits:** PR #301 (branch `feat/church-granted-buildings`, folding `feat/church-buildings-ext` and `feat/church-buildings-web`)

## What shipped

A seat grant now records which of its buildings the Church Access Automation grants directly, in a new `church_granted_buildings` field on `Seat` and on each `DuplicateGrant`. The `edit_auto` dialog reads it and stops locking the buildings a Kindoo Manager added by hand: those render checked but enabled, and unchecking one really removes it. Church-granted buildings stay locked, with copy that now says why — "granted by the Church — locked". The field is filled in by a new Sync drift code, `church-buildings-mismatch`, riding the existing detector → **Update SBA** → `syncApplyFix` path.

## Why

On an `auto` seat the Church-seeded ward building and any building a manager later added both live in the same `seat.building_names` array. `EditSeatDialog` had no way to tell them apart, so it locked all of them — a manager could add a building and never remove one. Spec Policy B recorded that as a deliberate "additions only" rule. It was not a product ruling; it was the honest UI for a data model that didn't know which half was which. The rationale Policy B gave — the `edit_auto` write REPLACES `building_names`, so silently dropping one would be destructive — is still true. The fix is to know which half is droppable, not to lock both.

The signal was already in the extension and already being discarded. `isChurchGrantedRow` (`extension/src/content/kindoo/endpoints.ts`) calls a door Church-granted by its **grantor** — `GrantedBy.Username === CHURCH_AUTOMATION_USERNAME`, or any `GrantedBy.IsSuperApi` — never by `AccessScheduleID`, and `enrichUsersWithDerivedBuildings` has been projecting that door subset into `directGrantBuildings` since the door-grant work landed. It has driven the `type-mismatch` promote/demote decision ever since. Nothing new is read from Kindoo. The observation is simply written down now.

## Decisions made

Recorded as `architecture.md` **D43**. The three that matter:

- **The field is tri-state and unknown means "assume all of it is Church-granted."** Absent / `null` means *never observed*, not "none"; `[]` is a real observation. Every consumer reads unknown in the direction that **locks** the UI, so an unstamped seat behaves exactly as it did before this shipped, and nothing unlocks by accident on deploy. The inverse field — recording manager-added buildings instead — carries the same information with the safe default flipped the wrong way, which is why it wasn't built.
- **Delivery is one more drift code, not a backfill.** No callable, no migration script, no new authenticated surface, no second writer of the field. Stamping production is: run Sync, click through the rows, once per Kindoo site. The operator chose one-time manual effort over permanent machinery deliberately. **This is the decision most likely to be "fixed" later by someone reading the drift row as a workaround — it isn't one.**
- **The check is last in the detector cascade,** after `callings-mismatch`. It fires for essentially every seat on a stake's first run, and a bookkeeping row that outranked a real scope or type drift would bury the drift under it. Every branch `continue`s, so a member still yields at most one row per run: the manager fixes the access first and the provenance row surfaces on a later run once nothing else is wrong.

## What didn't change that you'd expect to

- **No Firestore rules change.** The `seats.update` rule already confines client writes to `organization_id` (D21), so a new server-written seat field needed nothing. Worth stating explicitly, because "new seat field" normally implies a rules edit.
- **Same-scope non-auto `DuplicateGrant` buildings are still fully locked.** `edit_auto` cannot touch a dup, so unchecking one would no-op silently; Policy B's data-corruption rationale for keeping dup buildings out of the wire body is untouched. Their tooltip and note keep the original "already granted — locked" wording, which is still accurate for them. Only the auto-primary's half of the lock became conditional.
- **`buildings-mismatch` is unaffected.** It still sources from `derivedBuildings` (all doors), not `directGrantBuildings` (the Church-granted subset). The two sets have always been computed side by side from a single per-user door read.
- **The field is deliberately not clamped to `building_names`.** It records what Kindoo said. A name here that is missing from `building_names` is a `buildings-mismatch` the detector already reports; clamping on write would swallow exactly the disagreement the other code exists to surface. The one downstream consequence is that the building-rename guard (`seatReferencesBuilding`) had to learn to walk the new arrays, since an unclamped snapshot can hold a name `building_names` no longer does.
- **No new button, no new severity.** The row uses the plain **Update SBA** button its siblings use, because the fix is the same kind of thing they are — a seat field written through `syncApplyFix`.
- **No revocation risk to weigh.** A Church-direct grant is not an AccessSchedule, so SBA cannot revoke one whatever the seat says. `planEditSeat` replaces `building_names` wholesale and `provisionEdit` computes `ridsToRevoke` from the difference; the worst a wrong provenance stamp can do is a round-trip — the manager unchecks, the next Sync raises `buildings-mismatch`, the building comes back — never lost access.

## One deliberate divergence from the sibling handler

`applyChurchBuildingsMismatch` is modeled on `applyBuildingsMismatch` and slot-addressed the same way (`resolveGrantSlot` + `patchGrant`, per B-16 / B-24), but where `buildings-mismatch` refuses an empty array, this one **writes it**. `[]` means the Church grants nothing on that grant — which is precisely the observation that unlocks the dialog's controls for a seat a manager provisioned entirely themselves. Refusing it would leave those members permanently unstamped, the exact state the field exists to escape. Only a *failed* derivation is refused, and the detector already suppresses the row in that case; `buildCallableInput`'s throw is defensive parity, not a live path.

## Implementation

- `packages/shared/src/types/seat.ts` — `church_granted_buildings?: string[] | null` on `Seat` and on `DuplicateGrant`, with the tri-state contract in the doc comment on both. `packages/shared/src/types/syncApplyFix.ts` adds `ChurchBuildingsMismatchPayload` (`SurfacedGrantRef` + `memberEmail` + `churchGrantedBuildingNames`) to the discriminated union; `systemActors.ts` adds the code to `SYNC_DISCREPANCY_CODES` so the `SyncActor:church-buildings-mismatch` stamp classifies as automated.
- `extension/src/content/kindoo/sync/detector.ts` — check 9, last in the cascade. `SbaBlock.churchGrantedBuildings` is read off the **first** contributing grant rather than unioned across them the way `buildingNames` is, because it is the value the fix overwrites and the payload's `SurfacedGrantRef` names that same first contributor.
- `extension/src/content/kindoo/sync/fix.ts` — `fixActionsFor` returns the plain Update SBA button; `buildCallableInput` sends `directGrantBuildings` verbatim, empty array included.
- `functions/src/callable/syncApplyFix.ts` — `applyChurchBuildingsMismatch`; `patchGrant` gains the field on both the primary and duplicate branches.
- `apps/web/src/features/requests/components/EditSeatDialog.tsx` — `lockedAutoBuildingsFor` filters the auto-primary's contribution to the Church subset when the field is non-null and falls back to the whole array when null; `autoOwnedBuildingsFor` is renamed `churchLockedBuildingsFor` and narrowed the same way, which is what lets an unchecked manager-added building leave the wire body. Locked-checkbox copy branches on which lock applies.
- `apps/web/src/features/manager/configuration/hooks.ts` — `seatReferencesBuilding` walks the new arrays on both the primary and every duplicate.

## Doc edits

- `docs/architecture.md` — new decision **D43**.
- `docs/spec.md` — §6.1 Policy B rewritten (provenance-driven lock, the tri-state unknown case, the two sets, end-to-end removal safety); the seat-edit matrix row for "Auto, ward scope"; §8 gains the `church-buildings-mismatch` fix bullet.
- `docs/firebase-schema.md` — §4.6, the field on both `Seat` and the `duplicate_grants[]` entry shape.
- `extension/docs/sync-design.md` — detector table (two rows: the check and its skip), severity list, fix-action catalogue, detector check order, and the first-contributor rule for `SbaBlock.churchGrantedBuildings`.
- `docs/user-guide/creating-requests.html` — §8 no longer says an automatic seat's buildings can't be removed; adds the "everything is greyed out" callout for the unstamped case.
- `docs/user-guide/kindoo-managers.html` — the drift-row table gains the code, plus a callout explaining why the first run lists so many of them and why there is no bulk button.
- Root `CLAUDE.md` — shipped-feature entry under Open follow-ups.

## Deferred

Nothing was deferred. The one thing to know is operational: **until a stake works through its `church-buildings-mismatch` rows, none of its edit dialogs change behaviour.** That is by construction, not a rollout gap.
