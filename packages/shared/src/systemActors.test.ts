import { describe, expect, it } from 'vitest';
import {
  AUTOMATED_ACTOR_NAMES,
  SYNC_ACTOR_PREFIX,
  SYNC_DISCREPANCY_CODES,
  isAutomatedActor,
  parseSyncActorCode,
  syncActorName,
} from './systemActors.js';

describe('isAutomatedActor', () => {
  it('matches every literal in AUTOMATED_ACTOR_NAMES', () => {
    for (const name of AUTOMATED_ACTOR_NAMES) {
      expect(isAutomatedActor(name)).toBe(true);
    }
  });

  it('matches the four known synthetic actors (regression guard for B-5)', () => {
    expect(isAutomatedActor('Importer')).toBe(true);
    expect(isAutomatedActor('ExpiryTrigger')).toBe(true);
    expect(isAutomatedActor('RemoveTrigger')).toBe(true);
    expect(isAutomatedActor('OutOfBand')).toBe(true);
  });

  it('matches every SyncActor:<code> stamp', () => {
    for (const code of SYNC_DISCREPANCY_CODES) {
      expect(isAutomatedActor(`${SYNC_ACTOR_PREFIX}${code}`)).toBe(true);
    }
  });

  it('rejects real-user email addresses', () => {
    expect(isAutomatedActor('alice@example.com')).toBe(false);
    expect(isAutomatedActor('alice@gmail.com')).toBe(false);
  });

  it('rejects empty and unknown strings', () => {
    expect(isAutomatedActor('')).toBe(false);
    expect(isAutomatedActor('unknown')).toBe(false);
    expect(isAutomatedActor('importer')).toBe(false); // case-sensitive
  });

  it('rejects SyncActor stamps with an unknown code', () => {
    expect(isAutomatedActor('SyncActor:unknown')).toBe(false);
    expect(isAutomatedActor('SyncActor:')).toBe(false);
  });
});

describe('syncActorName + parseSyncActorCode', () => {
  it('round-trips every discrepancy code', () => {
    for (const code of SYNC_DISCREPANCY_CODES) {
      const stamped = syncActorName(code);
      expect(stamped).toBe(`SyncActor:${code}`);
      expect(parseSyncActorCode(stamped)).toBe(code);
    }
  });

  it('returns null for strings without the SyncActor prefix', () => {
    expect(parseSyncActorCode('Importer')).toBeNull();
    expect(parseSyncActorCode('alice@gmail.com')).toBeNull();
    expect(parseSyncActorCode('')).toBeNull();
  });

  it('returns null for SyncActor prefix with an unknown code', () => {
    expect(parseSyncActorCode('SyncActor:invented-code')).toBeNull();
    expect(parseSyncActorCode('SyncActor:')).toBeNull();
  });
});
