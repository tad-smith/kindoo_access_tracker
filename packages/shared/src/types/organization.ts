// `Organization` — `stakes/{stakeId}/organizations/{orgId}` doc. A
// stake-scope concept: a named pool with its own seat cap, managed by
// stake managers. Seats and requests reference an organization by its
// immutable slug id (`organization_id`), NOT by name (unlike the
// `building_names` snapshot arrays) — renames resolve id→name at render
// time.
//
// `organization_id` is meaningful only on stake-scope grants; `null` /
// absent on a seat or request means "No Organization".

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

export type Organization = {
  /** `= doc.id`. Immutable slug derived from `name` via `buildingSlug()`. */
  organization_id: string;
  /** Display name. Resolved from `organization_id` at render time. */
  name: string;
  /** Per-organization seat cap, surfaced as a utilization bar. */
  seat_cap: number;

  created_at: TimestampLike;
  last_modified_at: TimestampLike;
  lastActor: ActorRef;
};
