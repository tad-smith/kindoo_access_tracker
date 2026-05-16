// Schema tests for the Configuration sub-forms.

import { describe, expect, it } from 'vitest';
import {
  buildingSchema,
  callingTemplateSchema,
  configSchema,
  kindooSiteFormSchema,
  managerSchema,
  wardSchema,
} from './schemas';

describe('configuration wardSchema', () => {
  it('accepts a valid ward', () => {
    const r = wardSchema.safeParse({
      ward_code: 'CO',
      ward_name: 'Cordera',
      building_name: 'Main',
      seat_cap: 20,
    });
    expect(r.success).toBe(true);
  });
  it('rejects ward code with hyphens', () => {
    const r = wardSchema.safeParse({
      ward_code: 'C-O',
      ward_name: 'X',
      building_name: 'Main',
      seat_cap: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe('configuration buildingSchema', () => {
  it('rejects empty name', () => {
    const r = buildingSchema.safeParse({ building_name: '', address: '' });
    expect(r.success).toBe(false);
  });
});

describe('configuration managerSchema', () => {
  it('rejects malformed email', () => {
    const r = managerSchema.safeParse({ member_email: 'no', name: 'X', active: true });
    expect(r.success).toBe(false);
  });
});

describe('configuration callingTemplateSchema', () => {
  it('accepts a wildcard calling name', () => {
    const r = callingTemplateSchema.safeParse({
      calling_name: 'Counselor *',
      give_app_access: true,
      auto_kindoo_access: true,
      sheet_order: 5,
    });
    expect(r.success).toBe(true);
  });

  it('accepts independent give_app_access and auto_kindoo_access flags', () => {
    const r = callingTemplateSchema.safeParse({
      calling_name: 'Stake Clerk',
      give_app_access: true,
      auto_kindoo_access: false,
      sheet_order: 3,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a missing auto_kindoo_access', () => {
    const r = callingTemplateSchema.safeParse({
      calling_name: 'Bishop',
      give_app_access: true,
      sheet_order: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe('configuration kindooSiteFormSchema', () => {
  it('accepts a fully populated kindoo site', () => {
    const r = kindooSiteFormSchema.safeParse({
      display_name: 'East Stake',
      kindoo_expected_site_name: 'East Stake CS',
      kindoo_eid: 42,
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty display_name', () => {
    const r = kindooSiteFormSchema.safeParse({
      display_name: '   ',
      kindoo_expected_site_name: 'X',
      kindoo_eid: 1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty kindoo_expected_site_name', () => {
    const r = kindooSiteFormSchema.safeParse({
      display_name: 'X',
      kindoo_expected_site_name: '',
      kindoo_eid: 1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects zero EID', () => {
    const r = kindooSiteFormSchema.safeParse({
      display_name: 'X',
      kindoo_expected_site_name: 'X',
      kindoo_eid: 0,
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-integer EID', () => {
    const r = kindooSiteFormSchema.safeParse({
      display_name: 'X',
      kindoo_expected_site_name: 'X',
      kindoo_eid: 1.5,
    });
    expect(r.success).toBe(false);
  });
});

describe('configuration configSchema', () => {
  it('accepts a fully populated config', () => {
    const r = configSchema.safeParse({
      stake_name: 'My Stake',
      callings_sheet_id: 'sheet1',
      stake_seat_cap: 200,
      expiry_hour: 4,
      import_day: 'MONDAY',
      import_hour: 6,
      timezone: 'America/Denver',
      notifications_enabled: true,
    });
    expect(r.success).toBe(true);
  });
  it('rejects out-of-range hours', () => {
    const r = configSchema.safeParse({
      stake_name: 'X',
      callings_sheet_id: 'X',
      stake_seat_cap: 0,
      expiry_hour: 25,
      import_day: 'MONDAY',
      import_hour: 0,
      timezone: 'X',
      notifications_enabled: false,
    });
    expect(r.success).toBe(false);
  });
});
