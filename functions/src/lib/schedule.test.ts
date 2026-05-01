import { describe, expect, it } from 'vitest';
import { localTimeFor, shouldRunExpiry, shouldRunImporter } from './schedule.js';
import type { Stake } from '@kindoo/shared';

const STAKE: Stake = {
  stake_id: 'csnorth',
  stake_name: 'CS North',
  created_at: null as unknown as Stake['created_at'],
  created_by: 'admin',
  callings_sheet_id: 'sid',
  bootstrap_admin_email: 'admin@gmail.com',
  setup_complete: true,
  stake_seat_cap: 200,
  expiry_hour: 3,
  import_day: 'MONDAY',
  import_hour: 4,
  timezone: 'America/Denver',
  notifications_enabled: true,
  last_over_caps_json: [],
  last_modified_at: null as unknown as Stake['last_modified_at'],
  last_modified_by: { email: 'admin', canonical: 'admin' },
  lastActor: { email: 'admin', canonical: 'admin' },
};

describe('localTimeFor', () => {
  it('returns the local hour + weekday for a given Date in America/Denver', () => {
    // 2026-04-27 10:00 UTC = 04:00 MDT (UTC-6 during DST). Monday.
    const date = new Date('2026-04-27T10:00:00Z');
    expect(localTimeFor(date, 'America/Denver')).toEqual({ day: 'MONDAY', hour: 4 });
  });

  it('respects DST boundaries', () => {
    // 2026-04-27 09:00 UTC = 03:00 MDT.
    const date = new Date('2026-04-27T09:00:00Z');
    expect(localTimeFor(date, 'America/Denver').hour).toBe(3);
  });
});

describe('shouldRunImporter', () => {
  it('matches on (day, hour)', () => {
    // Monday 04:00 Denver → matches
    expect(shouldRunImporter(STAKE, new Date('2026-04-27T10:00:00Z'))).toBe(true);
  });

  it('mismatches on hour', () => {
    // Monday 03:00 Denver, but stake expects hour=4
    expect(shouldRunImporter(STAKE, new Date('2026-04-27T09:00:00Z'))).toBe(false);
  });

  it('mismatches on day', () => {
    // Tuesday 04:00 Denver
    expect(shouldRunImporter(STAKE, new Date('2026-04-28T10:00:00Z'))).toBe(false);
  });

  it('skips stakes with setup_complete=false', () => {
    expect(
      shouldRunImporter({ ...STAKE, setup_complete: false }, new Date('2026-04-27T10:00:00Z')),
    ).toBe(false);
  });
});

describe('shouldRunExpiry', () => {
  it('matches on hour, any day', () => {
    // Monday 03:00 Denver
    expect(shouldRunExpiry(STAKE, new Date('2026-04-27T09:00:00Z'))).toBe(true);
    // Wednesday 03:00 Denver
    expect(shouldRunExpiry(STAKE, new Date('2026-04-29T09:00:00Z'))).toBe(true);
  });

  it('mismatches on hour', () => {
    expect(shouldRunExpiry(STAKE, new Date('2026-04-27T10:00:00Z'))).toBe(false);
  });

  it('skips stakes with setup_complete=false', () => {
    expect(
      shouldRunExpiry({ ...STAKE, setup_complete: false }, new Date('2026-04-27T09:00:00Z')),
    ).toBe(false);
  });
});
