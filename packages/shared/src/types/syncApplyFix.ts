// Input / output shapes for the `syncApplyFix` callable invoked from the
// Chrome MV3 extension's Sync Phase 2 drift report. Each per-row Fix
// click in the extension dispatches one callable invocation; the
// payload encodes which discrepancy code triggered the fix and the
// minimal data needed to apply it on the SBA side. See
// `extension/docs/sync-design.md` for the discrepancy catalogue.
//
// Codes split by which side gets written. Only the SBA-side-write codes
// flow through this callable; the Kindoo-side-write codes are applied by
// the extension's provision orchestrator and never reach the backend.
//
//   - `kindoo-only`            → create a new SBA seat.
//   - `extra-kindoo-calling`   → append unmatched callings to an
//                                existing SBA seat's `callings[]`.
//   - `scope-mismatch`         → update seat `scope` only.
//   - `type-mismatch`          → update seat `type` only.
//   - `buildings-mismatch`     → replace seat `building_names` wholesale.
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

/** Payload for the `type-mismatch` fix (sync direction: kindoo-to-sba). */
export type TypeMismatchPayload = {
  memberEmail: string;
  newType: SeatType;
};

/** Payload for the `buildings-mismatch` fix (sync direction: kindoo-to-sba).
 * Replaces `building_names` wholesale (no merge). */
export type BuildingsMismatchPayload = {
  memberEmail: string;
  newBuildingNames: string[];
};

/** Discriminated union — one `code` + matching `payload` per call. */
export type SyncApplyFixInput = {
  stakeId: string;
  fix:
    | { code: 'kindoo-only'; payload: KindooOnlyPayload }
    | { code: 'extra-kindoo-calling'; payload: ExtraKindooCallingPayload }
    | { code: 'scope-mismatch'; payload: ScopeMismatchPayload }
    | { code: 'type-mismatch'; payload: TypeMismatchPayload }
    | { code: 'buildings-mismatch'; payload: BuildingsMismatchPayload };
};

/** Soft-failure envelope. The callable returns `{ success: false }` for
 * domain-level misses (no matching seat, seat already exists) and throws
 * an `HttpsError` for auth / shape errors. */
export type SyncApplyFixResult =
  | { success: true; seatId: string }
  | { success: false; error: string };
