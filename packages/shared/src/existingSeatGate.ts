// Whether an `add_*` request can be provisioned onto a member who
// already holds a seat.
//
// Two surfaces ask this question and they must give the same answer:
// the extension's queue card decides whether to offer Provision &
// Complete, and the web queue card decides whether to offer Apply via
// extension and whether to print the blocking duplicate-seat error. A
// web gate broader than the extension's does not fail safe — it
// silently removes the feature for a class of requests the desktop
// would happily provision, and tells the manager to reject them.
//
// The rule, per `docs/spec.md` §15:
//
//   Completing an add creates a brand-new one-per-member seat doc keyed
//   by canonical email, so ANY existing seat means the create collides
//   — reject-only.
//
//   **Except** `add_manual` at `scope: 'stake'` for a member with no
//   stake-scope grant. That one merges: `markRequestComplete` →
//   `planAddMerge` appends a cross-scope stake grant onto the existing
//   seat rather than colliding with it, and succeeds whether the member
//   is foreign-site-only or a home-ward member. The web's own "Give
//   Access To Stake Buildings" button is its primary producer, which is
//   exactly why the phone must not suppress it.
//
//   `!hasStakeGrant` is the backstop: with a stake grant already in
//   place the add would be a true stake duplicate, so keep blocking.
//
// `add_temp` is never carved out — a temp stake grant alongside an
// existing seat is not what `planAddMerge` handles.

import type { AccessRequest } from './types/request.js';
import type { Seat } from './types/seat.js';

/**
 * What the gate needs to know about the member's existing seat.
 *
 * Both flags false means "no seat" AND "an unresolved lookup" — the two
 * are deliberately indistinguishable here, because both must read as
 * not-blocked. A failed or still-loading seat read must never suppress
 * the action; the server-side precondition is the backstop.
 */
export interface ExistingSeatFacts {
  /** A seat doc exists for this member (any scope, any type). */
  hasSeat: boolean;
  /** That seat already holds a stake-scope grant — primary or duplicate. */
  hasStakeGrant: boolean;
}

/** True when the seat holds a stake-scope grant — primary or duplicate. */
export function seatHasStakeGrant(seat: Pick<Seat, 'scope' | 'duplicate_grants'>): boolean {
  return seat.scope === 'stake' || (seat.duplicate_grants ?? []).some((g) => g.scope === 'stake');
}

/** Read the gate's inputs off a live seat doc, absent or not. */
export function existingSeatFacts(
  seat: Pick<Seat, 'scope' | 'duplicate_grants'> | null | undefined,
): ExistingSeatFacts {
  if (!seat) return { hasSeat: false, hasStakeGrant: false };
  return { hasSeat: true, hasStakeGrant: seatHasStakeGrant(seat) };
}

/**
 * True when this request cannot be provisioned because the member
 * already has a seat — i.e. the card should say "reject it" and offer
 * no provisioning affordance.
 *
 * Always false for `edit_*` and `remove`: those operate on an existing
 * seat by design, so a pre-existing seat is expected, not a collision.
 */
export function addBlockedByExistingSeat(
  request: Pick<AccessRequest, 'type' | 'scope'>,
  facts: ExistingSeatFacts,
): boolean {
  const isAdd = request.type === 'add_manual' || request.type === 'add_temp';
  if (!isAdd || !facts.hasSeat) return false;
  const applyableStakeAdd =
    request.type === 'add_manual' && request.scope === 'stake' && !facts.hasStakeGrant;
  return !applyableStakeAdd;
}
