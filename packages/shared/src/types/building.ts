// `Building` — `stakes/{stakeId}/buildings/{buildingId}` doc per
// `docs/firebase-schema.md` §4.3. Doc ID is the URL-safe slug of
// `building_name` (see `packages/shared/src/buildingSlug.ts`).

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

// Extension v2.1 — the Kindoo Access Rule mapped to this SBA building.
// One rule per building, picked by the manager from the Kindoo admin
// UI's existing rule list (the extension does not create rules).
export type KindooBuildingRule = {
  /** Kindoo's internal rule id (`RID`). */
  rule_id: number;
  /** Display name captured at config time. Re-fetched/repaired on reconfigure. */
  rule_name: string;
};

export type Building = {
  /** `= doc.id`. Slug derived from `building_name` via `buildingSlug()`. */
  building_id: string;
  /** Display name (`'Cordera Building'`). The natural key wards reference by string. */
  building_name: string;
  address: string;

  /** Optional; absent until v2.1 maps a Kindoo Access Rule for the building. */
  kindoo_rule?: KindooBuildingRule;

  created_at: TimestampLike;
  last_modified_at: TimestampLike;
  lastActor: ActorRef;
};
