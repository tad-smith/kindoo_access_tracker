// `WardCallingTemplate` and `StakeCallingTemplate` —
// `stakes/{stakeId}/wardCallingTemplates/{callingName}` and
// `stakes/{stakeId}/stakeCallingTemplates/{callingName}` per
// `docs/firebase-schema.md` §§4.8–4.9. Same shape; the path
// distinguishes which Sheet tab the importer matches against (ward
// tabs vs the stake tab).
//
// Doc ID is the URL-encoded calling name so wildcard rows like
// `Counselor *` can round-trip safely (the literal `*` survives URL
// encoding as `%2A`).

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

export type CallingTemplate = {
  /** Human form, with wildcards if any (e.g. `'Counselor *'`). */
  calling_name: string;
  /**
   * Whether a row in the LCR Sheet matching this template should
   * trigger an Access doc population for the holder. The importer's
   * primary signal.
   */
  give_app_access: boolean;
  /**
   * Sheet-row order from the import source. Used as a tie-breaker
   * among wildcard matches: Sheet order wins, so an earlier wildcard
   * shadows a later one. Plain (non-wildcard) names always win against
   * any wildcard regardless of sheet_order.
   */
  sheet_order: number;
  created_at: TimestampLike;
  lastActor: ActorRef;
};

/** Per-ward calling template — applied to ward tabs in the LCR Sheet. */
export type WardCallingTemplate = CallingTemplate;

/** Per-stake calling template — applied to the Stake tab in the LCR Sheet. */
export type StakeCallingTemplate = CallingTemplate;
