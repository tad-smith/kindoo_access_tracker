// `Ward` — `stakes/{stakeId}/wards/{wardCode}` doc per
// `docs/firebase-schema.md` §4.2. Doc ID is the 2-letter `ward_code`
// (matches the LCR Sheet tab name).

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

export type Ward = {
  /** `= doc.id`. The 2-letter LCR tab code. */
  ward_code: string;
  /** Display name (`"3rd Ward"`, etc.). */
  ward_name: string;
  /**
   * Preferred FK to `stakes/{stakeId}/buildings/{building_id}` by the
   * immutable building slug. Optional during the additive transition;
   * new writes always populate it. Resolution prefers this over
   * `building_name` (see `resolveWardBuilding`).
   */
  building_id?: string;
  /**
   * Legacy display-name FK + display snapshot. Still required and kept
   * populated during the transition so stale browser bundles and the
   * migration window keep resolving. New writes set it to the building's
   * current display name alongside `building_id`. Dropping it from wards
   * is a deliberate later follow-up.
   */
  building_name: string;
  /** Per-ward Kindoo seat cap. */
  seat_cap: number;

  created_at: TimestampLike;
  last_modified_at: TimestampLike;
  lastActor: ActorRef;
};
