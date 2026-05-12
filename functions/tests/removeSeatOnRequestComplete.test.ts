// Integration tests for the remove-seat-on-request-complete trigger.
// This is the Admin SDK seat-delete that the client tx cannot do
// cleanly because Firestore rules' `delete` operations do not have
// access to incoming data.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { removeSeatOnRequestComplete } from '../src/triggers/removeSeatOnRequestComplete.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';

function makeEvent<P extends Record<string, string>>(opts: {
  params: P;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  time?: string;
}): never {
  const time = opts.time ?? new Date().toISOString();
  const beforeSnap = {
    exists: opts.before != null,
    data: () => opts.before ?? undefined,
  };
  const afterSnap = {
    exists: opts.after != null,
    data: () => opts.after ?? undefined,
  };
  return {
    params: opts.params,
    time,
    data: { before: beforeSnap, after: afterSnap },
  } as unknown as never;
}

async function seedSeat(canonical: string): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/seats/${canonical}`).set({
    member_canonical: canonical,
    member_email: canonical,
    member_name: 'X',
    scope: 'CO',
    type: 'manual',
    callings: [],
    reason: 'helper',
    building_names: ['Cordera Building'],
    duplicate_grants: [],
    granted_by_request: 'r1',
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
    lastActor: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
  });
}

describe.skipIf(!hasEmulators())('removeSeatOnRequestComplete', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('deletes the seat when a remove request flips pending → complete', async () => {
    await seedSeat('alice@gmail.com');
    await removeSeatOnRequestComplete.run(
      makeEvent({
        params: { stakeId: STAKE_ID, requestId: 'r1' },
        before: { status: 'pending', type: 'remove', member_canonical: 'alice@gmail.com' },
        after: {
          status: 'complete',
          type: 'remove',
          member_canonical: 'alice@gmail.com',
          seat_member_canonical: 'alice@gmail.com',
        },
      }),
    );
    const { db } = requireEmulators();
    const seat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
    expect(seat.exists).toBe(false);
  });

  it('no-op when seat is already gone (R-1 race)', async () => {
    await removeSeatOnRequestComplete.run(
      makeEvent({
        params: { stakeId: STAKE_ID, requestId: 'r1' },
        before: { status: 'pending', type: 'remove', member_canonical: 'alice@gmail.com' },
        after: {
          status: 'complete',
          type: 'remove',
          member_canonical: 'alice@gmail.com',
          seat_member_canonical: 'alice@gmail.com',
        },
      }),
    );
    // Should not throw; nothing else to assert.
  });

  it('skips non-remove types', async () => {
    await seedSeat('alice@gmail.com');
    await removeSeatOnRequestComplete.run(
      makeEvent({
        params: { stakeId: STAKE_ID, requestId: 'r1' },
        before: { status: 'pending', type: 'add_manual', member_canonical: 'alice@gmail.com' },
        after: { status: 'complete', type: 'add_manual', member_canonical: 'alice@gmail.com' },
      }),
    );
    const { db } = requireEmulators();
    const seat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
    expect(seat.exists).toBe(true);
  });

  it('skips when request was already complete (re-fire)', async () => {
    await seedSeat('alice@gmail.com');
    await removeSeatOnRequestComplete.run(
      makeEvent({
        params: { stakeId: STAKE_ID, requestId: 'r1' },
        before: {
          status: 'complete',
          type: 'remove',
          member_canonical: 'alice@gmail.com',
          seat_member_canonical: 'alice@gmail.com',
        },
        after: {
          status: 'complete',
          type: 'remove',
          member_canonical: 'alice@gmail.com',
          seat_member_canonical: 'alice@gmail.com',
        },
      }),
    );
    const { db } = requireEmulators();
    const seat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
    expect(seat.exists).toBe(true);
  });
});
