import { describe, expect, it } from 'vitest';
import {
  AUTOMATED_ACTOR_NAMES,
  HISTORICAL_SYNC_DISCREPANCY_CODES,
  LEGACY_IMPORTER_ACTOR_NAME,
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

  it('matches the post-T-45 synthetic actors (regression guard for B-5)', () => {
    expect(isAutomatedActor('ExpiryTrigger')).toBe(true);
    expect(isAutomatedActor('RemoveTrigger')).toBe(true);
    expect(isAutomatedActor('OutOfBand')).toBe(true);
    expect(isAutomatedActor('Migration')).toBe(true);
  });

  it('matches the legacy Importer actor so pre-T-45 audit rows keep their chip', () => {
    expect(isAutomatedActor(LEGACY_IMPORTER_ACTOR_NAME)).toBe(true);
  });

  it('does NOT include the legacy Importer name in the canonical enum', () => {
    expect((AUTOMATED_ACTOR_NAMES as readonly string[]).includes(LEGACY_IMPORTER_ACTOR_NAME)).toBe(
      false,
    );
  });

  it('matches every SyncActor:<code> stamp', () => {
    for (const code of SYNC_DISCREPANCY_CODES) {
      expect(isAutomatedActor(`${SYNC_ACTOR_PREFIX}${code}`)).toBe(true);
    }
  });

  it('matches the renamed callings-mismatch code', () => {
    expect(isAutomatedActor('SyncActor:callings-mismatch')).toBe(true);
  });

  it('still matches deprecated/historical SyncActor codes on existing audit rows', () => {
    // `extra-kindoo-calling` was renamed to `callings-mismatch`. Rows
    // stamped before the rename must keep classifying as automated, not
    // demote to a human actor.
    expect(isAutomatedActor('SyncActor:extra-kindoo-calling')).toBe(true);
    for (const code of HISTORICAL_SYNC_DISCREPANCY_CODES) {
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
    expect(parseSyncActorCode(LEGACY_IMPORTER_ACTOR_NAME)).toBeNull();
    expect(parseSyncActorCode('alice@gmail.com')).toBeNull();
    expect(parseSyncActorCode('')).toBeNull();
  });

  it('returns null for SyncActor prefix with an unknown code', () => {
    expect(parseSyncActorCode('SyncActor:invented-code')).toBeNull();
    expect(parseSyncActorCode('SyncActor:')).toBeNull();
  });

  it('returns null for deprecated/historical codes (recognised for audit, not a current input)', () => {
    // Historical codes classify as automated via `isAutomatedActor` but
    // are not current `SyncDiscrepancyCode` inputs, so `parseSyncActorCode`
    // (which narrows to the current union) does not surface them.
    expect(parseSyncActorCode('SyncActor:extra-kindoo-calling')).toBeNull();
    expect((SYNC_DISCREPANCY_CODES as readonly string[]).includes('extra-kindoo-calling')).toBe(
      false,
    );
  });
});
