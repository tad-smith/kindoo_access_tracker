import { describe, expect, it } from 'vitest';
import { AUTOMATED_ACTOR_NAMES, isAutomatedActor } from './systemActors.js';

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

  it('rejects real-user email addresses', () => {
    expect(isAutomatedActor('alice@example.com')).toBe(false);
    expect(isAutomatedActor('alice@gmail.com')).toBe(false);
  });

  it('rejects empty and unknown strings', () => {
    expect(isAutomatedActor('')).toBe(false);
    expect(isAutomatedActor('unknown')).toBe(false);
    expect(isAutomatedActor('importer')).toBe(false); // case-sensitive
  });
});
