// `Seat` — `stakes/{stakeId}/seats/{canonicalEmail}` doc per
// `docs/firebase-schema.md` §4.6. One Seat per user per stake; the
// `scope` (singular) is the primary-grant scope that counts in
// utilization, and `duplicate_grants[]` is the informational record of
// other grants that didn't win the priority race.
//
// Per Q3 (resolved 2026-04-27) multi-calling people collapse to a
// single doc with `callings[]` — fixes the Apps Script over-count
// where one row per calling could yield two seats for one license.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

/** The three seat kinds. Auto = importer-derived; manual/temp = request-completion. */
export type SeatType = 'auto' | 'manual' | 'temp';

/**
 * Informational duplicate-grant entry. Captures a cross-scope or
 * cross-type grant that the import / request-completion flow saw but
 * did not promote to primary. Surfaces in the manager UI as a
 * collision badge.
 */
export type DuplicateGrant = {
  scope: string;
  type: SeatType;
  callings?: string[];
  reason?: string;
  /** ISO date `YYYY-MM-DD` — temp grants only. */
  start_date?: string;
  /** ISO date `YYYY-MM-DD` — temp grants only. */
  end_date?: string;
  detected_at: TimestampLike;
};

export type Seat = {
  // ----- Identity -----
  /** `= doc.id`. Canonical email. */
  member_canonical: string;
  /** Typed display email. */
  member_email: string;
  /** Display name. */
  member_name: string;

  // ----- Primary grant -----
  /** `'stake'` or a ward_code. The pool that counts in utilization. */
  scope: string;
  type: SeatType;
  /**
   * For `type='auto'` only — the list of callings that earn this user
   * the seat. ≥1 entry. For `'manual'` / `'temp'` this is `[]`.
   */
  callings: string[];
  /** Free-text reason for `'manual'` / `'temp'` seats; absent on `'auto'`. */
  reason?: string;
  /** ISO date `YYYY-MM-DD` — `'temp'` only. */
  start_date?: string;
  /** ISO date `YYYY-MM-DD` — `'temp'` only. */
  end_date?: string;
  building_names: string[];

  // ----- Manual/temp linkage -----
  /** Request UUID that justifies this seat. Absent for `type='auto'`. */
  granted_by_request?: string;

  // ----- Sort priority -----
  /**
   * Denormalised from the matched calling template's `sheet_order` so
   * roster pages can sort auto seats by template priority without a
   * per-page template lookup. Importer-populated for `type='auto'`
   * (MIN across `callings[]`); `null` for `'manual'` / `'temp'` seats
   * and for auto-orphans whose calling no longer matches any template.
   * Web-side sort treats `null` / missing as "after all numbered
   * entries within the auto section."
   */
  sort_order?: number | null;

  // ----- Duplicates (informational) -----
  duplicate_grants: DuplicateGrant[];

  // ----- Bookkeeping -----
  created_at: TimestampLike;
  last_modified_at: TimestampLike;
  last_modified_by: ActorRef;
  lastActor: ActorRef;
};
