// Smoke test for the build-version stamp. Verifies the export survives
// the pre-build stamper round-trip (`infra/scripts/stamp-version.js`
// rewrites this file at deploy time; if the export name or shape drifts
// we want CI to catch it before deploy).

import { describe, expect, it } from 'vitest';
import { KINDOO_WEB_VERSION } from './version';

describe('KINDOO_WEB_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof KINDOO_WEB_VERSION).toBe('string');
    expect(KINDOO_WEB_VERSION.length).toBeGreaterThan(0);
  });
});
