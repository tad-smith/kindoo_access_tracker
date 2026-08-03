import { describe, expect, it } from 'vitest';

import {
  REMOTE_APPLY_HEARTBEAT_MS,
  REMOTE_APPLY_STALE_MS,
  canClaimRemoteApplyJob,
  freshRemoteApplyDesktops,
  isRemoteApplyEnabled,
  isRemoteApplyTerminal,
  remoteApplyDesktopForRequest,
} from './remoteApply.js';
import type { RemoteApplyDesktopWithId, RemoteApplyPresence } from './types/remoteApply.js';

const NOW = 1_770_000_000_000;
const ACTOR = { email: 'Manager@example.org', canonical: 'manager@example.org' };

function ts(atMs: number) {
  return {
    seconds: Math.floor(atMs / 1000),
    nanoseconds: 0,
    toDate: () => new Date(atMs),
    toMillis: () => atMs,
  };
}

const enabled: RemoteApplyPresence = {
  remote_apply_enabled: true,
  ext_version: '1.0.54',
  lastActor: ACTOR,
};

function desktop(
  overrides: Partial<RemoteApplyDesktopWithId> & { site_id: string },
): RemoteApplyDesktopWithId {
  return {
    stake_id: 'stake-a',
    last_seen_at: ts(NOW - 5_000),
    kindoo_eid: 1001,
    kindoo_site_name: 'North Building',
    ext_version: '1.0.54',
    lastActor: ACTOR,
    ...overrides,
  };
}

const siteA = desktop({ site_id: 'site-a' });
const siteB = desktop({ site_id: 'site-b', kindoo_eid: 1002, kindoo_site_name: 'South Building' });

describe('isRemoteApplyEnabled', () => {
  it('treats an absent opt-in as off', () => {
    const { remote_apply_enabled: _absent, ...noOptIn } = enabled;
    expect(isRemoteApplyEnabled(noOptIn)).toBe(false);
  });

  it('rejects a missing doc and an explicit opt-out', () => {
    expect(isRemoteApplyEnabled(null)).toBe(false);
    expect(isRemoteApplyEnabled({ ...enabled, remote_apply_enabled: false })).toBe(false);
  });
});

describe('freshRemoteApplyDesktops', () => {
  it('returns every fresh tab in the active stake', () => {
    const fresh = freshRemoteApplyDesktops(enabled, [siteA, siteB], 'stake-a', NOW);
    expect(fresh.map((d) => d.site_id)).toEqual(['site-a', 'site-b']);
  });

  it('returns nothing while the profile is opted out, however fresh the tabs', () => {
    expect(freshRemoteApplyDesktops(null, [siteA, siteB], 'stake-a', NOW)).toEqual([]);
  });

  it('drops tabs sitting in another stake', () => {
    const other = desktop({ site_id: 'site-c', stake_id: 'stake-b' });
    const fresh = freshRemoteApplyDesktops(enabled, [siteA, other], 'stake-a', NOW);
    expect(fresh.map((d) => d.site_id)).toEqual(['site-a']);
  });

  it('survives one missed heartbeat but drops a tab past the window', () => {
    const blinked = desktop({
      site_id: 'site-a',
      last_seen_at: ts(NOW - REMOTE_APPLY_HEARTBEAT_MS * 2),
    });
    const gone = desktop({
      site_id: 'site-b',
      last_seen_at: ts(NOW - REMOTE_APPLY_STALE_MS - 1),
    });
    const fresh = freshRemoteApplyDesktops(enabled, [blinked, gone], 'stake-a', NOW);
    expect(fresh.map((d) => d.site_id)).toEqual(['site-a']);
  });
});

describe('remoteApplyDesktopForRequest', () => {
  it('picks the tab sitting in the request’s own site', () => {
    const picked = remoteApplyDesktopForRequest(enabled, [siteA, siteB], 'stake-a', 'site-b', NOW);
    expect(picked?.site_id).toBe('site-b');
    expect(picked?.kindoo_site_name).toBe('South Building');
  });

  it('refuses when no tab is on the site the request needs', () => {
    // The whole point of the per-site model: a fresh tab on the WRONG
    // site must not look like an answer, or the manager is told to open
    // a site they already have open.
    expect(remoteApplyDesktopForRequest(enabled, [siteA], 'stake-a', 'site-b', NOW)).toBeNull();
  });

  it('lets any fresh tab serve a request that names no site', () => {
    expect(remoteApplyDesktopForRequest(enabled, [siteB], 'stake-a', null, NOW)?.site_id).toBe(
      'site-b',
    );
    expect(
      remoteApplyDesktopForRequest(enabled, [siteB], 'stake-a', undefined, NOW),
    ).not.toBeNull();
  });

  it('refuses when nothing is online at all', () => {
    expect(remoteApplyDesktopForRequest(enabled, [], 'stake-a', 'site-a', NOW)).toBeNull();
  });
});

describe('canClaimRemoteApplyJob', () => {
  const job = { stake_id: 'stake-a', kindoo_site_id: 'site-b' };

  it('lets the tab on the matching site claim', () => {
    expect(canClaimRemoteApplyJob(job, 'stake-a', 'site-b')).toBe(true);
  });

  it('leaves a job for another site to the sibling tab', () => {
    expect(canClaimRemoteApplyJob(job, 'stake-a', 'site-a')).toBe(false);
  });

  it('refuses a job from another stake', () => {
    expect(canClaimRemoteApplyJob(job, 'stake-b', 'site-b')).toBe(false);
  });

  it('lets any tab in the stake claim a job that names no site', () => {
    expect(canClaimRemoteApplyJob({ stake_id: 'stake-a' }, 'stake-a', 'site-a')).toBe(true);
    expect(
      canClaimRemoteApplyJob({ stake_id: 'stake-a', kindoo_site_id: null }, 'stake-a', null),
    ).toBe(true);
  });

  it('refuses a site-specific job when the tab has no site resolved', () => {
    expect(canClaimRemoteApplyJob(job, 'stake-a', null)).toBe(false);
  });
});

describe('isRemoteApplyTerminal', () => {
  it('holds queued and running open', () => {
    expect(isRemoteApplyTerminal('queued')).toBe(false);
    expect(isRemoteApplyTerminal('running')).toBe(false);
  });

  it('closes every finished status', () => {
    expect(isRemoteApplyTerminal('applied')).toBe(true);
    expect(isRemoteApplyTerminal('partial')).toBe(true);
    expect(isRemoteApplyTerminal('failed')).toBe(true);
    expect(isRemoteApplyTerminal('cancelled')).toBe(true);
  });
});
