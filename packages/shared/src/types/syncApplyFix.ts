// Input / output shapes for the `syncApplyFix` callable invoked from the
// Chrome MV3 extension's Sync Phase 2 drift report. Each per-row Fix
// click in the extension dispatches one callable invocation; the
// payload encodes which discrepancy code triggered the fix and the
// minimal data needed to apply it on the SBA side. See
// `extension/docs/sync-design.md` for the discrepancy catalogue.
//
// Kindoo is the authoritative source: sync never writes SBA → Kindoo.
// Provisioning into Kindoo flows through SBA requests, not sync. The
// only SBA-side mutation sync performs is to mutate or delete an
// existing SBA seat to track Kindoo's state. Every code below flows
// through this callable:
//
//   - `kindoo-only`            → create a new SBA seat.
//   - `extra-kindoo-calling`   → append unmatched callings to an
//                                existing SBA seat's `callings[]`.
//   - `scope-mismatch`         → update seat `scope` only.
//   - `type-mismatch`          → update seat `type` only.
//   - `kindoo-unparseable`     → SBA-side update: a present-but-unparseable
//                                Kindoo Description is treated as a
//                                church-wide calling — move the seat to
//                                stake scope and set the calling from the
//                                raw description text.
//   - `buildings-mismatch`     → replace seat `building_names` wholesale.
//   - `sba-only`               → delete an orphaned SBA seat (an SBA
//                                seat with no Kindoo presence). Kindoo
//                                is authoritative, so the seat is stale.
//                                Surfaced as "Remove From SBA" in the
//                                drift UI. (Was a Kindoo-side write —
//                                "Provision in Kindoo" — before the
//                                Kindoo-authoritative shift.)
//
// Single-axis updates are intentional: the operator picks each axis
// independently in the drift UI. If two axes are misaligned on the same
// seat, the second drift row re-emits on the next sync run.

import type { SeatType } from './seat.js';

/** Payload for the `kindoo-only` discrepancy fix. Creates a new SBA seat. */
export type KindooOnlyPayload = {
  /** Raw (typed) email — server canonicalizes. */
  memberEmail: string;
  /** Display name to stamp on the new seat. */
  memberName: string;
  /** `'stake'` or a ward_code. */
  scope: string;
  type: SeatType;
  /** Matched auto callings, or comma-split free-text from manual seats. */
  callings: string[];
  /** Buildings derived by the extension from the intended shape. */
  buildingNames: string[];
  /** Free-text reason for manual/temp seats. Dropped for auto. */
  reason?: string;
  /** ISO date `YYYY-MM-DD` — temp only. */
  startDate?: string;
  /** ISO date `YYYY-MM-DD` — temp only. */
  endDate?: string;
  /** Reserved — Kindoo's temp-user flag carried through for parity. */
  isTempUser: boolean;
};

/** Payload for the `extra-kindoo-calling` fix. Appends to existing seat's
 * `callings[]` (de-duped, existing preserved). */
export type ExtraKindooCallingPayload = {
  /** Raw (typed) email — server canonicalizes. */
  memberEmail: string;
  /** Callings to add. Dedup happens server-side. */
  extraCallings: string[];
};

/** Payload for the `scope-mismatch` fix (sync direction: kindoo-to-sba). */
export type ScopeMismatchPayload = {
  memberEmail: string;
  /** `'stake'` or a ward_code. */
  newScope: string;
};

/** Payload for the `type-mismatch` fix (sync direction: kindoo-to-sba).
 *
 * Grant-derived promote (`manual`/`temp` → `auto`) / demote (`auto` →
 * `manual`/`temp`). Beyond flipping `type`, the callable reshapes the
 * seat to the spec §6.1 convention for the target type: an `auto` seat
 * carries its calling(s) in `callings[]` with an empty `reason`; a
 * `manual` seat carries `callings: []` with the calling in free-text
 * `reason`.
 *
 * `callings` is the Kindoo-parsed calling(s) for the seat, sent by the
 * extension on **promote** so the resulting auto seat is well-formed
 * (populated `callings[]`, no stale `reason`). Optional / may be empty:
 * on demote it is ignored (the calling is sourced from the seat's
 * existing `callings[]`); on promote an empty / absent value falls back
 * to `[seat.reason]` when the seat carries a non-empty reason, else
 * `[]`. */
export type TypeMismatchPayload = {
  memberEmail: string;
  newType: SeatType;
  /**
   * Kindoo-parsed calling(s) for the seat. Sent on PROMOTE
   * (`newType: 'auto'`) — the calling(s) the promoted auto seat should
   * carry in its roster `callings[]`; the backend sets `callings[]` from
   * this and clears `reason`. Omitted on DEMOTE (`newType: 'manual'`),
   * where the backend derives `reason` from the seat's existing
   * `callings[]`. Absent / empty ⇒ the backend leaves `callings[]`
   * untouched.
   */
  callings?: string[];
};

/** Payload for the `buildings-mismatch` fix (sync direction: kindoo-to-sba).
 * Replaces `building_names` wholesale (no merge). */
export type BuildingsMismatchPayload = {
  memberEmail: string;
  newBuildingNames: string[];
};

/** Payload for the `sba-only` fix. Kindoo is authoritative, so an SBA
 * seat with no Kindoo presence is an orphan — this deletes it. */
export type SbaOnlyRemovePayload = {
  /** Raw (typed) email — server canonicalizes to locate the seat. */
  memberEmail: string;
};

/** Payload for the `kindoo-unparseable` fix. A Kindoo Description that
 * is present but doesn't parse as `Scope (Calling)` is treated as a
 * church-wide calling: the seat is moved to stake scope and the calling
 * is set from the raw Kindoo description text. */
export type KindooUnparseablePayload = {
  /** Raw (typed) email — server canonicalizes to locate the seat. */
  memberEmail: string;
  /** The church-wide calling text, taken from the raw Kindoo description. */
  calling: string;
};

/** Discriminated union — one `code` + matching `payload` per call. */
export type SyncApplyFixInput = {
  stakeId: string;
  fix:
    | { code: 'kindoo-only'; payload: KindooOnlyPayload }
    | { code: 'extra-kindoo-calling'; payload: ExtraKindooCallingPayload }
    | { code: 'scope-mismatch'; payload: ScopeMismatchPayload }
    | { code: 'type-mismatch'; payload: TypeMismatchPayload }
    | { code: 'kindoo-unparseable'; payload: KindooUnparseablePayload }
    | { code: 'buildings-mismatch'; payload: BuildingsMismatchPayload }
    | { code: 'sba-only'; payload: SbaOnlyRemovePayload };
};

/** Soft-failure envelope. The callable returns `{ success: false }` for
 * domain-level misses (no matching seat, seat already exists) and throws
 * an `HttpsError` for auth / shape errors. */
export type SyncApplyFixResult =
  | { success: true; seatId: string }
  | { success: false; error: string };
