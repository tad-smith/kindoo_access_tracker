// Schema tests for the bootstrap-wizard forms. Each step's schema runs
// against representative inputs (valid + invalid) so the forms surface
// the expected validation errors without round-tripping through React.

import { describe, expect, it } from 'vitest';
import { buildingSchema, managerSchema, step1Schema, wardSchema } from './schemas';

describe('step1Schema', () => {
  it('accepts a valid stake setup', () => {
    const out = step1Schema.parse({
      stake_name: 'My Stake',
      callings_sheet_id: 'abc123',
      stake_seat_cap: 200,
    });
    expect(out.stake_name).toBe('My Stake');
  });

  it('rejects a blank stake name', () => {
    const r = step1Schema.safeParse({
      stake_name: '   ',
      callings_sheet_id: 'abc',
      stake_seat_cap: 0,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a negative seat cap', () => {
    const r = step1Schema.safeParse({
      stake_name: 'X',
      callings_sheet_id: 'abc',
      stake_seat_cap: -1,
    });
    expect(r.success).toBe(false);
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
  it('accepts a valid ward', () => {
    const r = wardSchema.safeParse({
      ward_code: 'CO',
      ward_name: 'Cordera',
      building_name: 'Main',
      seat_cap: 20,
    });
    expect(r.success).toBe(true);
  });
  it('rejects ward code with non-alphanumeric chars', () => {
    const r = wardSchema.safeParse({
      ward_code: 'C-O',
      ward_name: 'X',
      building_name: 'Main',
      seat_cap: 1,
    });
    expect(r.success).toBe(false);
  });
  it('rejects an empty building reference', () => {
    const r = wardSchema.safeParse({
      ward_code: 'CO',
      ward_name: 'X',
      building_name: '',
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
