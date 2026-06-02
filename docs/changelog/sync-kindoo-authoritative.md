# Sync — Kindoo-authoritative (no SBA → Kindoo writes)

**Shipped:** 2026-06-02
**Commits:** PR #183 (`feat/sync-kindoo-authoritative`) — backend `8358576`, extension `60ba6ae`, docs (this commit)

## What shipped

The extension's Sync feature is now strictly one-directional: **Kindoo is the authoritative source, and Sync never writes SBA → Kindoo.** Every per-row fix is an SBA-side mutation that reconciles the SBA seat to Kindoo's observed state. Provisioning *into* Kindoo (inviting a user, writing AccessSchedules) flows exclusively through the request-driven provision orchestrator (`provision.ts`), as it always did — Sync no longer has a Kindoo-write path at all.

Concretely:

- The `sba-only` discrepancy (an SBA seat with no matching Kindoo user) now offers a single danger action, **"Remove From SBA"**, backed by a new `sba-only` delete path in the `syncApplyFix` callable. An SBA seat with no Kindoo presence is an orphan — the authority doesn't have it — so the callable deletes it. The delete mirrors `removeSeatOnRequestComplete`: a plain `tx.delete` for the common orphan; promote-the-first-`duplicate_grants[]`-entry-to-primary when the seat carries parallel-site grants that must not be nuked. (This replaces the old Kindoo-side "Provision in Kindoo" write.)
- `scope-mismatch` and `buildings-mismatch` rows lose their **"Update Kindoo"** buttons; only **"Update SBA"** remains. (`type-mismatch` was already Update-SBA-only since the grant-derived Stage 1 work.)
- All `side: 'kindoo'` fix actions are gone. The CS-side `extension/src/content/kindoo/sync-provision.ts` orchestrator (and its `unionSeatBuildings` helper) was **deleted**. `fix.ts` lost its Kindoo-write branch (`dispatchKindooFix`, `synthesizeSeatFromBlocks`, the Kindoo-only `DispatchContext` fields).
- Shared types gained `SbaOnlyRemovePayload` + a `{ code: 'sba-only' }` member on the `SyncApplyFixInput` union, and `sba-only` was added to `SYNC_DISCREPANCY_CODES` so it stamps a `SyncActor:sba-only` audit attribution like every other Sync write.

## Why

Sync's job is to detect drift between SBA and Kindoo and converge it. Writing in both directions made "which side is the truth" ambiguous per-discrepancy and required maintaining a second Kindoo-write orchestrator (`sync-provision.ts`) parallel to the request-driven `provision.ts`. Settling on **Kindoo as authoritative** collapses the model: Kindoo's state (which Church Access Automation already populates from LCR) is ground truth for who should hold a seat; SBA seats that don't match get created, mutated, or deleted to follow. Provisioning genuinely new access into Kindoo is a deliberate operator act that belongs on the request flow, not an inferred side-effect of a drift scan. Removing the Kindoo-write path also deletes the only Sync code that could mint or rewrite Kindoo grants from a detector heuristic — a safer failure surface.

The orphan-delete attribution uses the Expiry-style stamp-then-delete (stamp `lastActor: SyncActor:sba-only` in one committed write, then delete) so the `auditSeatWrites` trigger reads the stamped BEFORE snapshot and attributes the `delete_seat` row to the Sync actor. A bare delete inside a single transaction would carry the seat's *prior* actor in BEFORE and mis-attribute the row.

## Known limitation (deliberate)

The `sba-only` delete intentionally **leaves the member's `access/{canonical}` doc untouched**. This matches the existing `removeSeatOnRequestComplete` precedent, which also does not reap the access doc on seat removal. It is a deliberate choice for consistency with the remove-trigger semantics, not a defect. Reaping the orphaned access doc is a possible future follow-up if stale `access` docs become operationally visible.

## What didn't change that you'd expect to

- **The request-driven provision orchestrator (`provision.ts`) is untouched.** Kindoo-authoritative governs *Sync*, not requests. Inviting users and writing AccessSchedules into Kindoo still happens on request completion exactly as before. The within-site `building_names` union that used to be named `unionSeatBuildings` in `sync-provision.ts` already had an independent in-line implementation in `provision.ts`; deleting the sync orchestrator removed only the dead duplicate.
- **The Sync READ path is fully intact** — env-user listing, rule/door map, derived-buildings enrichment, env metadata. Detection is unchanged; only the fix-write direction changed.
- **`type-mismatch` behaviour is unchanged.** It was already Update-SBA-only after the grant-derived Stage 1 work; this PR only removed the *other* mismatches' Kindoo buttons to match.

## Spec / doc edits

- `docs/spec.md` — §8 gains a "Kindoo is authoritative; Sync never writes SBA → Kindoo" block enumerating each discrepancy's now-SBA-only fix (including `sba-only` → Remove From SBA and the access-doc-not-reaped note). §15 "Within-site union" repointed from the deleted `sync-provision.ts`/`unionSeatBuildings` to `provision.ts`.
- `extension/docs/sync-design.md` — Phase 2 fix-action catalogue + direction-of-truth rewritten (no Kindoo-side writes; `sba-only` = Remove From SBA; mismatches = Update SBA only); Audit subsection updated (every fix now lands an SBA write + audit row); Files subsection records the retired `sync-provision.ts`; Out-of-scope updated.
- `extension/CLAUDE.md` — module tree: `sync-provision.ts` removed; `provision.ts` annotated as the only SBA → Kindoo write path; `fix.ts` annotated SBA-side-callable-only.
- `docs/TASKS.md` — T-49 records the cross-workspace shared-type addition (`SbaOnlyRemovePayload` + union member + `SYNC_DISCREPANCY_CODES` entry), closed.

## Deferred

- Reaping the orphaned `access/{canonical}` doc on `sba-only` delete → future follow-up (see Known limitation above).
