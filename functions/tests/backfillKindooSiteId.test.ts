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
    // T-42 / T-43: bob's `duplicate_scopes` mirror is absent in the
    // seed → migration writes `[]` onto it (and alice for kindoo_site_id
    // on the dup + the mirror).
    expect(result.seats_updated).toBe(2);
    expect(result.duplicates_updated).toBe(1);
    expect(result.duplicates_skipped_missing_ward).toBe(0);

    const alice = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    expect(alice.duplicate_grants[0]!.kindoo_site_id).toBe('east-stake');
    // T-42 / T-43: migration backfills the primitive mirror.
    expect(alice.duplicate_scopes).toEqual(['FT']);
    const bob = (await db.doc(`stakes/${STAKE_ID}/seats/bob@gmail.com`).get()).data() as Seat;
    expect(bob.duplicate_scopes).toEqual([]);
  });

  it('T-42 / T-43: migration backfills duplicate_scopes even when no duplicate_grants exist', async () => {
    const { db } = requireEmulators();
    await seedWard({ ward_code: 'CO', kindoo_site_id: null });
    await seedSeat({
      canonical: 'alice@gmail.com',
      scope: 'CO',
      // duplicate_grants default to []; duplicate_scopes field absent.
    });

    const result = await backfillKindooSiteIdForStake(db, STAKE_ID);
    // Primary (CO → home → null) doesn't diff (current absent → null).
    // duplicate_scopes is absent → derived [] → scopesDiffer → seat
    // write fires to land the empty mirror.
    expect(result.seats_updated).toBe(1);

    const alice = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    expect(alice.duplicate_scopes).toEqual([]);
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
    // target is null → no primary diff. Duplicate is skipped because
    // ward 'FT' doesn't resolve, so dupesDiffer stays false. But the
    // duplicate_scopes mirror is absent in the seed → migration
    // backfills it with the surviving (un-changed) duplicate scopes,
    // so one seat write fires.
    expect(result.seats_updated).toBe(1);
    expect(result.duplicates_updated).toBe(0);
    expect(result.duplicates_skipped_missing_ward).toBe(1);
    expect(result.warnings.some((w) => w.includes('alice@gmail.com') && w.includes('FT'))).toBe(
      true,
    );

    // The duplicate entry survives unchanged (no kindoo_site_id was
    // written onto it). The mirror reflects the preserved scope.
    const alice = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    expect(alice.duplicate_grants[0]!.kindoo_site_id).toBeUndefined();
    expect(alice.duplicate_scopes).toEqual(['FT']);
  });

  it('migration writes stamp lastActor=Migration (so auditTrigger fans the dedicated action)', async () => {
    const { db } = requireEmulators();
    await seedWard({ ward_code: 'CO', kindoo_site_id: null });
    // Seat seeded with no kindoo_site_id and no duplicate_scopes
    // (legacy shape). Primary current=null === target=null, but the
    // duplicate_scopes mirror is absent → migration writes `[]` to
    // backfill, and the write stamps `lastActor='Migration'`.
    await seedSeat({
      canonical: 'alice@gmail.com',
      scope: 'CO',
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
    // is written on the primary side. The seat write that does fire
    // backfills the absent `duplicate_scopes` mirror (T-43) — the
    // primary skip is unrelated to the mirror's lifecycle. The
    // primary_kindoo_site_id_skipped counter is the load-bearing
    // assertion here.
    expect(result.primary_kindoo_site_id_skipped).toBe(1);
    expect(result.warnings.some((w) => w.includes('alice@gmail.com') && w.includes('CO'))).toBe(
      true,
    );
    const alice = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    // Critical: kindoo_site_id remains absent. NOT coerced to null.
    expect(alice.kindoo_site_id).toBeUndefined();
    // The mirror backfilled to empty (no duplicates on the seat).
    expect(alice.duplicate_scopes).toEqual([]);
  });
});
