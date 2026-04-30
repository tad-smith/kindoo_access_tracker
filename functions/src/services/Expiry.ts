// Daily temp-seat expiry. Scans `stakes/{sid}/seats` for
// `type=='temp' AND end_date < today (in stake.timezone)` and
// deletes them. Auto-expire audit row is fanned by the parameterized
// `auditTrigger`, which detects a seat delete with
// `BEFORE.lastActor.canonical == 'ExpiryTrigger'` and emits
// `auto_expire` instead of `delete_seat`.
//
// Sequence per seat:
//   1. Update seat's `lastActor` to the synthetic `'ExpiryTrigger'` ref.
//      The bookkeeping-only update is silently no-op'd by the audit
//      trigger (BOOKKEEPING_FIELDS exclusion).
//   2. Delete the seat.
//
// The trigger then sees a delete with the stamped lastActor on the
// BEFORE snapshot and emits `auto_expire`.

import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import type { Seat, Stake } from '@kindoo/shared';
import { getDb } from '../lib/admin.js';
import { EXPIRY_ACTOR } from '../lib/systemActors.js';

export type ExpirySummary = {
  expired: number;
  ids: string[];
  elapsed_ms: number;
  summary: string;
};

/** Run daily expiry for one stake. Caller selects which stakes to run. */
export async function runExpiryForStake(opts: { stakeId: string }): Promise<ExpirySummary> {
  const { stakeId } = opts;
  const db = getDb();
  const startedMs = Date.now();

  const stake = await loadStake(db, stakeId);
  const today = todayInTimezone(new Date(), stake.timezone);

  const seatsSnap = await db.collection(`stakes/${stakeId}/seats`).get();
  const expiring: Seat[] = [];
  for (const d of seatsSnap.docs) {
    const seat = d.data() as Seat;
    if (seat.type !== 'temp') continue;
    if (!seat.end_date) continue;
    if (String(seat.end_date) < today) expiring.push(seat);
  }

  const ids: string[] = [];
  for (const seat of expiring) {
    const ref = db.doc(`stakes/${stakeId}/seats/${seat.member_canonical}`);
    // Two-step: stamp ExpiryTrigger as lastActor (bookkeeping update —
    // audit trigger filters this), then delete (audit trigger emits
    // auto_expire because BEFORE.lastActor.canonical=='ExpiryTrigger').
    await ref.set(
      {
        lastActor: { ...EXPIRY_ACTOR },
        last_modified_at: FieldValue.serverTimestamp(),
        last_modified_by: { ...EXPIRY_ACTOR },
      },
      { merge: true },
    );
    await ref.delete();
    ids.push(seat.member_canonical);
  }

  const elapsed_ms = Date.now() - startedMs;
  const summary = `${ids.length} row${ids.length === 1 ? '' : 's'} expired in ${elapsed_ms}ms`;

  await db.doc(`stakes/${stakeId}`).set(
    {
      last_expiry_at: FieldValue.serverTimestamp(),
      last_expiry_summary: summary,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: { ...EXPIRY_ACTOR },
      lastActor: { ...EXPIRY_ACTOR },
    },
    { merge: true },
  );

  return { expired: ids.length, ids, elapsed_ms, summary };
}

async function loadStake(db: Firestore, stakeId: string): Promise<Stake> {
  const snap = await db.doc(`stakes/${stakeId}`).get();
  if (!snap.exists) throw new Error(`stake ${stakeId} not found`);
  return snap.data() as Stake;
}

/** Format `now` as `YYYY-MM-DD` in `timezone`. */
export function todayInTimezone(now: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA returns YYYY-MM-DD by convention.
  return fmt.format(now);
}
