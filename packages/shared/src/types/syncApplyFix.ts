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
//   - `kindoo-only`            → create a new SBA seat, or — when the
//                                member already holds one whose grants
//                                all live on other Kindoo sites — merge
//                                the grant onto it as a parallel-site
//                                `duplicate_grants[]` entry (B-23).
//   - `callings-mismatch`      → REPLACE an auto seat's `callings[]` with
//                                Kindoo's parsed calling(s) (Kindoo is
//                                authoritative; a renamed calling replaces
//                                the old name, it does not sit beside it).
//                                Sibling of `scope-mismatch` /
//                                `buildings-mismatch`. Reconciles the
//                                scope's `importer_callings`.
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

/**
 * Which grant a per-row fix should write (B-16 / B-24).
 *
 * A Sync row is a per-SITE projection: a seat surfaces through its primary
 * OR through a `duplicate_grants[]` entry on the active site. Without this,
 * every handler wrote the primary, so a duplicate-surfaced row mutated a
 * grant the operator was not looking at — restaking their home grant,
 * reaping its access, or replacing its buildings with another site's.
 *
 * Both fields come off the row's `sba` block, which IS the projection.
 *
 * **Optional for version skew only.** An extension predating them sends
 * neither and keeps the historical primary-writing behaviour, which is
 * correct whenever the row came from the primary. `scope` naming a grant
 * the seat doesn't hold is a soft failure, never a fallback to the primary.
 */
export type SurfacedGrantRef = {
  /** Scope of the surfaced grant. Absent ⇒ the primary. */
  scope?: string;
  /** Its Kindoo site — `null` home, a site id foreign. Tiebreaker only. */
  kindooSiteId?: string | null;
};

/** Payload for the `kindoo-only` discrepancy fix. Creates a new SBA
 * seat, or merges the grant onto the member's existing seat when one is
 * already there (B-23). */
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
  /**
   * The Kindoo site the drift row was surfaced from — `null` home, a
   * site id for a foreign site. **Absence is load-bearing.**
   *
   * The merge-onto-existing-seat behaviour (B-23) is a SERVER change,
   * but everything that makes it safe ships in the EXTENSION:
   * `createScope`, the duplicate-surfaced withholding, and `sba-only`'s
   * `(scope, kindooSiteId)`. Functions deploy in minutes; the extension
   * goes through Chrome Web Store review and then updates on each
   * manager's own schedule, so "deploy the extension first" is not
   * enforceable (`firebase-schema.md` §3.4 already treats the
   * independent cadence as a hard constraint).
   *
   * A build predating those guards omits this field, and the callable
   * then refuses to merge — it keeps the pre-B-23 `seat already exists`
   * soft failure, which is loud and harmless. So the server change
   * cannot outrun the client guards no matter what order anything ships
   * in. Present ⇒ the caller also has the guards, and the callable can
   * additionally verify the payload's scope really lives on this site.
   */
  activeSiteId?: string | null;
};

/** Payload for the `callings-mismatch` fix. REPLACES an auto seat's
 * `callings[]` wholesale with Kindoo's parsed calling(s) (Kindoo is
 * authoritative), then reconciles the scope's `importer_callings`. */
export type CallingsMismatchPayload = SurfacedGrantRef & {
  /** Raw (typed) email — server canonicalizes. */
  memberEmail: string;
  /** The FULL target set = Kindoo's parsed calling(s). Replaces the
   * seat's prior `callings[]` (not a delta). Dedup happens server-side. */
  callings: string[];
};

/** Payload for the `scope-mismatch` fix (sync direction: kindoo-to-sba). */
export type ScopeMismatchPayload = SurfacedGrantRef & {
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
export type TypeMismatchPayload = SurfacedGrantRef & {
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
export type BuildingsMismatchPayload = SurfacedGrantRef & {
  memberEmail: string;
  newBuildingNames: string[];
};

/** Payload for the `sba-only` fix. Kindoo is authoritative, so an SBA
 * seat with no Kindoo presence is an orphan — this deletes it. */
export type SbaOnlyRemovePayload = {
  /** Raw (typed) email — server canonicalizes to locate the seat. */
  memberEmail: string;
  /**
   * The scope of the grant the drift row was surfaced FROM (B-24).
   *
   * A Sync row is a per-site projection: a seat contributes through its
   * primary or through any `duplicate_grants[]` entry on that site.
   * Without this the callable could only guess, and its multi-grant
   * branch guessed `duplicate_grants[0]` — promoting a revoked grant over
   * a live primary. With it, a row surfaced from a duplicate drops that
   * duplicate and leaves the primary alone.
   *
   * Optional for version skew only: an extension predating this field
   * sends nothing and gets the old delete-or-promote behaviour, which is
   * correct whenever the row came from the primary (the common case).
   */
  scope?: string;
  /**
   * Kindoo site of that same grant — `null` for home, a site id for a
   * foreign site, omitted when the client can't resolve it. Used only to
   * disambiguate when more than one grant on the seat carries `scope`;
   * scope alone identifies the grant in every shape seen in practice.
   */
  kindooSiteId?: string | null;
};

/** Payload for the `kindoo-unparseable` fix. A Kindoo Description that
 * is present but doesn't parse as `Scope (Calling)` is treated as a
 * church-wide calling: the seat is moved to stake scope and the calling
 * is set from the raw Kindoo description text. */
export type KindooUnparseablePayload = SurfacedGrantRef & {
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
    | { code: 'callings-mismatch'; payload: CallingsMismatchPayload }
    | { code: 'scope-mismatch'; payload: ScopeMismatchPayload }
    | { code: 'type-mismatch'; payload: TypeMismatchPayload }
    | { code: 'kindoo-unparseable'; payload: KindooUnparseablePayload }
    | { code: 'buildings-mismatch'; payload: BuildingsMismatchPayload }
    | { code: 'sba-only'; payload: SbaOnlyRemovePayload };
};

/** Soft-failure envelope. The callable returns `{ success: false }` for
 * domain-level misses (no matching seat) and throws an `HttpsError` for
 * auth / shape errors. */
export type SyncApplyFixResult =
  | { success: true; seatId: string }
  | { success: false; error: string };
