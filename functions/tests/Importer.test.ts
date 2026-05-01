// Integration tests for the Importer service. Runs against the
// Firestore + Auth emulators. The Sheets API client is replaced with
// a fixture fetcher so tests don't make real HTTP calls.
//
// Coverage targets the Phase 8 acceptance criteria:
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
    sheet_order: 1,
    created_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
  await db.doc(`stakes/${STAKE_ID}/wardCallingTemplates/Bishopric%20Secretary`).set({
    calling_name: 'Bishopric Secretary',
    give_app_access: false,
    sheet_order: 2,
    created_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
  await db.doc(`stakes/${STAKE_ID}/stakeCallingTemplates/Stake%20President`).set({
    calling_name: 'Stake President',
    give_app_access: true,
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
});
