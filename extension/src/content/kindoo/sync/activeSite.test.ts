// Tests for `identifyActiveSite`. Pure-function unit coverage: home,
// foreign, and unknown branches against sample SBA configuration.

import { describe, expect, it } from 'vitest';
import type { KindooSite, Stake } from '@kindoo/shared';
import { identifyActiveSite } from './activeSite';

function ts(): KindooSite['created_at'] {
  return {
    seconds: 0,
    nanoseconds: 0,
    toDate: () => new Date(0),
    toMillis: () => 0,
  };
}

function stake(homeEid: number | null): Stake {
  return {
    stake_id: 'csnorth',
    stake_name: 'Colorado Springs North Stake',
    created_at: ts(),
    created_by: 'admin@csnorth.org',
    callings_sheet_id: 'sheet-x',
    bootstrap_admin_email: 'admin@csnorth.org',
    setup_complete: true,
    stake_seat_cap: 250,
    expiry_hour: 3,
    import_day: 'SUNDAY',
    import_hour: 6,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    last_modified_at: ts(),
    last_modified_by: { email: 'sys@example.com', canonical: 'sys@example.com' },
    lastActor: { email: 'sys@example.com', canonical: 'sys@example.com' },
    ...(homeEid !== null
      ? {
          kindoo_config: {
            site_id: homeEid,
            site_name: 'Kindoo Home',
            configured_at: ts(),
            configured_by: { email: 'sys@example.com', canonical: 'sys@example.com' },
          },
        }
      : {}),
  };
}

function kindooSite(id: string, eid: number | null | undefined): KindooSite {
  return {
    id,
    display_name: `${id} display`,
    kindoo_expected_site_name: `${id} name`,
    ...(eid === undefined ? {} : { kindoo_eid: eid }),
    created_at: ts(),
    last_modified_at: ts(),
    lastActor: { email: 'sys@example.com', canonical: 'sys@example.com' },
  };
}

describe('identifyActiveSite', () => {
  it('returns home when active EID matches stake.kindoo_config.site_id', () => {
    const result = identifyActiveSite(27994, stake(27994), [kindooSite('east-stake', 30000)]);
    expect(result).toEqual({ kind: 'home' });
  });

  it('returns foreign(siteId) when active EID matches a KindooSite.kindoo_eid', () => {
    const result = identifyActiveSite(30000, stake(27994), [
      kindooSite('east-stake', 30000),
      kindooSite('west-stake', 40000),
    ]);
    expect(result).toEqual({ kind: 'foreign', siteId: 'east-stake' });
  });

  it('returns unknown when active EID matches neither home nor any KindooSite', () => {
    const result = identifyActiveSite(99999, stake(27994), [kindooSite('east-stake', 30000)]);
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('returns unknown when the stake has no kindoo_config and no KindooSite matches', () => {
    const result = identifyActiveSite(27994, stake(null), []);
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('skips KindooSite entries with no kindoo_eid populated', () => {
    // Foreign sites pre-Phase-3 have no kindoo_eid yet; should NOT match.
    const result = identifyActiveSite(30000, stake(27994), [
      kindooSite('east-stake', undefined),
      kindooSite('west-stake', null),
    ]);
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('prefers home when home EID happens to match a KindooSite EID (defensive)', () => {
    // Malformed SBA config: a foreign-site doc shares the home EID.
    // Home wins so the operator at least sees their primary site.
    const result = identifyActiveSite(27994, stake(27994), [kindooSite('east-stake', 27994)]);
    expect(result).toEqual({ kind: 'home' });
  });
});
