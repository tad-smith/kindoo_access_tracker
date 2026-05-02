// Unit tests for the LCR-sheet parser. Pure-function coverage —
// header location, prefix stripping, calling-template matching,
// multi-name cell splits, GoogleAccount override extraction.

import { describe, expect, it } from 'vitest';
import {
  buildTemplateIndex,
  extractEmailFromCell,
  findHeaderRow,
  matchTemplate,
  parseTab,
  resolveTabScope,
  splitNames,
  wildcardToRegex,
} from './parser.js';

describe('wildcardToRegex', () => {
  it('treats * as .* and anchors both ends', () => {
    expect(wildcardToRegex('Bishop').test('Bishop')).toBe(true);
    expect(wildcardToRegex('Bishop').test('Bishop ')).toBe(false);
    expect(wildcardToRegex('Stake High Councilor*').test('Stake High Councilor')).toBe(true);
    expect(
      wildcardToRegex('Stake High Councilor*').test('Stake High Councilor - Cordera Ward'),
    ).toBe(true);
    expect(wildcardToRegex('*').test('anything')).toBe(true);
    expect(wildcardToRegex('*').test('')).toBe(true);
    expect(wildcardToRegex('Second*Counselor').test('Second Counselor')).toBe(true);
    expect(wildcardToRegex('Second*Counselor').test('Second Ward Counselor')).toBe(true);
    expect(wildcardToRegex('Second*Counselor').test('First Counselor')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    expect(wildcardToRegex('Clerk (Assistant)').test('Clerk (Assistant)')).toBe(true);
    expect(wildcardToRegex('Clerk (Assistant)').test('Clerk Assistant')).toBe(false);
    expect(wildcardToRegex('A.B').test('AxB')).toBe(false);
    expect(wildcardToRegex('A.B').test('A.B')).toBe(true);
  });
});

describe('matchTemplate', () => {
  const idx = buildTemplateIndex([
    { calling_name: 'Bishop', give_app_access: true, auto_kindoo_access: true, sheet_order: 1 },
    {
      calling_name: 'Counselor *',
      give_app_access: false,
      auto_kindoo_access: false,
      sheet_order: 2,
    },
    {
      calling_name: '*Clerk*',
      give_app_access: false,
      auto_kindoo_access: false,
      sheet_order: 3,
    },
  ]);

  it('returns null for a non-matching calling', () => {
    expect(matchTemplate(idx, 'High Priest')).toBeNull();
  });

  it('exact match wins over wildcards', () => {
    const got = matchTemplate(idx, 'Bishop');
    expect(got?.calling_name).toBe('Bishop');
  });

  it('wildcard matches when no exact', () => {
    const got = matchTemplate(idx, 'Counselor One');
    expect(got?.calling_name).toBe('Counselor *');
  });

  it('among wildcards, sheet_order ascending wins', () => {
    const idx2 = buildTemplateIndex([
      {
        calling_name: 'Foo*',
        give_app_access: false,
        auto_kindoo_access: false,
        sheet_order: 5,
      },
      { calling_name: '*', give_app_access: true, auto_kindoo_access: true, sheet_order: 1 },
    ]);
    const got = matchTemplate(idx2, 'Foo Bar');
    // sheet_order=1 (`*`) lands first, so it wins even though `Foo*` is more specific.
    expect(got?.calling_name).toBe('*');
  });
});

describe('splitNames', () => {
  it('handles single, multi, and empty cells', () => {
    expect(splitNames('Alice Smith')).toEqual(['Alice Smith']);
    expect(splitNames('  Alice Smith  ')).toEqual(['Alice Smith']);
    expect(splitNames('Alice, Bob')).toEqual(['Alice', 'Bob']);
    expect(splitNames('A, B, C')).toEqual(['A', 'B', 'C']);
    expect(splitNames('Alice,,Bob')).toEqual(['Alice', 'Bob']);
    expect(splitNames('')).toEqual([]);
    expect(splitNames(undefined)).toEqual([]);
  });
});

describe('extractEmailFromCell', () => {
  it('returns plain emails verbatim', () => {
    expect(extractEmailFromCell('alice@gmail.com')).toBe('alice@gmail.com');
  });
  it('extracts the GoogleAccount override', () => {
    expect(extractEmailFromCell('alice@example.org [GoogleAccount: alice@gmail.com]')).toBe(
      'alice@gmail.com',
    );
    expect(extractEmailFromCell('[GoogleAccount: solo@gmail.com]')).toBe('solo@gmail.com');
  });
  it('falls back to plain text when capture is empty', () => {
    expect(extractEmailFromCell('alice@example.org [GoogleAccount: ] stray note')).toBe(
      'alice@example.org stray note',
    );
  });
  it('returns empty for blank input', () => {
    expect(extractEmailFromCell('')).toBe('');
    expect(extractEmailFromCell(undefined)).toBe('');
  });
});

describe('findHeaderRow', () => {
  it('finds the header in row 1', () => {
    const rows = [
      ['Organization', 'Forwarding Email', 'Position', 'Name', 'Personal Email'],
      ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com'],
    ];
    expect(findHeaderRow(rows)).toEqual({ headerIdx: 0, posIdx: 2 });
  });

  it('finds the header in row 3 when rows 1-2 are noise', () => {
    const rows = [
      ['Title — IGNORE'],
      ['Note: blah'],
      ['Organization', 'Forwarding Email', 'Position', 'Name', 'Personal Email(s)'],
      ['CO', '', 'CO Bishop', 'Alice', 'alice@gmail.com'],
    ];
    expect(findHeaderRow(rows)).toEqual({ headerIdx: 2, posIdx: 2 });
  });

  it('returns null when columns D + E do not match name + email', () => {
    const rows = [
      ['Position', 'WrongCol', 'DataB', 'DataC', 'DataD'],
      ['Bishop', 'x', 'y', 'z', 'q'],
    ];
    expect(findHeaderRow(rows)).toBeNull();
  });

  it('only scans the top 5 rows', () => {
    const rows = [
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['Organization', 'Forwarding Email', 'Position', 'Name', 'Personal Email'],
    ];
    expect(findHeaderRow(rows)).toBeNull();
  });
});

describe('resolveTabScope', () => {
  it('Stake tab → stake', () => {
    expect(resolveTabScope('Stake', new Set(['CO']))).toEqual({
      kind: 'stake',
      scope: 'stake',
      prefix: '',
    });
  });
  it('known ward → ward', () => {
    expect(resolveTabScope('CO', new Set(['CO', 'BR']))).toEqual({
      kind: 'ward',
      scope: 'CO',
      prefix: 'CO',
    });
  });
  it('unknown → skip', () => {
    expect(resolveTabScope('XX', new Set(['CO']))).toEqual({
      kind: 'skip',
      reason: 'unknown',
    });
  });
});

describe('parseTab', () => {
  const wardTemplates = buildTemplateIndex([
    { calling_name: 'Bishop', give_app_access: true, auto_kindoo_access: true, sheet_order: 1 },
    {
      calling_name: 'Bishopric Secretary',
      give_app_access: false,
      auto_kindoo_access: true,
      sheet_order: 2,
    },
    {
      calling_name: 'Counselor *',
      give_app_access: true,
      auto_kindoo_access: true,
      sheet_order: 3,
    },
  ]);

  it('parses a ward tab — strips prefix; matches template; emits one row per email', () => {
    const values = [
      ['Organization', 'Forwarding Email', 'Position', 'Name', 'Personal Email'],
      ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com'],
      ['CO', '', 'CO Bishopric Secretary', 'Bob Jones', 'bob@example.org'],
      ['CO', '', 'CO High Priest', 'Carol Nguyen', 'carol@gmail.com'], // no template match
      ['CO', '', 'CO Counselor First', 'Dan Evans', 'dan@gmail.com'],
    ];
    const { rows, warnings } = parseTab({
      tabName: 'CO',
      values,
      scope: 'CO',
      prefix: 'CO',
      templateIndex: wardTemplates,
    });
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      {
        scope: 'CO',
        calling: 'Bishop',
        email: 'alice@gmail.com',
        name: 'Alice Smith',
        giveAppAccess: true,
        autoKindooAccess: true,
        sheetOrder: 1,
      },
      {
        scope: 'CO',
        calling: 'Bishopric Secretary',
        email: 'bob@example.org',
        name: 'Bob Jones',
        giveAppAccess: false,
        autoKindooAccess: true,
        sheetOrder: 2,
      },
      {
        scope: 'CO',
        calling: 'Counselor First',
        email: 'dan@gmail.com',
        name: 'Dan Evans',
        giveAppAccess: true,
        autoKindooAccess: true,
        sheetOrder: 3,
      },
    ]);
  });

  it('parses Stake tab with prefix=""; verbatim Position', () => {
    const stakeTemplates = buildTemplateIndex([
      {
        calling_name: 'Stake President',
        give_app_access: true,
        auto_kindoo_access: true,
        sheet_order: 1,
      },
    ]);
    const values = [
      ['Organization', 'Forwarding Email', 'Position', 'Name', 'Personal Email'],
      ['Stake', '', 'Stake President', 'Alice Smith', 'alice@gmail.com'],
    ];
    const { rows } = parseTab({
      tabName: 'Stake',
      values,
      scope: 'stake',
      prefix: '',
      templateIndex: stakeTemplates,
    });
    expect(rows).toEqual([
      {
        scope: 'stake',
        calling: 'Stake President',
        email: 'alice@gmail.com',
        name: 'Alice Smith',
        giveAppAccess: true,
        autoKindooAccess: true,
        sheetOrder: 1,
      },
    ]);
  });

  it('warns on a Position that does not start with the expected prefix', () => {
    const values = [
      ['Organization', 'Forwarding Email', 'Position', 'Name', 'Personal Email'],
      ['CO', '', 'BR Bishop', 'Alice', 'alice@gmail.com'],
    ];
    const { rows, warnings } = parseTab({
      tabName: 'CO',
      values,
      scope: 'CO',
      prefix: 'CO',
      templateIndex: wardTemplates,
    });
    expect(rows).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('does not start with expected prefix');
  });

  it('multi-name cell paired with multi-email columns; missing names fall back to empty', () => {
    const values = [
      [
        'Organization',
        'Forwarding Email',
        'Position',
        'Name',
        'Personal Email',
        'extra1',
        'extra2',
      ],
      [
        'CO',
        '',
        'CO Bishopric Secretary',
        'Alice Smith, Bob Jones',
        'alice@gmail.com',
        'bob@gmail.com',
        'carol@gmail.com',
      ],
    ];
    const { rows } = parseTab({
      tabName: 'CO',
      values,
      scope: 'CO',
      prefix: 'CO',
      templateIndex: wardTemplates,
    });
    expect(rows).toEqual([
      {
        scope: 'CO',
        calling: 'Bishopric Secretary',
        email: 'alice@gmail.com',
        name: 'Alice Smith',
        giveAppAccess: false,
        autoKindooAccess: true,
        sheetOrder: 2,
      },
      {
        scope: 'CO',
        calling: 'Bishopric Secretary',
        email: 'bob@gmail.com',
        name: 'Bob Jones',
        giveAppAccess: false,
        autoKindooAccess: true,
        sheetOrder: 2,
      },
      {
        scope: 'CO',
        calling: 'Bishopric Secretary',
        email: 'carol@gmail.com',
        name: '',
        giveAppAccess: false,
        autoKindooAccess: true,
        sheetOrder: 2,
      },
    ]);
  });

  it('skips rows with no emails', () => {
    const values = [
      ['Organization', 'Forwarding Email', 'Position', 'Name', 'Personal Email'],
      ['CO', '', 'CO Bishop', 'Alice Smith', ''],
    ];
    const { rows } = parseTab({
      tabName: 'CO',
      values,
      scope: 'CO',
      prefix: 'CO',
      templateIndex: wardTemplates,
    });
    expect(rows).toEqual([]);
  });

  it('warns when header row cannot be located', () => {
    const values = [
      ['', '', '', '', ''],
      ['', '', '', '', ''],
    ];
    const { rows, warnings } = parseTab({
      tabName: 'CO',
      values,
      scope: 'CO',
      prefix: 'CO',
      templateIndex: wardTemplates,
    });
    expect(rows).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('header row not found');
  });

  it('emits give_app_access and auto_kindoo_access independently from the matched template', () => {
    const idx = buildTemplateIndex([
      { calling_name: 'A', give_app_access: true, auto_kindoo_access: true, sheet_order: 1 },
      { calling_name: 'B', give_app_access: true, auto_kindoo_access: false, sheet_order: 2 },
      { calling_name: 'C', give_app_access: false, auto_kindoo_access: true, sheet_order: 3 },
      { calling_name: 'D', give_app_access: false, auto_kindoo_access: false, sheet_order: 4 },
    ]);
    const values = [
      ['Organization', 'Forwarding Email', 'Position', 'Name', 'Personal Email'],
      ['CO', '', 'CO A', 'Alice', 'alice@gmail.com'],
      ['CO', '', 'CO B', 'Bob', 'bob@gmail.com'],
      ['CO', '', 'CO C', 'Carol', 'carol@gmail.com'],
      ['CO', '', 'CO D', 'Dan', 'dan@gmail.com'],
    ];
    const { rows } = parseTab({
      tabName: 'CO',
      values,
      scope: 'CO',
      prefix: 'CO',
      templateIndex: idx,
    });
    expect(rows.map((r) => ({ c: r.calling, g: r.giveAppAccess, a: r.autoKindooAccess }))).toEqual([
      { c: 'A', g: true, a: true },
      { c: 'B', g: true, a: false },
      { c: 'C', g: false, a: true },
      { c: 'D', g: false, a: false },
    ]);
  });
});
