// `Building` — `stakes/{stakeId}/buildings/{buildingId}` doc per
// `docs/firebase-schema.md` §4.3. Doc ID is the URL-safe slug of
// `building_name` (see `packages/shared/src/buildingSlug.ts`).

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

export type Building = {
  /** `= doc.id`. Slug derived from `building_name` via `buildingSlug()`. */
  building_id: string;
  /** Display name (`'Cordera Building'`). The natural key wards reference by string. */
  building_name: string;
  address: string;

  created_at: TimestampLike;
  last_modified_at: TimestampLike;
  lastActor: ActorRef;
};
