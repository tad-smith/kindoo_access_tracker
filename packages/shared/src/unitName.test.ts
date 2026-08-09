import { describe, expect, it } from 'vitest';
import {
  kindooScopeName,
  kindooScopeNameVariants,
  normaliseUnitName,
  unitType,
} from './unitName.js';

describe('normaliseUnitName', () => {
  it('trims and lowercases', () => {
    expect(normaliseUnitName('  Maple Ward  ')).toBe('maple ward');
  });
});

describe('unitType', () => {
  it('classifies a name ending in " Branch" as a branch, case-insensitively', () => {
    expect(unitType('Limon Branch')).toBe('branch');
    expect(unitType('limon branch')).toBe('branch');
    expect(unitType('LIMON BRANCH')).toBe('branch');
  });

  it('ignores surrounding whitespace', () => {
    expect(unitType('Limon Branch ')).toBe('branch');
    expect(unitType('  Limon Branch')).toBe('branch');
  });

  it('classifies everything else as a ward', () => {
    expect(unitType('Maple')).toBe('ward');
    expect(unitType('Maple Ward')).toBe('ward');
    expect(unitType('3rd Ward')).toBe('ward');
    expect(unitType('')).toBe('ward');
    expect(unitType('   ')).toBe('ward');
  });

  it('does not treat a bare suffix word as a suffix', () => {
    // The suffix tests require preceding whitespace, so the degenerate
    // single-word names are ordinary ward names. Pinned so the
    // behaviour is deliberate rather than incidental.
    expect(unitType('Branch')).toBe('ward');
    expect(unitType('Ward')).toBe('ward');
  });

  it('does not match a suffix mid-name', () => {
    expect(unitType('Branch Hollow')).toBe('ward');
    expect(unitType('Branchville')).toBe('ward');
  });
});

describe('kindooScopeName', () => {
  it('appends " Ward" to a bare ward name', () => {
    expect(kindooScopeName('Maple')).toBe('Maple Ward');
    expect(kindooScopeName('Jackson Creek')).toBe('Jackson Creek Ward');
  });

  it('leaves an already-suffixed ward name unchanged', () => {
    expect(kindooScopeName('Maple Ward')).toBe('Maple Ward');
    expect(kindooScopeName('3rd Ward')).toBe('3rd Ward');
  });

  it('preserves the caller casing rather than re-casing the suffix', () => {
    expect(kindooScopeName('maple ward')).toBe('maple ward');
  });

  it('returns a branch name verbatim', () => {
    expect(kindooScopeName('Limon Branch')).toBe('Limon Branch');
    expect(kindooScopeName('Limon Branch ')).toBe('Limon Branch');
  });

  it('trims', () => {
    expect(kindooScopeName('  Maple  ')).toBe('Maple Ward');
    expect(kindooScopeName('  Maple Ward  ')).toBe('Maple Ward');
  });

  it('is empty for an empty or whitespace-only name', () => {
    expect(kindooScopeName('')).toBe('');
    expect(kindooScopeName('   ')).toBe('');
  });

  it('is idempotent', () => {
    for (const name of ['Maple', 'Maple Ward', 'maple ward', 'Limon Branch', '3rd Ward']) {
      expect(kindooScopeName(kindooScopeName(name))).toBe(kindooScopeName(name));
    }
  });
});

describe('kindooScopeNameVariants', () => {
  it('yields both the bare and suffixed forms for a ward, whichever was stored', () => {
    expect(kindooScopeNameVariants('Maple')).toEqual(['maple', 'maple ward']);
    expect(kindooScopeNameVariants('Maple Ward')).toEqual(['maple', 'maple ward']);
    expect(kindooScopeNameVariants('maple ward')).toEqual(['maple', 'maple ward']);
    expect(kindooScopeNameVariants('3rd Ward')).toEqual(['3rd', '3rd ward']);
  });

  it('yields only the verbatim form for a branch', () => {
    // Kindoo never renders "Limon Branch Ward", so a key for it could
    // only ever mis-resolve.
    expect(kindooScopeNameVariants('Limon Branch')).toEqual(['limon branch']);
    expect(kindooScopeNameVariants('Limon Branch ')).toEqual(['limon branch']);
  });

  it('is empty for an empty or whitespace-only name', () => {
    expect(kindooScopeNameVariants('')).toEqual([]);
    expect(kindooScopeNameVariants('   ')).toEqual([]);
  });

  it('de-duplicates', () => {
    for (const name of ['Maple', 'Maple Ward', 'Limon Branch', 'Ward']) {
      const variants = kindooScopeNameVariants(name);
      expect(new Set(variants).size).toBe(variants.length);
    }
  });

  it('treats a bare suffix word as an ordinary ward name', () => {
    expect(kindooScopeNameVariants('Ward')).toEqual(['ward', 'ward ward']);
    expect(kindooScopeNameVariants('Branch')).toEqual(['branch', 'branch ward']);
  });

  it('always contains the normalised kindooScopeName', () => {
    for (const name of ['Maple', 'Maple Ward', 'maple ward', 'Limon Branch', '3rd Ward']) {
      expect(kindooScopeNameVariants(name)).toContain(normaliseUnitName(kindooScopeName(name)));
    }
  });
});
