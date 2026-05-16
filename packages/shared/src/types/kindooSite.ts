// `KindooSite` — `stakes/{stakeId}/kindooSites/{kindooSiteId}` doc per
// `docs/firebase-schema.md` §4.11 (Kindoo Sites). Doc ID is a manager-
// chosen slug (e.g. `'foreign-1'`).
//
// "Kindoo sites" track the Kindoo environments an SBA stake's
// managers can write to. The HOME site lives on the stake parent doc
// (`stake.kindoo_config.site_id` / `stake_name` / the optional
// `kindoo_expected_site_name` override) — there is no `KindooSite`
// document for the home site. Foreign sites live as documents under
// this collection. Wards and Buildings carry an optional
// `kindoo_site_id: string | null` that, when null / absent, means
// "home site"; when set, refers to a doc id under this collection.
//
// Phase 1 ships data model + Configuration UI only. Filtering on
// request forms (Phase 2), extension orchestrator enforcement
// (Phase 3), and sync filtering (Phase 4) read this field; Phase 1
// itself does not change runtime behaviour.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

export type KindooSite = {
  /** `= doc.id`. Manager-chosen slug. */
  id: string;
  /** Human-readable label rendered in the Configuration UI (e.g. `'East Stake (Foothills Building)'`). */
  display_name: string;
  /**
   * The site-name string Kindoo's admin UI surfaces for this site.
   * The extension's active-session validation compares this against
   * the live Kindoo session's site name. Mirrors the role
   * `stake.kindoo_expected_site_name` plays for the home site.
   */
  kindoo_expected_site_name: string;
  /**
   * Kindoo environment ID. Matches the value Kindoo's localStorage
   * exposes at `state.sites.ids[0]` for an active session — the
   * extension uses this for active-session validation. Mirrors the
   * role `stake.kindoo_config.site_id` plays for the home site.
   *
   * Populated by the extension once the operator first uses it on a
   * session logged into the site. Manager UI does not expose this
   * field.
   */
  kindoo_eid?: number | null;

  created_at: TimestampLike;
  last_modified_at: TimestampLike;
  lastActor: ActorRef;
};
