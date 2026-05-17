// `Request` — `stakes/{stakeId}/requests/{requestId}` doc per
// `docs/firebase-schema.md` §4.7. UUID-keyed because a member can
// submit many requests over time; the `member_canonical` field denorms
// the subject so the queue doesn't need joins.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

export type RequestType =
  | 'add_manual'
  | 'add_temp'
  | 'remove'
  | 'edit_auto'
  | 'edit_manual'
  | 'edit_temp';
export type RequestStatus = 'pending' | 'complete' | 'rejected' | 'cancelled';

/**
 * Discriminator for `status='complete'` requests whose completion was
 * not a normal apply-the-change path. Absent on the happy path.
 *
 * - `'noop_already_removed'`: R-1 race — a manager completed a
 *   `remove` whose target seat was already gone at completion time.
 *   Stamped by `markRequestComplete`.
 * - `'noop_grant_shifted'`: T-43 reviewer-flagged race — a
 *   `remove`'s snapshotted `(scope, kindoo_site_id)` did not address
 *   any grant on the seat at trigger time. Stamped by
 *   `removeSeatOnRequestComplete`.
 *
 * Audit summarisers route on this field. `completion_note` carries
 * the human-readable detail; this is the routing key.
 */
export type CompletionStatus = 'noop_already_removed' | 'noop_grant_shifted';

export type AccessRequest = {
  /** `= doc.id`. UUID. */
  request_id: string;
  type: RequestType;
  /** `'stake'` or a ward_code. */
  scope: string;

  /** Subject of the request — typed email. */
  member_email: string;
  /** Subject of the request — canonical email. */
  member_canonical: string;
  /** Subject of the request — display name. Required for add types; may be empty for remove. */
  member_name: string;

  /** Free-text — the calling / role / reason a manual or temp seat is being requested for. */
  reason: string;
  /**
   * Free-text — additional context the requester typed. Optional at
   * the wire boundary. `edit_*` types require a non-empty trimmed
   * comment (enforced by `accessRequestSchema.superRefine`, the
   * Firestore rule predicate, and the web form); `add_*` / `remove`
   * leave it free-form and may omit the field entirely.
   */
  comment?: string;
  /** ISO date `YYYY-MM-DD` — `add_temp` only. */
  start_date?: string;
  /** ISO date `YYYY-MM-DD` — `add_temp` only. */
  end_date?: string;
  /**
   * Buildings the requester selected. Required for stake-scope add
   * types (non-stake-scope add types inherit the ward's `building_name`
   * automatically) and for every edit type (`edit_auto`, `edit_manual`,
   * `edit_temp`) since edits carry the full post-edit building set as
   * the replacement payload.
   */
  building_names: string[];

  /**
   * Requester-set on submit and immutable thereafter. When `true`, the
   * comment field is required at submit time and the request renders
   * with a red top bar wherever it appears (My Requests, Queue urgent
   * section). A missing field is treated as `false` (rendered
   * non-urgent).
   */
  urgent?: boolean;

  status: RequestStatus;

  // ----- Submitter -----
  requester_email: string;
  requester_canonical: string;
  requested_at: TimestampLike;

  // ----- Resolver (set on complete / reject) -----
  completer_email?: string;
  completer_canonical?: string;
  completed_at?: TimestampLike;
  /** Required for `status='rejected'`; rules enforce non-empty. */
  rejection_reason?: string;
  /**
   * Human-readable annotation set alongside `completion_status` when
   * the completion path took a non-happy-path branch (R-1 race, or
   * the Phase B grant-shifted race). Routing key is
   * `completion_status`; this field carries the user-visible detail.
   */
  completion_note?: string;
  /**
   * Typed discriminator for non-happy-path completions; see
   * `CompletionStatus`. Absent on normal completes.
   */
  completion_status?: CompletionStatus;

  /**
   * Extension v2.2 — Kindoo internal user id captured at provision
   * time. Optional; only set when v2.2's "Provision & Complete" flow
   * successfully resolved the user in Kindoo (added or matched on
   * lookup). Absent for the SPA mark-complete path and for v2.2's
   * remove-no-op (user not in Kindoo).
   */
  kindoo_uid?: string;
  /**
   * Extension v2.2 — human-readable summary of what the Provision &
   * Complete flow did in Kindoo (e.g. "Added X to Kindoo with access
   * to Cordera Building."). Same shape contract as `completion_note`.
   */
  provisioning_note?: string;

  /**
   * For `type='remove'`, denormalised at submit time so the
   * completion path can target the seat doc by ID without running a
   * query (Firestore client transactions can't query). Same value as
   * `member_canonical`; kept for legibility on the doc.
   */
  seat_member_canonical?: string;

  /**
   * For `type='remove'`, the Kindoo site the grant being removed
   * lives on. Optional: present on remove requests generated from a
   * duplicate row (Phase B), absent / null on remove requests
   * generated from a primary row (legacy / today's behaviour, which
   * targets the seat's primary by scope alone). The
   * `removeSeatOnRequestComplete` trigger matches the
   * `duplicate_grants[]` entry to drop by `(scope, kindoo_site_id)`
   * when populated; legacy scope-only requests fall back to the
   * pre-Phase-B match. T-43.
   */
  kindoo_site_id?: string | null;

  lastActor: ActorRef;
};
