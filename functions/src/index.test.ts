// Trivial test: prove the type-check + module-import path works.
// Real callable-invocation tests against the Firebase emulators live
// in the sibling `tests/` directory.
import { describe, expect, it } from 'vitest';
import { KINDOO_FUNCTIONS_VERSION } from './version.js';

describe('KINDOO_FUNCTIONS_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof KINDOO_FUNCTIONS_VERSION).toBe('string');
    expect(KINDOO_FUNCTIONS_VERSION.length).toBeGreaterThan(0);
  });
});
