// Schema tests for the Configuration sub-forms.

import { describe, expect, it } from 'vitest';
import {
  buildingSchema,
  configSchema,
  kindooSiteFormSchema,
  managerSchema,
  organizationFormSchema,
  wardSchema,
} from './schemas';

describe('configuration wardSchema', () => {
  it('accepts a valid ward (no ward_code input — it is derived from the name)', () => {
    const r = wardSchema.safeParse({
      ward_name: 'Maple',
      // The form value is the immutable building_id slug.
      building_id: 'main',
      seat_cap: 20,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a ward with no building selected', () => {
    const r = wardSchema.safeParse({
      ward_name: 'Maple',
      building_id: '',
      seat_cap: 20,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a ward with an empty name', () => {
    const r = wardSchema.safeParse({
      ward_name: '   ',
      building_id: 'main',
      seat_cap: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe('configuration buildingSchema', () => {
  it('accepts a valid building (Home site)', () => {
    const r = buildingSchema.safeParse({
      building_name: 'Maple Building',
      address: '',
      kindoo_site_id: null,
    });
    expect(r.success).toBe(true);
  });

  it('accepts a valid building (foreign site)', () => {
    const r = buildingSchema.safeParse({
      building_name: 'Pine Building',
      address: '',
      kindoo_site_id: 'east-stake',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty name', () => {
    const r = buildingSchema.safeParse({
      building_name: '',
      address: '',
      kindoo_site_id: null,
    });
    expect(r.success).toBe(false);
  });
});

describe('configuration managerSchema', () => {
  it('rejects malformed email', () => {
    const r = managerSchema.safeParse({ member_email: 'no', name: 'X', active: true });
    expect(r.success).toBe(false);
  });
});

describe('configuration kindooSiteFormSchema', () => {
  it('accepts a fully populated kindoo site (no EID — extension-populated)', () => {
    const r = kindooSiteFormSchema.safeParse({
      display_name: 'East Stake',
      kindoo_expected_site_name: 'East Stake CS',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty display_name', () => {
    const r = kindooSiteFormSchema.safeParse({
      display_name: '   ',
      kindoo_expected_site_name: 'X',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty kindoo_expected_site_name', () => {
    const r = kindooSiteFormSchema.safeParse({
      display_name: 'X',
      kindoo_expected_site_name: '',
    });
    expect(r.success).toBe(false);
  });
});

describe('configuration organizationFormSchema', () => {
  it('accepts a valid organization', () => {
    const r = organizationFormSchema.safeParse({ name: 'Primary Children', seat_cap: 25 });
    expect(r.success).toBe(true);
  });

  it('accepts a zero seat cap', () => {
    const r = organizationFormSchema.safeParse({ name: 'Scouts', seat_cap: 0 });
    expect(r.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const r = organizationFormSchema.safeParse({ name: '   ', seat_cap: 5 });
    expect(r.success).toBe(false);
  });

  it('rejects a negative seat cap', () => {
    const r = organizationFormSchema.safeParse({ name: 'Scouts', seat_cap: -1 });
    expect(r.success).toBe(false);
  });

  it('rejects a non-integer seat cap', () => {
    const r = organizationFormSchema.safeParse({ name: 'Scouts', seat_cap: 2.5 });
    expect(r.success).toBe(false);
  });
});

describe('configuration configSchema', () => {
  it('accepts a fully populated config', () => {
    const r = configSchema.safeParse({
      stake_name: 'My Stake',
      stake_seat_cap: 200,
      timezone: 'America/Denver',
      notifications_enabled: true,
    });
    expect(r.success).toBe(true);
  });
  it('rejects a negative seat cap', () => {
    const r = configSchema.safeParse({
      stake_name: 'X',
      stake_seat_cap: -1,
      timezone: 'X',
      notifications_enabled: false,
    });
    expect(r.success).toBe(false);
  });
});
