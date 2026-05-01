// `Request` — `stakes/{stakeId}/requests/{requestId}` doc per
// `docs/firebase-schema.md` §4.7. UUID-keyed because a member can
// submit many requests over time; the `member_canonical` field denorms
// the subject so the queue doesn't need joins.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

export type RequestType = 'add_manual' | 'add_temp' | 'remove';
export type RequestStatus = 'pending' | 'complete' | 'rejected' | 'cancelled';

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
  /** Free-text — additional context the requester typed. May be empty. */
  comment: string;
  /** ISO date `YYYY-MM-DD` — `add_temp` only. */
  start_date?: string;
  /** ISO date `YYYY-MM-DD` — `add_temp` only. */
  end_date?: string;
  /**
   * Buildings the requester selected (stake-scope add types only;
   * non-stake-scope inherits the ward's `building_name` automatically).
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
   * R-1 race annotation: "Seat already removed at completion time
   * (no-op)." See `firebase-migration.md` invariant 8 — a manager
   * completing a `remove` whose seat is gone records the no-op rather
   * than failing the transaction.
   */
  completion_note?: string;

  /**
   * For `type='remove'`, denormalised at submit time so the
   * completion path can target the seat doc by ID without running a
   * query (Firestore client transactions can't query). Same value as
   * `member_canonical`; kept for legibility on the doc.
   */
  seat_member_canonical?: string;

  lastActor: ActorRef;
};
