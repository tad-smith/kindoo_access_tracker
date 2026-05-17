// Fires when a `remove`-type request completes. Owns the server-side
// seat reconciliation that the Phase-6 client transaction can't do
// directly (Firestore rules' `delete` operation has no access to
// `request.resource.data`, so it cannot enforce the cross-doc
// invariant tying the deletion to the request completion).
//
// Scope-aware behaviour (B-10 fix, extension v2.2 era):
//
//   1. Read the request to get `request.scope`.
//   2. Read the target seat doc (path = `stakes/{stakeId}/seats/
//      {seat_member_canonical ?? member_canonical}`).
//   3. Seat missing → R-1 race (the seat was already gone). No-op;
//      `markRequestComplete` already stamped the system note on the
//      request.
//   4. Seat present → walk the grants:
//      - If the primary grant's scope matches the request's scope:
//        the primary is being removed.
//        - No duplicate_grants → delete the seat (legacy behaviour).
//        - Else → promote the first duplicate_grants[] entry to
//          primary (copy scope, type, callings, reason, start_date,
//          end_date, building_names onto the top-level fields),
//          splice that entry out of the array.
//      - Else find the first duplicate_grants[] entry with matching
//        scope and splice it out. Primary stays.
//      - No match anywhere → log a warning and no-op the seat. The
//        request stays complete (already flipped by the callable);
//        the trigger doesn't undo that.
//   5. After the seat write, recompute `stake.last_over_caps_json`
//      from the post-write seat set inside the same transaction. A
//      remove may shift a pool from over-cap back under-cap (or
//      between pools when a primary is promoted); the empty→non-empty
//      transition fires `notifyOnOverCap` as usual.
//
// Idempotent: re-firing on a stale event finds the seat already in
// its target shape (or already gone) and exits cleanly. The audit
// trigger handles the `delete_seat` / `update_seat` row.
//
// Attribution: seat-side writes are stamped with the synthetic
// `RemoveTrigger` actor so the audit trail can distinguish "manager
// flipped the request" (recorded on the request doc with the manager
// as completer) from "trigger reconciled the seat" (recorded on the
// seat doc).
//
// `granted_by_request` on promotion: cleared. The field denotes the
// request that justifies the *current primary*. When we promote a
// duplicate, the original request that established the now-deleted
// primary no longer applies, and the duplicate's originating request
// isn't tracked on `duplicate_grants[]` entries. The SPA only writes
// this field (no SPA reads), so clearing is safe.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import type {
  AccessRequest,
  DuplicateGrant,
  OverCapEntry,
  Seat,
  Stake,
  Ward,
} from '@kindoo/shared';
import { getDb } from '../lib/admin.js';
import { computeOverCaps } from '../lib/overCaps.js';
import { REMOVE_TRIGGER_ACTOR } from '../lib/systemActors.js';

/** Plan output: how the seat write should resolve. */
type SeatPlan =
  | { kind: 'delete' }
  | { kind: 'promote'; promoted: DuplicateGrant; remaining: DuplicateGrant[] }
  | { kind: 'drop_duplicate'; remaining: DuplicateGrant[] }
  | { kind: 'no_match' };

/**
 * Decide what to do with the seat for a remove request whose scope is
 * `requestScope`. Pure — returns the plan; the caller applies it.
 */
export function planRemove(opts: { seat: Seat; requestScope: string }): SeatPlan {
  const { seat, requestScope } = opts;
  const dupes = seat.duplicate_grants ?? [];

  if (seat.scope === requestScope) {
    if (dupes.length === 0) return { kind: 'delete' };
    const [promoted, ...remaining] = dupes;
    return { kind: 'promote', promoted: promoted!, remaining };
  }

  const idx = dupes.findIndex((d) => d.scope === requestScope);
  if (idx >= 0) {
    const remaining = dupes.slice(0, idx).concat(dupes.slice(idx + 1));
    return { kind: 'drop_duplicate', remaining };
  }

  return { kind: 'no_match' };
}

/**
 * Build the post-write seat projection for `computeOverCaps`. We only
 * need `scope` on each Seat for cap math (per `overCaps.ts`); a
 * minimal projection avoids reconstructing full Seat shapes.
 */
function projectPostWriteSeats(opts: {
  allSeats: Seat[];
  targetCanonical: string;
  plan: SeatPlan;
  currentSeat: Seat;
}): Seat[] {
  const { allSeats, targetCanonical, plan, currentSeat } = opts;
  if (plan.kind === 'delete') {
    return allSeats.filter((s) => s.member_canonical !== targetCanonical);
  }
  if (plan.kind === 'no_match') {
    return allSeats;
  }
  const nextScope = plan.kind === 'promote' ? plan.promoted.scope : currentSeat.scope;
  return allSeats.map((s) => {
    if (s.member_canonical !== targetCanonical) return s;
    return { ...s, scope: nextScope } as Seat;
  });
}

export const removeSeatOnRequestComplete = onDocumentWritten(
  'stakes/{stakeId}/requests/{requestId}',
  async (event) => {
    if (!event.data) return;
    const before = event.data.before.exists ? (event.data.before.data() as AccessRequest) : null;
    const after = event.data.after.exists ? (event.data.after.data() as AccessRequest) : null;
    if (!after) return;

    const justCompleted =
      after.status === 'complete' && (before == null || before.status !== 'complete');
    if (!justCompleted) return;
    if (after.type !== 'remove') return;

    const { stakeId } = event.params as { stakeId: string };
    const memberCanonical = after.seat_member_canonical ?? after.member_canonical;
    if (!memberCanonical) {
      logger.warn('remove request has no seat_member_canonical', { stakeId, after });
      return;
    }

    const db = getDb();
    const seatRef = db.doc(`stakes/${stakeId}/seats/${memberCanonical}`);
    const stakeRef = db.doc(`stakes/${stakeId}`);
    const seatsCol = db.collection(`stakes/${stakeId}/seats`);
    const wardsCol = db.collection(`stakes/${stakeId}/wards`);

    await db.runTransaction(async (tx) => {
      const seatSnap = await tx.get(seatRef);
      if (!seatSnap.exists) {
        // R-1 race: seat already gone (Phase-6 client tx may have
        // deleted it, or expiry trimmed it, or a prior trigger run
        // completed). Nothing to do; the request flip stands and the
        // callable already stamped the system completion note.
        return;
      }
      const currentSeat = seatSnap.data() as Seat;
      const plan = planRemove({ seat: currentSeat, requestScope: after.scope });

      if (plan.kind === 'no_match') {
        // The request's scope doesn't correspond to any grant on the
        // seat. Shouldn't happen in normal flow but possible if the
        // SBA UI submitted a stale request after concurrent changes.
        // No-op the seat; request stays complete (already flipped by
        // the callable).
        logger.warn('remove request scope does not match any grant on seat', {
          stakeId,
          requestId: after.request_id,
          seatCanonical: memberCanonical,
          requestScope: after.scope,
          seatScope: currentSeat.scope,
          duplicateScopes: (currentSeat.duplicate_grants ?? []).map((d) => d.scope),
        });
        return;
      }

      // Gather the rest of the seat set + wards + stake doc for the
      // cap recompute. Transactions require all reads precede all
      // writes, so this batch happens before any tx.update/delete.
      const [allSeatsSnap, wardsSnap, stakeSnap] = await Promise.all([
        tx.get(seatsCol),
        tx.get(wardsCol),
        tx.get(stakeRef),
      ]);
      const allSeats = allSeatsSnap.docs.map((d) => d.data() as Seat);
      const wards = wardsSnap.docs.map((d) => d.data() as Ward);
      const stakeData = stakeSnap.data() as Stake | undefined;
      const stakeSeatCap = stakeData?.stake_seat_cap ?? 0;

      // Apply the plan.
      if (plan.kind === 'delete') {
        tx.delete(seatRef);
      } else if (plan.kind === 'promote') {
        const { promoted, remaining } = plan;
        const update: Record<string, unknown> = {
          scope: promoted.scope,
          type: promoted.type,
          callings: promoted.callings ?? [],
          building_names: promoted.building_names ?? [],
          // T-42: promoting a duplicate to primary moves the site
          // along with it. The new primary's `kindoo_site_id` is the
          // promoted duplicate's site. Clear when unset (legacy
          // duplicates) so the seat reads as un-migrated and the
          // ward-fallback handles classification.
          kindoo_site_id:
            promoted.kindoo_site_id !== undefined ? promoted.kindoo_site_id : FieldValue.delete(),
          duplicate_grants: remaining,
          // T-42 / T-43: keep the primitive mirror in sync with the
          // remaining duplicates.
          duplicate_scopes: remaining.map((d) => d.scope),
          // `granted_by_request` on the seat denotes the request that
          // justifies the *current primary*. The original primary is
          // being removed; the duplicate's originating request isn't
          // tracked on `DuplicateGrant`, so clear the field rather
          // than leave a stale pointer to the deleted primary's
          // request. Safe per SPA audit: only written, never read.
          granted_by_request: FieldValue.delete(),
          // Optional fields — set when the duplicate carries them,
          // delete otherwise so a manual-promotion doesn't inherit
          // the old primary's temp dates / reason.
          reason: promoted.reason ?? FieldValue.delete(),
          start_date: promoted.start_date ?? FieldValue.delete(),
          end_date: promoted.end_date ?? FieldValue.delete(),
          last_modified_at: FieldValue.serverTimestamp(),
          last_modified_by: { ...REMOVE_TRIGGER_ACTOR },
          lastActor: { ...REMOVE_TRIGGER_ACTOR },
        };
        tx.update(seatRef, update);
      } else {
        // drop_duplicate
        tx.update(seatRef, {
          duplicate_grants: plan.remaining,
          // T-42 / T-43: keep the primitive mirror in sync.
          duplicate_scopes: plan.remaining.map((d) => d.scope),
          last_modified_at: FieldValue.serverTimestamp(),
          last_modified_by: { ...REMOVE_TRIGGER_ACTOR },
          lastActor: { ...REMOVE_TRIGGER_ACTOR },
        });
      }

      // Recompute over-caps from the post-write seat set.
      const postWriteSeats = projectPostWriteSeats({
        allSeats,
        targetCanonical: memberCanonical,
        plan,
        currentSeat,
      });
      const overCaps: OverCapEntry[] = computeOverCaps({
        seats: postWriteSeats,
        wards,
        stakeSeatCap,
      });

      tx.set(
        stakeRef,
        {
          last_over_caps_json: overCaps,
          last_modified_at: FieldValue.serverTimestamp(),
          last_modified_by: { ...REMOVE_TRIGGER_ACTOR },
          lastActor: { ...REMOVE_TRIGGER_ACTOR },
        },
        { merge: true },
      );
    });
  },
);
