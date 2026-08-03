// Unit tests for the EID → SBA site mapping the per-site heartbeat and
// the site-aware claim filter both depend on.
//
// The `null` return is the one to get right: it is the difference
// between a tab that stays silent and a tab that advertises a site it
// cannot provision for. Everything downstream — no desktop doc, no
// claims — hangs off it.

import { describe, expect, it } from 'vitest';
import { REMOTE_APPLY_HOME_SITE_KEY } from '@kindoo/shared';
import type { KindooSite, Stake } from '@kindoo/shared';
import type { StakeConfigBundle } from '../../lib/extensionApi';
import type { KindooSession } from '../kindoo/auth';
import type { KindooEnvironment } from '../kindoo/endpoints';
import { activeKindooSiteName, resolveTabSite } from './site';

const HOME_EID = 27994;
const EAST_EID = 31001;

const ENVS: KindooEnvironment[] = [
  { EID: HOME_EID, Name: 'CS North', TimeZone: 'Mountain Standard Time' },
  { EID: EAST_EID, Name: 'East Stake', TimeZone: 'Mountain Standard Time' },
];

function session(eid: number): KindooSession {
  return { token: 'tok', eid };
}

function bundle(kindooSites: KindooSite[] = []): StakeConfigBundle {
  return {
    stake: {
      stake_id: 'csnorth',
      stake_name: 'CS North',
      kindoo_config: { site_id: HOME_EID, site_name: 'CS North' },
    } as unknown as Stake,
    buildings: [],
    wards: [],
    kindooSites,
  };
}

const EAST: KindooSite = {
  id: 'east-stake',
  display_name: 'East Stake (Pine)',
  kindoo_expected_site_name: 'East Stake',
  kindoo_eid: EAST_EID,
} as unknown as KindooSite;

describe('resolveTabSite', () => {
  it('maps the home EID to the reserved home key with a null site id', () => {
    // Two encodings of the same site: the key names the doc (which
    // cannot be null), the id matches how wards and buildings spell it.
    expect(resolveTabSite({ session: session(HOME_EID), envs: ENVS, bundle: bundle() })).toEqual({
      siteKey: REMOTE_APPLY_HOME_SITE_KEY,
      kindooSiteId: null,
      kindooEid: HOME_EID,
    });
  });

  it('maps a foreign EID to that site’s slug for both', () => {
    expect(
      resolveTabSite({ session: session(EAST_EID), envs: ENVS, bundle: bundle([EAST]) }),
    ).toEqual({ siteKey: 'east-stake', kindooSiteId: 'east-stake', kindooEid: EAST_EID });
  });

  it('returns null for an EID the stake has not configured', () => {
    // The manager is inside some other organisation's Kindoo site.
    // Legitimate, and not this stake's business — publish nothing.
    const envs = [...ENVS, { EID: 55555, Name: 'Somewhere Else', TimeZone: 'UTC' }];
    expect(resolveTabSite({ session: session(55555), envs, bundle: bundle([EAST]) })).toBeNull();
  });

  it('returns null when the foreign site is configured but this EID is not it', () => {
    const unpopulated = { ...EAST, kindoo_eid: null } as unknown as KindooSite;
    const envs = [...ENVS, { EID: 55555, Name: 'Somewhere Else', TimeZone: 'UTC' }];
    expect(
      resolveTabSite({ session: session(55555), envs, bundle: bundle([unpopulated]) }),
    ).toBeNull();
  });

  it('resolves a foreign site by name before its EID has been backfilled', () => {
    // First use of a newly configured foreign site: the doc carries the
    // expected name but no EID yet. The tab can still serve it — the
    // provision flow backfills the EID on the first apply.
    const unpopulated = { ...EAST, kindoo_eid: null } as unknown as KindooSite;
    expect(
      resolveTabSite({ session: session(EAST_EID), envs: ENVS, bundle: bundle([unpopulated]) }),
    ).toEqual({ siteKey: 'east-stake', kindooSiteId: 'east-stake', kindooEid: EAST_EID });
  });
});

describe('activeKindooSiteName', () => {
  it('reads the Kindoo-side name so the phone names what the desktop shows', () => {
    expect(activeKindooSiteName(ENVS, session(EAST_EID))).toBe('East Stake');
  });

  it('is null when the envs list does not carry the active EID', () => {
    expect(activeKindooSiteName(ENVS, session(55555))).toBeNull();
  });
});
