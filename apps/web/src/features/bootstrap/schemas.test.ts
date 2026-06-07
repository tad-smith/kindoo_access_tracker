// Schema tests for the bootstrap-wizard forms. Each step's schema runs
// against representative inputs (valid + invalid) so the forms surface
// the expected validation errors without round-tripping through React.

import { describe, expect, it } from 'vitest';
import { buildingSchema, managerSchema, step1Schema, wardSchema } from './schemas';

describe('step1Schema', () => {
  it('accepts a valid stake setup', () => {
    const out = step1Schema.parse({
      stake_name: 'My Stake',
      stake_seat_cap: 200,
    });
    expect(out.stake_name).toBe('My Stake');
  });

  it('rejects a blank stake name', () => {
    const r = step1Schema.safeParse({
      stake_name: '   ',
      stake_seat_cap: 0,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a negative seat cap', () => {
    const r = step1Schema.safeParse({
      stake_name: 'X',
      stake_seat_cap: -1,
    });
    expect(r.success).toBe(false);
  });

  it('strips an unknown callings_sheet_id field from the parsed output (T-45 removed)', () => {
    // Step 1 no longer collects a sheet ID. zod object schemas without
    // `.strict()` silently drop unknown keys, so feeding the legacy
    // field in must yield a parsed output that does not carry it.
    const r = step1Schema.parse({
      stake_name: 'My Stake',
      stake_seat_cap: 200,
      callings_sheet_id: 'leftover-from-pre-t-45',
    } as unknown as {
      stake_name: string;
      stake_seat_cap: number;
    });
    expect('callings_sheet_id' in r).toBe(false);
  });
});

describe('buildingSchema', () => {
  it('accepts a building with name + address', () => {
    const r = buildingSchema.safeParse({ building_name: 'Main', address: '1 St' });
    expect(r.success).toBe(true);
  });
  it('rejects empty name', () => {
    const r = buildingSchema.safeParse({ building_name: '', address: 'X' });
    expect(r.success).toBe(false);
  });
});

describe('wardSchema', () => {
  it('accepts a valid ward (no ward_code input — it is derived from the name)', () => {
    const r = wardSchema.safeParse({
      ward_name: 'Maple',
      // The form value is the immutable building_id slug.
      building_id: 'main',
      seat_cap: 20,
    });
    expect(r.success).toBe(true);
  });
  it('rejects an empty ward name', () => {
    const r = wardSchema.safeParse({
      ward_name: '   ',
      building_id: 'main',
      seat_cap: 1,
    });
    expect(r.success).toBe(false);
  });
  it('rejects an empty building reference', () => {
    const r = wardSchema.safeParse({
      ward_name: 'X',
      building_id: '',
      seat_cap: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe('managerSchema', () => {
  it('accepts a valid manager', () => {
    const r = managerSchema.safeParse({
      member_email: 'm@example.com',
      name: 'M',
    });
    expect(r.success).toBe(true);
  });
  it('rejects malformed emails', () => {
    const r = managerSchema.safeParse({
      member_email: 'not-an-email',
      name: 'M',
    });
    expect(r.success).toBe(false);
  });
});
