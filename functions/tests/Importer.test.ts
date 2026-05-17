// Integration tests for the Importer service. Runs against the
// Firestore + Auth emulators. The Sheets API client is replaced with
// a fixture fetcher so tests don't make real HTTP calls.
//
// Coverage:
//   - Full cycle against fixture LCR sheet → expected access + seats.
//   - Idempotency: second run with no source changes → no diffs.
//   - Source change → exactly one delete + one insert.
//   - Removed calling → matching auto-seats deleted.
//   - Manual access row survives import; manual_grants untouched.
//   - Per-row audit rows tagged actor='Importer' (via direct trigger).
//   - Over-cap: snapshot persisted; over_cap_warning audit row written.
//   - Multi-calling person → one seat doc with callings[] array.
//   - Cross-scope (stake + ward) → primary stake; ward in duplicate_grants.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Access, Seat, Stake } from '@kindoo/shared';
import { runImporterForStake } from '../src/services/Importer.js';
import { _setSheetFetcher, type SheetTab } from '../src/lib/sheets.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';

function fixture(rows: SheetTab[]): () => void {
  return _setSheetFetcher(async () => rows);
}

const STAKE_DOC: Stake = {
  stake_id: STAKE_ID,
  stake_name: 'CS North',
  created_at: Timestamp.now(),
  created_by: 'admin@gmail.com',
  callings_sheet_id: 'fixture-sheet',
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

async function seedStake(opts: { stakeSeatCap?: number } = {}): Promise<void> {
  const { db } = requireEmulators();
  const stake: Stake = { ...STAKE_DOC, stake_seat_cap: opts.stakeSeatCap ?? 100 };
  await db.doc(`stakes/${STAKE_ID}`).set(stake);
  await db.doc(`stakes/${STAKE_ID}/wards/CO`).set({
    ward_code: 'CO',
    ward_name: 'Cordera',
    building_name: 'Cordera Building',
    seat_cap: 20,
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
  await db.doc(`stakes/${STAKE_ID}/wards/BR`).set({
    ward_code: 'BR',
    ward_name: 'Briargate',
    building_name: 'Briargate Building',
    seat_cap: 20,
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
  await db.doc(`stakes/${STAKE_ID}/buildings/cordera-building`).set({
    building_id: 'cordera-building',
    building_name: 'Cordera Building',
    address: '',
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
  await db.doc(`stakes/${STAKE_ID}/buildings/briargate-building`).set({
    building_id: 'briargate-building',
    building_name: 'Briargate Building',
    address: '',
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
  await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/Bishop`).set({
    calling_name: 'Bishop',
    give_app_access: true,
    auto_kindoo_access: true,
    sheet_order: 1,
    created_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
  await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/Bishopric%20Secretary`).set({
    calling_name: 'Bishopric Secretary',
    give_app_access: false,
    auto_kindoo_access: true,
    sheet_order: 2,
    created_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
  await db.doc(`stakes/${STAKE_ID}/stakeCallingTemplates/Stake%20President`).set({
    calling_name: 'Stake President',
    give_app_access: true,
    auto_kindoo_access: true,
    sheet_order: 1,
    created_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
}

const HEADER_ROW = ['Organization', 'Forwarding Email', 'Position', 'Name', 'Personal Email'];

describe.skipIf(!hasEmulators())('Importer (integration)', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('full cycle: parses fixture sheet, writes access + auto seats, persists summary', async () => {
    await seedStake();
    const restore = fixture([
      {
        name: 'CO',
        values: [
          HEADER_ROW,
          ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com'],
          ['CO', '', 'CO Bishopric Secretary', 'Bob Jones', 'bob@gmail.com'],
        ],
      },
      {
        name: 'Stake',
        values: [HEADER_ROW, ['Stake', '', 'Stake President', 'Carol Nguyen', 'carol@gmail.com']],
      },
    ]);

    try {
      const result = await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      expect(result.ok).toBe(true);
      expect(result.inserted).toBe(3);

      const { db } = requireEmulators();

      const aliceSeat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
      expect(aliceSeat.exists).toBe(true);
      const ad = aliceSeat.data()!;
      expect(ad['scope']).toBe('CO');
      expect(ad['type']).toBe('auto');
      expect(ad['callings']).toEqual(['Bishop']);
      expect(ad['lastActor']).toEqual({ email: 'Importer', canonical: 'Importer' });

      const aliceAccess = await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).get();
      expect(aliceAccess.exists).toBe(true);
      expect(aliceAccess.data()!['importer_callings']).toEqual({ CO: ['Bishop'] });
      expect(aliceAccess.data()!['manual_grants']).toEqual({});

      const bobAccess = await db.doc(`stakes/${STAKE_ID}/access/bob@gmail.com`).get();
      // Bishopric Secretary has give_app_access=false → no access doc
      expect(bobAccess.exists).toBe(false);

      const carolSeat = await db.doc(`stakes/${STAKE_ID}/seats/carol@gmail.com`).get();
      expect(carolSeat.exists).toBe(true);
      expect(carolSeat.data()!['scope']).toBe('stake');

      const stake = await db.doc(`stakes/${STAKE_ID}`).get();
      const sd = stake.data() as Stake;
      expect(sd.last_import_summary).toMatch(/3 inserts/);
      expect(sd.last_over_caps_json).toEqual([]);
    } finally {
      restore();
    }
  });

  it('idempotency: second run with no changes → zero inserts/deletes', async () => {
    await seedStake();
    const restore = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      const r1 = await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      expect(r1.inserted).toBe(1);

      const r2 = await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      expect(r2.inserted).toBe(0);
      expect(r2.deleted).toBe(0);
      expect(r2.updated).toBe(0);
    } finally {
      restore();
    }
  });

  it('source change: one email swap → one delete + one insert', async () => {
    await seedStake();
    const restoreA = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
    } finally {
      restoreA();
    }

    const restoreB = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Bob Jones', 'bob@gmail.com']],
      },
    ]);
    try {
      const r = await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      expect(r.inserted).toBe(1);
      expect(r.deleted).toBe(1);

      const { db } = requireEmulators();
      const aliceSeat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
      const bobSeat = await db.doc(`stakes/${STAKE_ID}/seats/bob@gmail.com`).get();
      expect(aliceSeat.exists).toBe(false);
      expect(bobSeat.exists).toBe(true);
    } finally {
      restoreB();
    }
  });

  it('manual_grants survive an import that empties importer_callings', async () => {
    await seedStake();
    const { db } = requireEmulators();

    // Pre-seed access doc with both importer + manual entries.
    await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).set({
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      importer_callings: { CO: ['Bishop'] },
      manual_grants: {
        BR: [
          {
            grant_id: 'g1',
            reason: 'helping out',
            granted_by: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
            granted_at: Timestamp.now(),
          },
        ],
      },
      created_at: Timestamp.now(),
      last_modified_at: Timestamp.now(),
      last_modified_by: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });

    // Now run import with NO rows for Alice — importer_callings should empty,
    // but manual_grants should survive.
    const restore = fixture([{ name: 'CO', values: [HEADER_ROW] }]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
    } finally {
      restore();
    }

    const access = await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).get();
    expect(access.exists).toBe(true);
    const ad = access.data() as Access;
    expect(ad.importer_callings).toEqual({});
    expect(ad.manual_grants['BR']).toHaveLength(1);
  });

  it('multi-calling person → one seat doc with callings[] array', async () => {
    await seedStake();
    const restore = fixture([
      {
        name: 'CO',
        values: [
          HEADER_ROW,
          ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com'],
          ['CO', '', 'CO Bishopric Secretary', 'Alice Smith', 'alice@gmail.com'],
        ],
      },
    ]);
    try {
      const r = await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      expect(r.inserted).toBe(1);
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.callings.sort()).toEqual(['Bishop', 'Bishopric Secretary']);
    } finally {
      restore();
    }
  });

  it('cross-scope (stake + ward) → primary stake, ward in duplicate_grants', async () => {
    await seedStake();
    const restore = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
      {
        name: 'Stake',
        values: [HEADER_ROW, ['Stake', '', 'Stake President', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.scope).toBe('stake');
      expect(seat.callings).toEqual(['Stake President']);
      expect(seat.duplicate_grants).toHaveLength(1);
      expect(seat.duplicate_grants[0]!.scope).toBe('CO');
    } finally {
      restore();
    }
  });

  // ----- T-42 multi-site importer fan-out -----
  //
  // Acceptance #3, #4, #5: per (scope, kindoo_site_id) duplicates,
  // parallel-site duplicates carry building_names, top-level
  // kindoo_site_id is written on every importer-produced seat.

  it('T-42 / T-43: every importer-produced seat carries duplicate_scopes mirroring duplicate_grants[].scope', async () => {
    await seedStake();
    const { db } = requireEmulators();
    await db.doc(`stakes/${STAKE_ID}/wards/FT`).set({
      ward_code: 'FT',
      ward_name: 'Foothills',
      building_name: 'Foothills Building',
      seat_cap: 20,
      kindoo_site_id: 'east-stake',
      created_at: Timestamp.now(),
      last_modified_at: Timestamp.now(),
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });
    await db.doc(`stakes/${STAKE_ID}/buildings/foothills-building`).set({
      building_id: 'foothills-building',
      building_name: 'Foothills Building',
      address: '',
      kindoo_site_id: 'east-stake',
      created_at: Timestamp.now(),
      last_modified_at: Timestamp.now(),
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });
    const restore = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
      {
        name: 'FT',
        values: [HEADER_ROW, ['FT', '', 'FT Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
      {
        name: 'BR',
        values: [HEADER_ROW, ['BR', '', 'BR Bishop', 'Bob Jones', 'bob@gmail.com']],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      // alice has primary CO + one duplicate FT.
      const alice = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(alice.duplicate_scopes).toEqual(alice.duplicate_grants.map((d) => d.scope));
      expect(alice.duplicate_scopes!.sort()).toEqual(['FT']);
      // bob has no duplicates → empty mirror.
      const bob = (await db.doc(`stakes/${STAKE_ID}/seats/bob@gmail.com`).get()).data() as Seat;
      expect(bob.duplicate_scopes).toEqual([]);
    } finally {
      restore();
    }
  });

  it('T-42: multi-site person → primary stake (home) + parallel foreign duplicate carrying building_names + kindoo_site_id', async () => {
    await seedStake();
    const { db } = requireEmulators();
    // Add a foreign-site ward FT bound to 'east-stake'.
    await db.doc(`stakes/${STAKE_ID}/wards/FT`).set({
      ward_code: 'FT',
      ward_name: 'Foothills',
      building_name: 'Foothills Building',
      seat_cap: 20,
      kindoo_site_id: 'east-stake',
      created_at: Timestamp.now(),
      last_modified_at: Timestamp.now(),
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });
    // Add the foreign-site building.
    await db.doc(`stakes/${STAKE_ID}/buildings/foothills-building`).set({
      building_id: 'foothills-building',
      building_name: 'Foothills Building',
      address: '',
      kindoo_site_id: 'east-stake',
      created_at: Timestamp.now(),
      last_modified_at: Timestamp.now(),
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });
    // Alice: Stake President (home) + Bishop (FT, foreign-site).
    const restore = fixture([
      {
        name: 'Stake',
        values: [HEADER_ROW, ['Stake', '', 'Stake President', 'Alice Smith', 'alice@gmail.com']],
      },
      {
        name: 'FT',
        values: [HEADER_ROW, ['FT', '', 'FT Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      // Primary: stake-scope (home).
      expect(seat.scope).toBe('stake');
      expect(seat.kindoo_site_id).toBe(null);
      // One duplicate: FT, foreign-site, building_names carries Foothills.
      expect(seat.duplicate_grants).toHaveLength(1);
      const dup = seat.duplicate_grants[0]!;
      expect(dup.scope).toBe('FT');
      expect(dup.kindoo_site_id).toBe('east-stake');
      expect(dup.callings).toEqual(['Bishop']);
      expect(dup.building_names).toEqual(['Foothills Building']);
    } finally {
      restore();
    }
  });

  it('T-42: ward primary (home) + ward duplicate (same foreign site) → both in fan-out with site stamped', async () => {
    await seedStake();
    const { db } = requireEmulators();
    await db.doc(`stakes/${STAKE_ID}/wards/FT`).set({
      ward_code: 'FT',
      ward_name: 'Foothills',
      building_name: 'Foothills Building',
      seat_cap: 20,
      kindoo_site_id: 'east-stake',
      created_at: Timestamp.now(),
      last_modified_at: Timestamp.now(),
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });
    await db.doc(`stakes/${STAKE_ID}/buildings/foothills-building`).set({
      building_id: 'foothills-building',
      building_name: 'Foothills Building',
      address: '',
      kindoo_site_id: 'east-stake',
      created_at: Timestamp.now(),
      last_modified_at: Timestamp.now(),
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });
    const restore = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
      {
        name: 'FT',
        values: [HEADER_ROW, ['FT', '', 'FT Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      // Primary: alphabetically first ward (BR is seeded but no
      // calling for Alice there). Among CO, FT → CO wins (alpha).
      expect(seat.scope).toBe('CO');
      expect(seat.kindoo_site_id).toBe(null);
      expect(seat.duplicate_grants).toHaveLength(1);
      const dup = seat.duplicate_grants[0]!;
      expect(dup.scope).toBe('FT');
      expect(dup.kindoo_site_id).toBe('east-stake');
      // Parallel-site duplicate carries `building_names`.
      expect(dup.building_names).toEqual(['Foothills Building']);
    } finally {
      restore();
    }
  });

  it('T-42: within-site duplicate (same site as primary) inherits buildings; carries primary kindoo_site_id', async () => {
    await seedStake();
    const restore = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
      {
        name: 'BR',
        values: [HEADER_ROW, ['BR', '', 'BR Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      const { db } = requireEmulators();
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      // Both CO and BR are home (no kindoo_site_id on wards). Primary
      // is BR (alpha).
      expect(seat.scope).toBe('BR');
      expect(seat.kindoo_site_id).toBe(null);
      expect(seat.duplicate_grants).toHaveLength(1);
      const dup = seat.duplicate_grants[0]!;
      expect(dup.scope).toBe('CO');
      // Same site as primary → kindoo_site_id matches; building_names
      // unset (within-site duplicates inherit from the ward at runtime).
      expect(dup.kindoo_site_id).toBe(null);
      expect(dup.building_names).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('T-42: stake-scope seat at home site gets only home buildings (foreign building excluded)', async () => {
    await seedStake();
    const { db } = requireEmulators();
    // Seed a foreign-site building so the stake-buildings list has a
    // candidate to exclude.
    await db.doc(`stakes/${STAKE_ID}/buildings/foothills-building`).set({
      building_id: 'foothills-building',
      building_name: 'Foothills Building',
      address: '',
      kindoo_site_id: 'east-stake',
      created_at: Timestamp.now(),
      last_modified_at: Timestamp.now(),
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });
    const restore = fixture([
      {
        name: 'Stake',
        values: [HEADER_ROW, ['Stake', '', 'Stake President', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      // Stake-scope grant should NOT include the foreign building.
      expect(seat.building_names.sort()).toEqual(['Briargate Building', 'Cordera Building']);
      expect(seat.building_names).not.toContain('Foothills Building');
    } finally {
      restore();
    }
  });

  it('over-cap: persists snapshot AND emits over_cap_warning audit row', async () => {
    await seedStake({ stakeSeatCap: 1 });
    const rows = [HEADER_ROW];
    for (let i = 0; i < 25; i++) {
      rows.push(['CO', '', 'CO Bishop', `Member ${i}`, `m${i}@gmail.com`]);
    }
    const restore = fixture([{ name: 'CO', values: rows }]);
    try {
      const r = await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      expect(r.over_caps.length).toBeGreaterThan(0);
      const { db } = requireEmulators();
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
      expect(stake.last_over_caps_json.length).toBeGreaterThan(0);

      // over_cap_warning audit row should have been written directly.
      const audits = await db
        .collection(`stakes/${STAKE_ID}/auditLog`)
        .where('action', '==', 'over_cap_warning')
        .get();
      expect(audits.size).toBe(1);
    } finally {
      restore();
    }
  });

  it('over-cap clears: subsequent run with no over-cap → snapshot empty', async () => {
    await seedStake({ stakeSeatCap: 1 });
    const overRows = [HEADER_ROW];
    for (let i = 0; i < 25; i++) {
      overRows.push(['CO', '', 'CO Bishop', `Member ${i}`, `m${i}@gmail.com`]);
    }
    const restoreA = fixture([{ name: 'CO', values: overRows }]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
    } finally {
      restoreA();
    }

    const restoreB = fixture([{ name: 'CO', values: [HEADER_ROW] }]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      const { db } = requireEmulators();
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
      expect(stake.last_over_caps_json).toEqual([]);
    } finally {
      restoreB();
    }
  });

  it('import_start + import_end audit rows bracket every run', async () => {
    await seedStake();
    const restore = fixture([{ name: 'CO', values: [HEADER_ROW] }]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test-actor' });
      const { db } = requireEmulators();
      const start = await db
        .collection(`stakes/${STAKE_ID}/auditLog`)
        .where('action', '==', 'import_start')
        .get();
      const end = await db
        .collection(`stakes/${STAKE_ID}/auditLog`)
        .where('action', '==', 'import_end')
        .get();
      expect(start.size).toBe(1);
      expect(end.size).toBe(1);
      expect((start.docs[0]!.data() as { actor_canonical: string }).actor_canonical).toBe(
        'Importer',
      );
    } finally {
      restore();
    }
  });

  it('skips a stake whose callings_sheet_id is unset', async () => {
    const { db } = requireEmulators();
    await db.doc(`stakes/${STAKE_ID}`).set({ ...STAKE_DOC, callings_sheet_id: '' });
    await expect(runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' })).rejects.toThrow(
      /callings_sheet_id is not set/,
    );
  });

  it('removed calling from template → matching auto-seat deleted', async () => {
    await seedStake();
    const r1 = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
    } finally {
      r1();
    }

    const { db } = requireEmulators();
    await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/Bishop`).delete();

    const r2 = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      const result = await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      expect(result.deleted).toBe(1);
    } finally {
      r2();
    }
    const seat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
    expect(seat.exists).toBe(false);
  });

  it('seat + access docs carry sort_order denormalised from matched template sheet_order', async () => {
    await seedStake();
    const restore = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
      {
        name: 'Stake',
        values: [HEADER_ROW, ['Stake', '', 'Stake President', 'Carol Nguyen', 'carol@gmail.com']],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      const { db } = requireEmulators();
      const aliceSeat = (
        await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()
      ).data() as Seat;
      // Bishop template seeded with sheet_order=1.
      expect(aliceSeat.sort_order).toBe(1);
      const aliceAccess = (
        await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).get()
      ).data() as Access;
      expect(aliceAccess.sort_order).toBe(1);

      const carolSeat = (
        await db.doc(`stakes/${STAKE_ID}/seats/carol@gmail.com`).get()
      ).data() as Seat;
      // Stake President template seeded with sheet_order=1.
      expect(carolSeat.sort_order).toBe(1);
    } finally {
      restore();
    }
  });

  it('multi-calling collapse → sort_order = MIN across the seat callings', async () => {
    await seedStake();
    const { db } = requireEmulators();
    // Add a higher-sheet_order template so the MIN is exercised.
    await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/High%20Councilor`).set({
      calling_name: 'High Councilor',
      give_app_access: true,
      auto_kindoo_access: true,
      sheet_order: 5,
      created_at: Timestamp.now(),
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });
    const restore = fixture([
      {
        name: 'CO',
        values: [
          HEADER_ROW,
          ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com'],
          ['CO', '', 'CO High Councilor', 'Alice Smith', 'alice@gmail.com'],
        ],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.callings.sort()).toEqual(['Bishop', 'High Councilor']);
      // Bishop=1, High Councilor=5 → MIN=1.
      expect(seat.sort_order).toBe(1);
      const access = (
        await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).get()
      ).data() as Access;
      expect(access.sort_order).toBe(1);
    } finally {
      restore();
    }
  });

  it('manual seat already exists → importer does not touch its sort_order (stays null)', async () => {
    await seedStake();
    const { db } = requireEmulators();
    // Pre-seed a manual seat with sort_order: null.
    await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).set({
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      scope: 'CO',
      type: 'manual',
      callings: [],
      reason: 'helper',
      building_names: ['Cordera Building'],
      duplicate_grants: [],
      sort_order: null,
      granted_by_request: 'req-x',
      created_at: Timestamp.now(),
      last_modified_at: Timestamp.now(),
      last_modified_by: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
      lastActor: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
    });
    const restore = fixture([{ name: 'CO', values: [HEADER_ROW] }]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
    } finally {
      restore();
    }
    const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    expect(seat.type).toBe('manual');
    expect(seat.sort_order ?? null).toBeNull();
  });

  it('access doc with manual_grants only after import → sort_order=null', async () => {
    await seedStake();
    const { db } = requireEmulators();
    await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).set({
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      importer_callings: { CO: ['Bishop'] },
      manual_grants: {
        BR: [
          {
            grant_id: 'g1',
            reason: 'helping out',
            granted_by: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
            granted_at: Timestamp.now(),
          },
        ],
      },
      sort_order: 1,
      created_at: Timestamp.now(),
      last_modified_at: Timestamp.now(),
      last_modified_by: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });
    const restore = fixture([{ name: 'CO', values: [HEADER_ROW] }]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
    } finally {
      restore();
    }
    const access = (
      await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).get()
    ).data() as Access;
    expect(access.importer_callings).toEqual({});
    expect(access.sort_order ?? null).toBeNull();
  });

  it('template sheet_order change between runs → seat + access docs get sort_order update', async () => {
    await seedStake();
    const { db } = requireEmulators();
    const r1 = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
    } finally {
      r1();
    }
    const seat1 = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    expect(seat1.sort_order).toBe(1);

    // Bump the template's sheet_order from 1 to 7.
    await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/Bishop`).set(
      {
        sheet_order: 7,
        last_modified_at: Timestamp.now(),
        lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      },
      { merge: true },
    );

    const r2 = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      const result = await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      // Counts as an update on the seat AND access doc.
      expect(result.updated).toBeGreaterThanOrEqual(1);
    } finally {
      r2();
    }
    const seat2 = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
    expect(seat2.sort_order).toBe(7);
    const access2 = (
      await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).get()
    ).data() as Access;
    expect(access2.sort_order).toBe(7);
  });

  it('importer-written docs carry lastActor=Importer for the audit trigger', async () => {
    // The audit trigger isn't running automatically (we test against
    // firestore+auth emulators only). Verify the stamped lastActor
    // would feed through the trigger as actor=Importer.
    await seedStake();
    const restore = fixture([
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ]);
    try {
      await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
    } finally {
      restore();
    }

    const { db } = requireEmulators();
    const seat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
    expect((seat.data() as Record<string, unknown>)['lastActor']).toEqual({
      email: 'Importer',
      canonical: 'Importer',
    });

    const access = await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).get();
    expect((access.data() as Record<string, unknown>)['lastActor']).toEqual({
      email: 'Importer',
      canonical: 'Importer',
    });
  });

  describe('auto_kindoo_access flag', () => {
    it('flag matrix: give=T/auto=T, give=T/auto=F, give=F/auto=T, give=F/auto=F', async () => {
      await seedStake();
      const { db } = requireEmulators();

      // Re-seed templates with each combo. Use distinct calling names.
      await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/AccessAndSeat`).set({
        calling_name: 'AccessAndSeat',
        give_app_access: true,
        auto_kindoo_access: true,
        sheet_order: 10,
        created_at: Timestamp.now(),
        lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      });
      await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/AccessOnly`).set({
        calling_name: 'AccessOnly',
        give_app_access: true,
        auto_kindoo_access: false,
        sheet_order: 11,
        created_at: Timestamp.now(),
        lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      });
      await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/SeatOnly`).set({
        calling_name: 'SeatOnly',
        give_app_access: false,
        auto_kindoo_access: true,
        sheet_order: 12,
        created_at: Timestamp.now(),
        lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      });
      await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/Neither`).set({
        calling_name: 'Neither',
        give_app_access: false,
        auto_kindoo_access: false,
        sheet_order: 13,
        created_at: Timestamp.now(),
        lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      });

      const restore = fixture([
        {
          name: 'CO',
          values: [
            HEADER_ROW,
            ['CO', '', 'CO AccessAndSeat', 'Alice', 'alice@gmail.com'],
            ['CO', '', 'CO AccessOnly', 'Bob', 'bob@gmail.com'],
            ['CO', '', 'CO SeatOnly', 'Carol', 'carol@gmail.com'],
            ['CO', '', 'CO Neither', 'Dan', 'dan@gmail.com'],
          ],
        },
      ]);
      try {
        await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      } finally {
        restore();
      }

      // Alice: access + seat.
      expect((await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).exists).toBe(true);
      expect((await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).get()).exists).toBe(true);
      // Bob: access only, no seat.
      expect((await db.doc(`stakes/${STAKE_ID}/seats/bob@gmail.com`).get()).exists).toBe(false);
      expect((await db.doc(`stakes/${STAKE_ID}/access/bob@gmail.com`).get()).exists).toBe(true);
      // Carol: seat only, no access.
      expect((await db.doc(`stakes/${STAKE_ID}/seats/carol@gmail.com`).get()).exists).toBe(true);
      expect((await db.doc(`stakes/${STAKE_ID}/access/carol@gmail.com`).get()).exists).toBe(false);
      // Dan: neither.
      expect((await db.doc(`stakes/${STAKE_ID}/seats/dan@gmail.com`).get()).exists).toBe(false);
      expect((await db.doc(`stakes/${STAKE_ID}/access/dan@gmail.com`).get()).exists).toBe(false);
    });

    it('stale-deletion: existing auto seat whose template flips auto_kindoo_access=false → seat deleted', async () => {
      await seedStake();
      const { db } = requireEmulators();

      // First run: Bishop has auto_kindoo_access=true (seeded). Seat created.
      const r1 = fixture([
        {
          name: 'CO',
          values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
        },
      ]);
      try {
        await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      } finally {
        r1();
      }
      expect((await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).exists).toBe(true);

      // Flip the template flag to false. give_app_access stays true so the
      // access doc isn't disturbed.
      await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/Bishop`).set(
        {
          auto_kindoo_access: false,
          last_modified_at: Timestamp.now(),
          lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
        },
        { merge: true },
      );

      const r2 = fixture([
        {
          name: 'CO',
          values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
        },
      ]);
      try {
        const result = await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
        expect(result.deleted).toBe(1);
      } finally {
        r2();
      }
      expect((await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).exists).toBe(false);
      // Access doc survives (give_app_access=true).
      expect((await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).get()).exists).toBe(true);
    });

    it('mixed callings: one flagged, one not → seat persists with only the flagged calling; sort_order reflects it', async () => {
      await seedStake();
      const { db } = requireEmulators();

      // Add High Councilor template with auto=false. Bishop auto=true.
      await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/High%20Councilor`).set({
        calling_name: 'High Councilor',
        give_app_access: true,
        auto_kindoo_access: false,
        sheet_order: 5,
        created_at: Timestamp.now(),
        lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      });

      const restore = fixture([
        {
          name: 'CO',
          values: [
            HEADER_ROW,
            ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com'],
            ['CO', '', 'CO High Councilor', 'Alice Smith', 'alice@gmail.com'],
          ],
        },
      ]);
      try {
        await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      } finally {
        restore();
      }

      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.callings).toEqual(['Bishop']);
      // Bishop sheet_order=1.
      expect(seat.sort_order).toBe(1);

      // Access still includes both callings (give_app_access=true on both).
      const access = (
        await db.doc(`stakes/${STAKE_ID}/access/alice@gmail.com`).get()
      ).data() as Access;
      expect(access.importer_callings['CO']?.sort()).toEqual(['Bishop', 'High Councilor']);
    });

    it('two flagged callings of differing sheet_order → seat sort_order = MIN', async () => {
      await seedStake();
      const { db } = requireEmulators();

      await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/High%20Councilor`).set({
        calling_name: 'High Councilor',
        give_app_access: true,
        auto_kindoo_access: true,
        sheet_order: 5,
        created_at: Timestamp.now(),
        lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      });

      const restore = fixture([
        {
          name: 'CO',
          values: [
            HEADER_ROW,
            ['CO', '', 'CO Bishop', 'Alice', 'alice@gmail.com'],
            ['CO', '', 'CO High Councilor', 'Alice', 'alice@gmail.com'],
          ],
        },
      ]);
      try {
        await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      } finally {
        restore();
      }
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.callings.sort()).toEqual(['Bishop', 'High Councilor']);
      expect(seat.sort_order).toBe(1);
    });

    it('idempotency with mixed flagged/unflagged: rerun with no source change → zero writes', async () => {
      await seedStake();
      const { db } = requireEmulators();

      await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/High%20Councilor`).set({
        calling_name: 'High Councilor',
        give_app_access: true,
        auto_kindoo_access: false,
        sheet_order: 5,
        created_at: Timestamp.now(),
        lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      });

      const sheet = [
        {
          name: 'CO',
          values: [
            HEADER_ROW,
            ['CO', '', 'CO Bishop', 'Alice', 'alice@gmail.com'],
            ['CO', '', 'CO High Councilor', 'Alice', 'alice@gmail.com'],
          ],
        },
      ];
      const r1 = fixture(sheet);
      try {
        await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
      } finally {
        r1();
      }

      const r2 = fixture(sheet);
      try {
        const result = await runImporterForStake({ stakeId: STAKE_ID, triggeredBy: 'test' });
        expect(result.inserted).toBe(0);
        expect(result.deleted).toBe(0);
        expect(result.updated).toBe(0);
      } finally {
        r2();
      }
    });
  });
});
