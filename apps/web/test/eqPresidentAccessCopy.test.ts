// Pins the Elders Quorum President app-access copy to one module.
//
// The two surfaces that carry this setting — the bootstrap wizard's
// Step 1 and Configuration → Config — have no structural reason to
// agree, and the last rename had to be applied to both by hand. Render
// tests in each feature prove each surface shows the right words; they
// cannot prove the words came from the same place, because two identical
// literals pass both.
//
// So this reads the sources. It fails the moment either file inlines a
// string that belongs to `src/lib/eqPresidentAccessCopy.ts`, which is
// what makes that module the only copy rather than merely the first.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EQ_PRESIDENT_ACCESS_LABEL,
  EQ_PRESIDENT_ACCESS_TIP,
} from '../src/lib/eqPresidentAccessCopy';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every surface that renders the setting. Add one here when one is added. */
const SURFACES = [
  'src/features/bootstrap/BootstrapWizardPage.tsx',
  'src/features/manager/configuration/ConfigurationPage.tsx',
] as const;

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('Elders Quorum President app-access copy', () => {
  it.each(SURFACES)('%s imports the shared copy rather than declaring its own', (rel) => {
    const src = source(rel);
    expect(src).toContain('EQ_PRESIDENT_ACCESS_LABEL');
    expect(src).toContain('EQ_PRESIDENT_ACCESS_TIP');
    expect(src).toMatch(/from '(\.\.\/)+lib\/eqPresidentAccessCopy'/);
  });

  it.each(SURFACES)('%s does not inline the label', (rel) => {
    // A re-inlined literal is exactly the drift this module exists to
    // stop: it renders identically today and silently diverges at the
    // next rename.
    expect(source(rel)).not.toContain(EQ_PRESIDENT_ACCESS_LABEL);
  });

  it.each(SURFACES)('%s does not inline the tooltip copy', (rel) => {
    // Compared on a distinctive fragment, not the whole string: the
    // constant is assembled from two concatenated lines, so an inlined
    // copy would likely be wrapped differently and slip an exact match.
    expect(source(rel)).not.toContain('When on, Sync grants app access');
    expect(source(rel)).not.toContain('drops it again when the calling moves on');
  });

  it('keeps the label short enough to stay on one line at 375px', () => {
    // 29 characters fits; the 39-character predecessor wrapped the row
    // to two lines and broke the Config tab's sub-option alignment.
    expect(EQ_PRESIDENT_ACCESS_LABEL.length).toBeLessThanOrEqual(32);
  });

  it('leaves the backfill dialog free to spell the calling out in prose', () => {
    // Deliberately NOT read from this module: the dialog's title and
    // description are sentences, not a control label, and they say
    // "Elders Quorum Presidents" in full.
    const config = source('src/features/manager/configuration/ConfigurationPage.tsx');
    expect(config).toContain('Revoke access from Elders Quorum Presidents?');
    expect(config).toContain('Grant access to current Elders Quorum Presidents?');
  });

  it('says nothing about how to change the setting, since the two surfaces differ', () => {
    // The wizard has no backfill offer; the Config tab raises one on
    // flip. Any sentence about the reconcile pass would be wrong on one.
    expect(EQ_PRESIDENT_ACCESS_TIP).not.toMatch(/backfill|one-time pass|flip/i);
  });
});
