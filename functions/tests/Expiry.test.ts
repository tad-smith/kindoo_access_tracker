// Integration tests for daily expiry. Runs against the Firestore
// emulator. Per `docs/spec.md` §7 + the Phase 8 acceptance criteria:
//   - Temp seat with end_date < today → deleted, ExpiryTrigger stamped.
//   - Temp seat with end_date == today → NOT deleted (still alive on
//     the last day; expires the next morning).
//   - Two consecutive runs: second is no-op.
//   - Auto seat (non-temp) → not touched.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Stake } from '@kindoo/shared';
import { runExpiryForStake, todayInTimezone } from '../src/services/Expiry.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';

const STAKE_DOC: Stake = {
  stake_id: STAKE_ID,
  stake_name: 'CS North',
  created_at: Timestamp.now(),
  created_by: 'admin@gmail.com',
  callings_sheet_id: 'sid',
  bootstrap_admin_email: 'admin@gmail.com',
  setup_complete: true,
  stake_seat_cap: 100,
  expiry_hour: 3,
  import_day: 'MONDAY',
  import_hour: 4,
  timezone: 'America/Denver',
  notifications_enabled: true,
  last_over_caps_json: [],
  last_modified_at: Timestamp.now(),
  last_modified_by: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
};

async function seedStake(): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}`).set(STAKE_DOC);
}

async function seedSeat(opts: {
  canonical: string;
  type: 'auto' | 'manual' | 'temp';
  end_date?: string;
}): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/seats/${opts.canonical}`).set({
    member_canonical: opts.canonical,
    member_email: opts.canonical,
    member_name: 'Member',
    scope: 'CO',
    type: opts.type,
    callings: opts.type === 'auto' ? ['Bishop'] : [],
    building_names: ['Cordera Building'],
    duplicate_grants: [],
    ...(opts.end_date ? { end_date: opts.end_date, start_date: '2026-01-01' } : {}),
    ...(opts.type !== 'auto' ? { reason: 'helper', granted_by_request: 'r1' } : {}),
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
    lastActor: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
  });
}

describe.skipIf(!hasEmulators())('Expiry (integration)', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('deletes a temp seat whose end_date is strictly less than today', async () => {
    await seedStake();
    await seedSeat({ canonical: 'expired@gmail.com', type: 'temp', end_date: '1970-01-01' });

    const result = await runExpiryForStake({ stakeId: STAKE_ID });
    expect(result.expired).toBe(1);
    expect(result.ids).toEqual(['expired@gmail.com']);

    const { db } = requireEmulators();
    const snap = await db.doc(`stakes/${STAKE_ID}/seats/expired@gmail.com`).get();
    expect(snap.exists).toBe(false);
  });

  it('preserves a temp seat whose end_date equals today (still alive on last day)', async () => {
    await seedStake();
    const today = todayInTimezone(new Date(), 'America/Denver');
    await seedSeat({ canonical: 'today@gmail.com', type: 'temp', end_date: today });

    const result = await runExpiryForStake({ stakeId: STAKE_ID });
    expect(result.expired).toBe(0);

    const { db } = requireEmulators();
    const snap = await db.doc(`stakes/${STAKE_ID}/seats/today@gmail.com`).get();
    expect(snap.exists).toBe(true);
  });

  it('does not touch auto seats', async () => {
    await seedStake();
    await seedSeat({ canonical: 'auto@gmail.com', type: 'auto' });

    const result = await runExpiryForStake({ stakeId: STAKE_ID });
    expect(result.expired).toBe(0);
    const { db } = requireEmulators();
    const snap = await db.doc(`stakes/${STAKE_ID}/seats/auto@gmail.com`).get();
    expect(snap.exists).toBe(true);
  });

  it('two consecutive runs: the second is a no-op', async () => {
    await seedStake();
    await seedSeat({ canonical: 'expired@gmail.com', type: 'temp', end_date: '1970-01-01' });

    const r1 = await runExpiryForStake({ stakeId: STAKE_ID });
    expect(r1.expired).toBe(1);
    const r2 = await runExpiryForStake({ stakeId: STAKE_ID });
    expect(r2.expired).toBe(0);
  });

  it('writes last_expiry_at + summary to the stake doc on every run', async () => {
    await seedStake();
    await seedSeat({ canonical: 'expired@gmail.com', type: 'temp', end_date: '1970-01-01' });

    await runExpiryForStake({ stakeId: STAKE_ID });
    const { db } = requireEmulators();
    const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
    expect(stake.last_expiry_summary).toMatch(/1 row expired/);
    expect(stake.last_expiry_at).toBeDefined();
  });
});

describe('todayInTimezone', () => {
  it('returns YYYY-MM-DD in the given tz', () => {
    // 2026-04-27 06:00 UTC = 00:00 MDT.
    const date = new Date('2026-04-27T06:00:00Z');
    expect(todayInTimezone(date, 'America/Denver')).toBe('2026-04-27');
  });
});
