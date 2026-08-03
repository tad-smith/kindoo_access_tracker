// Remote apply — the per-manager mailbox that lets a Kindoo Manager tap
// a pending request on their phone and have their own desktop Chrome
// extension provision it in Kindoo. See `docs/architecture.md` D27.
//
// Three levels, all owned by the manager themself (rules gate on
// `authedCanonical()`):
//   `remoteApply/{canonicalEmail}`                  — the opt-in, one per
//                                                     Chrome profile
//   `remoteApply/{canonicalEmail}/desktops/{siteId}` — one per Kindoo site
//                                                     the manager has a live
//                                                     tab on, written by that
//                                                     tab's heartbeat
//   `remoteApply/{canonicalEmail}/jobs/{jobId}`      — one doc per tap;
//                                                     created by the phone,
//                                                     driven to a terminal
//                                                     status by the extension
//
// The extension can only drive Kindoo from a live Kindoo tab (it needs the
// page's session token and the active site EID), so a desktop doc exists
// only while such a tab is open and usable. Absence of a fresh heartbeat
// is the signal that the phone must not offer the button.
//
// **Presence is per Kindoo site, not per manager.** A stake can have more
// than one Kindoo site, and a tab can only provision for the site it is
// currently inside. One doc per manager would flap between sites on every
// heartbeat, and — worse — let a tab claim a job for a site it cannot
// serve, which fails with a mismatch that tells the manager to open a site
// they already have open in the next tab. Keying by `siteId` lets two tabs
// coexist: each publishes its own liveness, and each claims only the jobs
// it can actually run.
//
// Timings and the freshness predicates live in `src/remoteApply.ts` — both
// surfaces read them from there so the phone and the extension can't
// disagree about staleness.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

/**
 * `remoteApply/{canonicalEmail}` — the opt-in itself. Profile-wide, because
 * the extension stores it in `chrome.storage.local`: ticking the box in one
 * Kindoo tab enables every tab in that Chrome profile.
 */
export type RemoteApplyPresence = {
  /**
   * The extension-side opt-in. Absent ⇒ off: this grants a second device
   * authority to act, so a doc that predates the toggle must not read as
   * consent. Cleared immediately when the manager toggles off, so the
   * phone's button disappears without waiting out the staleness window.
   */
  remote_apply_enabled?: boolean;
  /** Extension manifest version, for diagnosing version-skewed behaviour. */
  ext_version: string;
  lastActor: ActorRef;
};

/**
 * `remoteApply/{canonicalEmail}/desktops/{siteId}` — one live Kindoo tab,
 * on one Kindoo site. Doc ID is the SBA-side site id
 * (`stakes/{stakeId}/kindooSites/{siteId}`), so a second tab on a second
 * site writes a second doc rather than overwriting the first.
 *
 * A tab whose active EID maps to no SBA site publishes nothing — it can't
 * name the site it's on, and it couldn't provision for it either.
 */
export type RemoteApplyDesktop = {
  /** Stake this site belongs to. Gated by `isManager` in rules. */
  stake_id: string;
  /**
   * The foreign site's `kindooSites` doc id, or null when this tab is on
   * the stake's home site (which has no `kindooSites` doc — home lives on
   * `stake.kindoo_config`). Mirrors the `kindoo_site_id: string | null`
   * convention wards and buildings already use. The doc id is the same
   * value run through `remoteApplySiteKey`, since a doc id cannot be null.
   */
  kindoo_site_id: string | null;
  /** Last heartbeat. Compared against `REMOTE_APPLY_STALE_MS`. */
  last_seen_at: TimestampLike;
  /** The Kindoo-side environment id this tab is inside. */
  kindoo_eid: number | null;
  /** Site display name — shown on the phone so the manager can sanity-check. */
  kindoo_site_name: string | null;
  /** Extension manifest version of the tab publishing this. */
  ext_version: string;
  lastActor: ActorRef;
};

/** A desktop doc plus its id, which is its `remoteApplySiteKey`. */
export type RemoteApplyDesktopWithId = RemoteApplyDesktop & { site_key: string };

/**
 * Job lifecycle. `partial` is its own terminal state because the desktop
 * flow can succeed in Kindoo and then fail to mark the request complete in
 * SBA — the phone must not report that as "nothing happened".
 */
export type RemoteApplyJobStatus =
  | 'queued'
  | 'running'
  | 'applied'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type RemoteApplyOutcomeCode =
  | 'applied'
  /** Kindoo write succeeded, SBA `markRequestComplete` did not. */
  | 'sba_incomplete'
  /** The desktop is inside a different Kindoo site than the request needs. */
  | 'site_mismatch'
  /** The Kindoo tab lost its session (token or active-site EID unreadable). */
  | 'kindoo_session_lost'
  /** A target building has no Kindoo rule mapped. */
  | 'building_rule_missing'
  /** The request left `pending` before the desktop got to it. */
  | 'request_not_pending'
  /** Anything else — the Kindoo API error surfaces through `message`. */
  | 'error';

/**
 * What the desktop learned. `code` is a stable discriminator for UI
 * branching; `message` is the operator-facing sentence, authored on the
 * desktop so both surfaces word failures identically.
 */
export type RemoteApplyOutcome = {
  code: RemoteApplyOutcomeCode;
  message: string;
  /** Mirrors `AccessRequest.kindoo_uid` when the provision resolved one. */
  kindoo_uid?: string;
  provisioning_note?: string;
};

/**
 * `remoteApply/{canonicalEmail}/jobs/{jobId}` — one tap, one doc.
 *
 * Jobs are never deleted; at 1–2 requests/week the collection stays
 * trivially small and the history is useful when a provision misbehaves.
 */
export type RemoteApplyJob = {
  request_id: string;
  stake_id: string;
  /**
   * The Kindoo site this request must be provisioned on, as a site key
   * (see `remoteApplySiteKey`). Only a tab inside this site may claim the
   * job — that is what keeps a stake's second Kindoo site from stealing
   * work it cannot perform.
   *
   * Derived at tap time from scope + ward → building → site, NOT read from
   * `AccessRequest.kindoo_site_id` (that field means something else: the
   * site of the grant a `remove` targets, absent on add/edit). Required —
   * a phone that cannot resolve the target site must not offer the button
   * at all, since it cannot know which desktop could serve it.
   */
  target_site_key: string;
  status: RemoteApplyJobStatus;
  created_at: TimestampLike;
  /** `getDeviceId()` of the phone that queued it. */
  created_by_device: string;
  claimed_at?: TimestampLike;
  /** Identifies the Kindoo tab that won the claim: ext version + EID. */
  claimed_by?: { ext_version: string; kindoo_eid: number | null };
  finished_at?: TimestampLike;
  outcome?: RemoteApplyOutcome;
  lastActor: ActorRef;
};
