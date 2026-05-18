// Integration tests for the scheduled-job dispatchers. They loop over
// stakes and call the per-stake services for those whose schedule
// matches "now". We can't pin the runtime clock, so the tests verify
// dispatch behaviour at the loop level: a stake with setup_complete
// =false is ALWAYS skipped regardless of schedule.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Stake } from '@kindoo/shared';
import { runExpiry } from '../src/scheduled/runExpiry.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';

const STAKE_DOC: Stake = {
  stake_id: STAKE_ID,
  stake_name: 'CS North',
  created_at: Timestamp.now(),
  created_by: 'admin@gmail.com',
  bootstrap_admin_email: 'admin@gmail.com',
  setup_complete: false, // ⚠️ intentionally false for the skip test
  stake_seat_cap: 100,
  expiry_hour: 3,
  timezone: 'America/Denver',
  notifications_enabled: true,
  last_over_caps_json: [],
  last_modified_at: Timestamp.now(),
  last_modified_by: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
};

function syntheticEvent(): never {
  // The scheduled handler only consults event-time-derived things via
  // `new Date()`, not via the event payload itself. Pass a structurally-
  // sufficient stub.
  return {
    scheduleTime: new Date().toISOString(),
    jobName: 'test',
  } as unknown as never;
}

describe.skipIf(!hasEmulators())('scheduled dispatchers', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('runExpiry: stake with setup_complete=false → skipped', async () => {
    const { db } = requireEmulators();
    await db.doc(`stakes/${STAKE_ID}`).set(STAKE_DOC);

    await runExpiry.run(syntheticEvent());

    const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
    expect(stake.last_expiry_at).toBeUndefined();
  });
});
