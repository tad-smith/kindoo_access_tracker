// Integration tests for the T-42 one-shot migration callable. Runs
// against the Firestore emulator. Covers:
//
//   - Skip-if-equal idempotence (second run produces zero writes).
//   - Missing-ward duplicate skipped with logged warning.
//   - Migration writes stamp `lastActor.canonical='Migration'` so the
//     auditTrigger emits `action='migration_backfill_kindoo_site_id'`.
//   - Per-stake scoping via the `stakeId` parameter.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Seat } from '@kindoo/shared';
import { backfillKindooSiteIdForStake } from '../src/callable/backfillKindooSiteId.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';
const ACTOR = { email: 'admin@gmail.com', canonical: 'admin@gmail.com' };

async function seedWard(opts: {
  ward_code: string;
  ward_name?: string;
  building_name?: string;
  kindoo_site_id?: string | null;
}): Promise<void> {
  const { db } = requireEmulators();
  const doc: Record<string, unknown> = {
    ward_code: opts.ward_code,
    ward_name: opts.ward_name ?? `${opts.ward_code} Ward`,
    building_name: opts.building_name ?? `${opts.ward_code} Building`,
    seat_cap: 30,
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: ACTOR,
  };
  if (opts.kindoo_site_id !== undefined) doc.kindoo_site_id = opts.kindoo_site_id;
  await db.doc(`stakes/${STAKE_ID}/wards/${opts.ward_code}`).set(doc);
}

async function seedSeat(opts: {
  canonical: string;
  scope: string;
  kindoo_site_id?: string | null;
  duplicate_grants?: Seat['duplicate_grants'];
}): Promise<void> {
  const { db } = requireEmulators();
  const doc: Record<string, unknown> = {
    member_canonical: opts.canonical,
    member_email: opts.canonical,
    member_name: opts.canonical,
    scope: opts.scope,
    type: 'auto',
    callings: ['X'],
    building_names: ['B'],
    duplicate_grants: opts.duplicate_grants ?? [],
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: ACTOR,
    lastActor: ACTOR,
  };
  if (opts.kindoo_site_id !== undefined) doc.kindoo_site_id = opts.kindoo_site_id;
  await db.doc(`stakes/${STAKE_ID}/seats/${opts.canonical}`).set(doc);
}

describe.skipIf(!hasEmulators())('backfillKindooSiteId (integration)', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('writes kindoo_site_id on every duplicate that needs it; primary skip-if-equal treats absent as null', async () => {
    // alice: CO primary (home) + FT duplicate (foreign). Primary
    // current is `null` (field absent → coerces to null in skip-if-
    // equal). Target is also `null`. No primary write fires. But the
    // duplicate's current (`null`) differs from the derived
    // `'east-stake'`, so the seat write fires to update
    // `duplicate_grants`. seats_updated counts the seat doc once.
    //
    // bob: stake primary, no duplicates. Current null, target null.
    // Skip-if-equal → no write.
    const { db } = requireEmulators();
    await seedWard({ ward_code: 'CO', kindoo_site_id: null });
    await seedWard({ ward_code: 'FT', kindoo_site_id: 'east-stake' });
    await seedSeat({
      canonical: 'alice@gmail.com',
      scope: 'CO',
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Bishop'],
          building_names: ['Foothills Building'],
          detected_at: Timestamp.now(),
        },
      ],
    });
    await seedSeat({
      canonical: 'bob@gmail.com',
      scope: 'stake',
    });

    const result = await backfillKindooSiteIdForStake(db, STAKE_ID);
    expect(result.seats_total).toBe(2);
    expect(result.seats_updated).toBe(1); // alice (for dup); bob skipped
    expect(result.duplicates_updated).toBe(1);
    expect(result.duplicates_skipped_missing_ward).toBe(0);

    const alice = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    expect(alice.duplicate_grants[0]!.kindoo_site_id).toBe('east-stake');
  });

  it('updates the primary when stored kindoo_site_id explicitly differs from derived (e.g. operator-typed stale value)', async () => {
    const { db } = requireEmulators();
    await seedWard({ ward_code: 'CO', kindoo_site_id: null });
    // Seat pre-stored with stale `kindoo_site_id='east-stake'` while
    // ward CO is home. Skip-if-equal triggers a write.
    await seedSeat({
      canonical: 'alice@gmail.com',
      scope: 'CO',
      kindoo_site_id: 'east-stake',
    });

    const result = await backfillKindooSiteIdForStake(db, STAKE_ID);
    expect(result.seats_updated).toBe(1);
    const alice = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    expect(alice.kindoo_site_id).toBe(null);
  });

  it('skip-if-equal idempotence: second run writes zero seats', async () => {
    const { db } = requireEmulators();
    await seedWard({ ward_code: 'CO', kindoo_site_id: null });
    await seedWard({ ward_code: 'FT', kindoo_site_id: 'east-stake' });
    await seedSeat({
      canonical: 'alice@gmail.com',
      scope: 'CO',
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Bishop'],
          building_names: ['Foothills Building'],
          detected_at: Timestamp.now(),
        },
      ],
    });

    const first = await backfillKindooSiteIdForStake(db, STAKE_ID);
    expect(first.seats_updated).toBe(1);
    expect(first.duplicates_updated).toBe(1);

    const second = await backfillKindooSiteIdForStake(db, STAKE_ID);
    expect(second.seats_total).toBe(1);
    expect(second.seats_updated).toBe(0);
    expect(second.duplicates_updated).toBe(0);
  });

  it('missing-ward duplicate is skipped with a logged warning (no error)', async () => {
    const { db } = requireEmulators();
    await seedWard({ ward_code: 'CO', kindoo_site_id: null });
    // No FT ward seeded.
    await seedSeat({
      canonical: 'alice@gmail.com',
      scope: 'CO',
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Bishop'],
          building_names: ['Foothills Building'],
          detected_at: Timestamp.now(),
        },
      ],
    });

    const result = await backfillKindooSiteIdForStake(db, STAKE_ID);
    // Primary's stored kindoo_site_id is absent (treated as null) and
    // target is null → no primary diff, no seat write. Duplicate is
    // skipped because ward 'FT' doesn't resolve.
    expect(result.seats_updated).toBe(0);
    expect(result.duplicates_updated).toBe(0);
    expect(result.duplicates_skipped_missing_ward).toBe(1);
    expect(result.warnings.some((w) => w.includes('alice@gmail.com') && w.includes('FT'))).toBe(
      true,
    );

    // The duplicate entry survives unchanged (no kindoo_site_id was
    // written onto it).
    const alice = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    expect(alice.duplicate_grants[0]!.kindoo_site_id).toBeUndefined();
  });

  it('migration writes stamp lastActor=Migration (so auditTrigger fans the dedicated action)', async () => {
    const { db } = requireEmulators();
    await seedWard({ ward_code: 'CO', kindoo_site_id: null });
    // Seed with a STALE `kindoo_site_id` so the skip-if-equal check
    // doesn't short-circuit and a real seat write fires (the test's
    // job is to verify the actor stamp on that write).
    await seedSeat({
      canonical: 'alice@gmail.com',
      scope: 'CO',
      kindoo_site_id: 'stale-site-id',
    });

    await backfillKindooSiteIdForStake(db, STAKE_ID);

    const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Record<
      string,
      unknown
    >;
    expect(seat['lastActor']).toEqual({ email: 'Migration', canonical: 'Migration' });
  });

  it('skips primary-side write with a warning when the seat scope does not resolve to a known ward', async () => {
    const { db } = requireEmulators();
    // Seat references CO but no CO ward exists.
    await seedSeat({ canonical: 'alice@gmail.com', scope: 'CO' });

    const result = await backfillKindooSiteIdForStake(db, STAKE_ID);
    // Uniform missing-ward skip-with-warning policy: no kindoo_site_id
    // written on the primary side, no seat update fires, downstream
    // ward-fallback handles classification at read time.
    expect(result.seats_updated).toBe(0);
    expect(result.seats_skipped_missing_ward).toBe(1);
    expect(result.warnings.some((w) => w.includes('alice@gmail.com') && w.includes('CO'))).toBe(
      true,
    );
    const alice = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    expect(alice.kindoo_site_id).toBeUndefined();
  });
});
