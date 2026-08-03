import { describe, expect, it } from 'vitest';

import {
  REMOTE_APPLY_HEARTBEAT_MS,
  REMOTE_APPLY_STALE_MS,
  isRemoteApplyOnline,
  isRemoteApplyTerminal,
} from './remoteApply.js';
import type { RemoteApplyPresence } from './types/remoteApply.js';

const NOW = 1_770_000_000_000;

function presence(overrides: Partial<RemoteApplyPresence> = {}): RemoteApplyPresence {
  const lastSeenMs = NOW - 5_000;
  return {
    remote_apply_enabled: true,
    last_seen_at: {
      seconds: Math.floor(lastSeenMs / 1000),
      nanoseconds: 0,
      toDate: () => new Date(lastSeenMs),
      toMillis: () => lastSeenMs,
    },
    stake_id: 'csnorth',
    kindoo_eid: 4211,
    kindoo_site_name: 'Cedar Springs North',
    ext_version: '1.0.53',
    lastActor: { email: 'Manager@example.org', canonical: 'manager@example.org' },
    ...overrides,
  };
}

function presenceSeenMsAgo(ageMs: number): RemoteApplyPresence {
  const lastSeenMs = NOW - ageMs;
  return presence({
    last_seen_at: {
      seconds: Math.floor(lastSeenMs / 1000),
      nanoseconds: 0,
      toDate: () => new Date(lastSeenMs),
      toMillis: () => lastSeenMs,
    },
  });
}

describe('isRemoteApplyOnline', () => {
  it('accepts a fresh, opted-in desktop on the active stake', () => {
    expect(isRemoteApplyOnline(presence(), 'csnorth', NOW)).toBe(true);
  });

  it('rejects a missing presence doc', () => {
    expect(isRemoteApplyOnline(null, 'csnorth', NOW)).toBe(false);
    expect(isRemoteApplyOnline(undefined, 'csnorth', NOW)).toBe(false);
  });

  it('treats an absent opt-in as off', () => {
    const { remote_apply_enabled: _absent, ...noOptIn } = presence();
    expect(isRemoteApplyOnline(noOptIn, 'csnorth', NOW)).toBe(false);
  });

  it('rejects an explicit opt-out even while the heartbeat is fresh', () => {
    expect(isRemoteApplyOnline(presence({ remote_apply_enabled: false }), 'csnorth', NOW)).toBe(
      false,
    );
  });

  it('rejects a desktop parked in a different stake', () => {
    expect(isRemoteApplyOnline(presence(), 'csouth', NOW)).toBe(false);
  });

  it('survives one missed heartbeat', () => {
    expect(
      isRemoteApplyOnline(presenceSeenMsAgo(REMOTE_APPLY_HEARTBEAT_MS * 2), 'csnorth', NOW),
    ).toBe(true);
  });

  it('goes stale past the window', () => {
    expect(isRemoteApplyOnline(presenceSeenMsAgo(REMOTE_APPLY_STALE_MS + 1), 'csnorth', NOW)).toBe(
      false,
    );
  });

  it('tolerates a heartbeat written slightly ahead of the reading clock', () => {
    expect(isRemoteApplyOnline(presenceSeenMsAgo(-2_000), 'csnorth', NOW)).toBe(true);
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
