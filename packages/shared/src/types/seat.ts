// `Seat` — `stakes/{stakeId}/seats/{canonicalEmail}` doc per
// `docs/firebase-schema.md` §4.6. One Seat per user per stake; the
// `scope` (singular) is the primary-grant scope that counts in
// utilization, and `duplicate_grants[]` is the informational record of
// other grants that didn't win the priority race.
//
// Per Q3 (resolved 2026-04-27) multi-calling people collapse to a
// single doc with `callings[]` so a member with two qualifying
// callings counts as one license, not two.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

/** The three seat kinds. Auto = importer-derived; manual/temp = request-completion. */
export type SeatType = 'auto' | 'manual' | 'temp';

/**
 * Informational duplicate-grant entry. Captures an additional grant
 * the import / request-completion flow saw but did not promote to
 * primary. Two kinds, distinguished by `kindoo_site_id`:
 *
 *   - Within-site priority loser — same `kindoo_site_id` as the seat's
 *     primary grant. Informational; the primary's write already covers
 *     access on that site.
 *   - Parallel-site grant — different `kindoo_site_id` from the
 *     primary. A legitimate independent grant on another Kindoo site
 *     that needs its own write to that site's Kindoo environment
 *     (T-42).
 *
 * Surfaces in the manager UI as a collision badge.
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
  /**
   * Buildings recorded against this duplicate grant. Parallel-site
   * duplicates (those whose `kindoo_site_id` differs from the seat's
   * primary) MUST set this — the per-site write to Kindoo needs the
   * site's own building set. Within-site duplicates (same
   * `kindoo_site_id` as primary) may still leave it unset and inherit
   * from the primary's ward — matching the pre-T-42 importer behaviour.
   * Manual/temp duplicates that originated from a request-completion
   * merge (extension v2.2 auto-merge path) populate this.
   */
  building_names?: string[];
  /**
   * Kindoo site the grant lives on. `null` (or field absent) means the
   * home site; a string value points at a doc ID under
   * `stakes/{stakeId}/kindooSites/`. Mirrors the ward / building
   * convention. T-42.
   */
  kindoo_site_id?: string | null;
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

  // ----- Kindoo site -----
  /**
   * Kindoo site the seat's primary grant lives on. `null` (or field
   * absent) means the home site; a string value points at a doc ID
   * under `stakes/{stakeId}/kindooSites/`. Stake-scope primary grants
   * resolve to home (spec §15 Phase 1 policy); ward-scope primary
   * grants take the ward's own `kindoo_site_id`. T-42.
   */
  kindoo_site_id?: string | null;

  // ----- Duplicates (informational) -----
  duplicate_grants: DuplicateGrant[];

  // ----- Bookkeeping -----
  created_at: TimestampLike;
  last_modified_at: TimestampLike;
  last_modified_by: ActorRef;
  lastActor: ActorRef;
};
