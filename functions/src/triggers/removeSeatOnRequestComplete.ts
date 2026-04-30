// Fires when a `remove`-type request completes. The Phase-6 client
// transaction can't delete the seat directly because Firestore
// rules' `delete` operation has no access to `request.resource.data`,
// so it cannot enforce the cross-doc invariant tying the deletion to
// the request completion. This trigger does it server-side via the
// Admin SDK (which bypasses rules entirely).
//
// Idempotent: re-firing on a stale event finds the seat already gone
// and exits cleanly. The audit trigger handles the standard
// `delete_seat` row.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import type { AccessRequest } from '@kindoo/shared';
import { getDb } from '../lib/admin.js';

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
    const ref = db.doc(`stakes/${stakeId}/seats/${memberCanonical}`);
    const seat = await ref.get();
    if (!seat.exists) {
      // R-1 race: the seat was already gone (Phase-6 client tx may have
      // deleted it, or expiry trimmed it). Nothing to do here; the
      // request flip stands.
      return;
    }
    await ref.delete();
  },
);
