// Remote apply — the per-manager mailbox that lets a Kindoo Manager tap
// a pending request on their phone and have their own desktop Chrome
// extension provision it in Kindoo. See `docs/architecture.md` D27.
//
// Two docs, both owned by the manager themself (rules gate on
// `authedCanonical()`):
//   `remoteApply/{canonicalEmail}`            — presence + opt-in, written
//                                               only by the extension
//   `remoteApply/{canonicalEmail}/jobs/{id}`  — one doc per tap; created by
//                                               the phone, driven to a
//                                               terminal status by the
//                                               extension
//
// The extension can only drive Kindoo from a live Kindoo tab (it needs the
// page's session token and the active site EID), so presence is published
// only while such a tab is open and usable. Absence of a fresh heartbeat
// is the signal that the phone must not offer the button.
//
// Timings and the online/terminal predicates live in
// `src/remoteApply.ts` — both surfaces read them from there so the phone
// and the extension can't disagree about staleness.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

/**
 * `remoteApply/{canonicalEmail}` — what the desktop extension advertises
 * about itself. Written by the extension only; the phone reads it.
 */
export type RemoteApplyPresence = {
  /**
   * The extension-side opt-in. Absent ⇒ off: this grants a second device
   * authority to act, so a doc that predates the toggle must not read as
   * consent. Cleared immediately when the manager toggles off, so the
   * phone's button disappears without waiting out the staleness window.
   */
  remote_apply_enabled?: boolean;
  /** Last heartbeat. Compared against `REMOTE_APPLY_STALE_MS`. */
  last_seen_at: TimestampLike;
  /** Stake the extension has resolved for its active Kindoo site. */
  stake_id: string;
  /** Active Kindoo site, or null when the extension couldn't resolve one. */
  kindoo_eid: number | null;
  /** Site display name — shown on the phone so the manager can sanity-check. */
  kindoo_site_name: string | null;
  /** Extension manifest version, for diagnosing version-skewed behaviour. */
  ext_version: string;
  lastActor: ActorRef;
};

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
