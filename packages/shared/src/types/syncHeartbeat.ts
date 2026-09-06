// A stake's most recent Sync scan, one document per Kindoo site.
//
// The drift scan is computed entirely in the extension and only *fixes*
// reach the server, so without this a manager who syncs every morning
// and finds nothing wrong writes nothing at all — indistinguishable
// from a manager who has not synced in a month. That is the gap T-106
// closes, and it is why neither `auditLog` rows nor seat staleness can
// stand in: a clean Sync leaves no trace of either.
//
// Lives at top-level `syncHeartbeats/{stakeId}/sites/{siteKey}`, never
// under `stakes/{stakeId}`. `auditTrigger` fans an audit row for every
// write beneath that path, and a scan is frequent, so a per-stake home
// would bury the audit log under heartbeats — the same reasoning that
// put `stakeSchedules` top-level (D38).
//
// **Keyed by stake and site, never by manager.** A stake can have
// several Kindoo Managers, and any one of them syncing freshens the
// site for all of them. The document is therefore shared and
// last-writer-wins on a single timestamp, which is exactly the question
// being asked: when did *anyone* last sync this site. One document per
// site also means every write lands directly, with no read-modify-write
// and so no clobber race of the kind D39(f) had to fix with a
// transaction.
//
// `lastActor` records whoever synced most recently and churns freely as
// different managers scan. That costs nothing precisely because this
// collection is unaudited.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

export type SyncHeartbeat = {
  /** The stake the site belongs to. */
  stake_id: string;
  /**
   * The foreign site's `kindooSites` doc id, or null on the stake's home
   * site (which has no `kindooSites` doc — home lives on
   * `stake.kindoo_config`). Same convention as `RemoteApplyDesktop`. The
   * doc id is this value through `remoteApplySiteKey`, since a doc id
   * cannot be null.
   */
  kindoo_site_id: string | null;
  /**
   * When a drift scan last completed for this site. The heartbeat means
   * *someone looked*, not *drift is clear* — a manager who scans, sees
   * five rows and applies none has still synced. That is the right
   * meaning for "it has been seven days", and it is why the expired-seat
   * check (D37) stays an independent condition rather than folding in.
   */
  last_sync_at: TimestampLike;
  /** Extension manifest version that wrote it. */
  ext_version: string;
  lastActor: ActorRef;
};
