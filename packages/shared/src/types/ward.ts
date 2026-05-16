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
  /** FK to `stakes/{stakeId}/buildings/*`, by `building_name` natural key. */
  building_name: string;
  /** Per-ward Kindoo seat cap. */
  seat_cap: number;
  /**
   * Kindoo site this ward belongs to. `null` (or absent) means the
   * home site (the SBA stake's own Kindoo environment, captured on
   * `stake.kindoo_config`); a string value points at a doc id under
   * `stakes/{stakeId}/kindooSites/`. Phase 1 stores the value;
   * downstream phases consume it (form filters, extension
   * orchestrator, sync filters).
   */
  kindoo_site_id?: string | null;

  created_at: TimestampLike;
  last_modified_at: TimestampLike;
  lastActor: ActorRef;
};
