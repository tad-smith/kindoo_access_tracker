// `KindooManager` — `stakes/{stakeId}/kindooManagers/{canonicalEmail}`
// doc per `docs/firebase-schema.md` §4.4. The presence of an `active`
// doc here is what `syncManagersClaims` uses to set
// `stakes[stakeId].manager = true` on the user's auth token.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

export type KindooManager = {
  /** `= doc.id`. Canonical email. */
  member_canonical: string;
  /** Typed display email. */
  member_email: string;
  /** Display name (free-text from the wizard / Configuration page). */
  name: string;
  /**
   * Whether the manager grant is currently in effect. Setting this to
   * `false` does NOT delete the doc — it leaves an audit trail. The
   * sync trigger only stamps the manager claim when `active === true`.
   */
  active: boolean;

  added_at: TimestampLike;
  added_by: ActorRef;
  lastActor: ActorRef;
};
