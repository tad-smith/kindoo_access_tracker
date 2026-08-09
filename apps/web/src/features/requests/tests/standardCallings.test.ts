// Covers what `standardCallings.ts` still decides for itself.
//
// The conformance suite that used to live here is gone (T-99). It
// reconstructed the shared table's shape through `callingSortOrder()` —
// every entry resolves, the concatenation ascends strictly, the covered
// indices are gap-free — to catch the copy of that table drifting. There
// is no copy now: `STAKE_CALLINGS` and `UNIT_CALLINGS` are the shared
// table's two bands, so all three assertions hold by construction and
// tested nothing but `Array.prototype.filter`. The band invariants they
// were really about moved to `packages/shared`'s
// `callingSortOrder.test.ts`, next to the table they constrain.
//
// What is left is the product ruling — which ward callings a branch
// replaces — and the one hand-maintained thing that implements it: the
// two hide-sets. A name in a hide-set that the shared table no longer
// spells subtracts nothing and fails silently, leaving the wrong entry
// in a branch's typeahead. That is the shape of the T-96 bug, on the
// only surface where it can still happen, so it gets its own test.

import { describe, expect, it } from 'vitest';
import type { Ward } from '@kindoo/shared';
import {
  BRANCH_CALLINGS,
  BRANCH_ONLY_CALLINGS,
  STAKE_CALLINGS,
  UNIT_CALLINGS,
  WARD_CALLINGS,
  WARD_ONLY_CALLINGS,
  callingsForScope,
} from '../standardCallings';

function unit(code: string, name: string): Ward {
  return { ward_code: code, ward_name: name } as unknown as Ward;
}

const CATALOGUE: readonly Ward[] = [
  unit('CO', 'Maple Ward'),
  unit('peterson-branch', 'Peterson Branch'),
];

describe('standard calling lists', () => {
  it('draws the stake list and the unit list from their own bands', () => {
    // The one mis-wiring the checks below would miss. They anchor the
    // unit lists to real ward and branch entries, but nothing else would
    // notice `STAKE_CALLINGS` pointed at the wrong band.
    expect(STAKE_CALLINGS[0]).toBe('Stake President');
    expect(UNIT_CALLINGS[0]).toBe('Bishop');
    expect(STAKE_CALLINGS.some((c) => UNIT_CALLINGS.includes(c))).toBe(false);
  });

  it('subtracts only names the shared unit band still spells', () => {
    // The hide-sets are hand-written strings; the band they subtract from
    // is not. Rename a calling in `@kindoo/shared` and the matching
    // hide-set entry stops matching anything — no error, just a Ward
    // Clerk offered at a branch. Membership in `UNIT_CALLINGS` is the
    // shared-table check, sharpened: an entry that moved to the stake
    // band would also never be subtracted.
    const stale = [...WARD_ONLY_CALLINGS, ...BRANCH_ONLY_CALLINGS].filter(
      (c) => !UNIT_CALLINGS.includes(c),
    );
    expect(stale).toEqual([]);
  });

  it('loses no unit calling to the split — ward plus branch spans the union', () => {
    // Derivation guarantees the union tracks the shared band; it says
    // nothing about the two sub-lists between them. An entry that landed
    // in BOTH hide-sets would reach no typeahead at all.
    const spanned = new Set([...WARD_CALLINGS, ...BRANCH_CALLINGS]);
    expect([...UNIT_CALLINGS].filter((c) => !spanned.has(c))).toEqual([]);
  });

  it('hides every ward-only calling from a branch, and offers its counterpart', () => {
    const swapped: ReadonlyArray<readonly [string, string]> = [
      ['Bishop', 'Branch President'],
      ['Bishopric First Counselor', 'Branch Presidency First Counselor'],
      ['Bishopric Second Counselor', 'Branch Presidency Second Counselor'],
      ['Ward Clerk', 'Branch Clerk'],
      ['Ward Assistant Clerk', 'Branch Assistant Clerk'],
      ['Ward Assistant Clerk--Membership', 'Branch Assistant Clerk--Membership'],
      ['Ward Assistant Clerk--Finance', 'Branch Assistant Clerk--Finance'],
    ];
    for (const [ward, branch] of swapped) {
      expect(BRANCH_CALLINGS).not.toContain(ward);
      expect(BRANCH_CALLINGS).toContain(branch);
    }
  });

  it('hides both executive secretary callings from a branch with no replacement', () => {
    // A branch has no executive secretary at all — the same fact behind
    // T-96 omitting a "Branch Executive Secretary" from the shared table.
    expect(BRANCH_CALLINGS).not.toContain('Ward Executive Secretary');
    expect(BRANCH_CALLINGS).not.toContain('Ward Assistant Executive Secretary');
    expect(BRANCH_CALLINGS.filter((c) => /executive secretary/i.test(c))).toEqual([]);
  });

  it('carries the non-swapped unit callings over to a branch unchanged', () => {
    // T-96's four families are not an exhaustive whitelist: Sunday School,
    // Ward Mission Leader and the specialists reach a branch too.
    expect(BRANCH_CALLINGS).toEqual(
      expect.arrayContaining([
        'Elders Quorum President',
        'Relief Society President',
        'Primary President',
        'Young Women President',
        'Sunday School President',
        'Aaronic Priesthood Advisors',
        'Ward Mission Leader',
        'Ward Temple and Family History Leader',
        'Building Representative',
        'Technology Specialist',
      ]),
    );
  });

  it('offers no branch calling at a ward', () => {
    expect(WARD_CALLINGS.filter((c) => c.startsWith('Branch '))).toEqual([]);
  });

  it('leaves the ward list exactly as it was before branches existed', () => {
    // 43 entries — the unit band minus the seven branch-only additions.
    expect(WARD_CALLINGS).toHaveLength(UNIT_CALLINGS.length - 7);
    expect(WARD_CALLINGS).toEqual(
      expect.arrayContaining([
        'Bishop',
        'Bishopric First Counselor',
        'Ward Executive Secretary',
        'Ward Assistant Executive Secretary',
        'Ward Clerk',
        'Ward Assistant Clerk--Finance',
      ]),
    );
  });
});

describe('callingsForScope', () => {
  it('resolves a branch by its name, not its code', () => {
    // `peterson-branch` is a slug; the ruling is that only the ward doc's
    // NAME decides the unit kind (D31).
    expect(callingsForScope('peterson-branch', CATALOGUE)).toBe(BRANCH_CALLINGS);
  });

  it('resolves a ward by its name', () => {
    expect(callingsForScope('CO', CATALOGUE)).toBe(WARD_CALLINGS);
  });

  it('reads a branch whose code looks nothing like its name', () => {
    // The slug is not derived from the name for legacy units, so a
    // two-letter code must still resolve to a branch.
    expect(callingsForScope('LB', [unit('LB', 'Lakeside Branch')])).toBe(BRANCH_CALLINGS);
  });

  it('does not mistake a ward named "…Branch Ward" for a branch', () => {
    expect(callingsForScope('OB', [unit('OB', 'Olive Branch Ward')])).toBe(WARD_CALLINGS);
  });

  it('offers the stake list at stake scope, whatever the catalogue holds', () => {
    expect(callingsForScope('stake', CATALOGUE)).toBe(STAKE_CALLINGS);
  });

  it('falls back to the combined unit list when the scope is not in the catalogue', () => {
    // Chosen over an empty list: `wards` comes from a live query, so every
    // scope is unresolvable mid-load and a blank typeahead would be a
    // regression. A superset never blocks — free text submits anyway.
    expect(callingsForScope('CO', [])).toBe(UNIT_CALLINGS);
    expect(callingsForScope('unknown-unit', CATALOGUE)).toBe(UNIT_CALLINGS);
    expect(callingsForScope('', CATALOGUE)).toBe(UNIT_CALLINGS);
  });

  it('never returns an empty suggestion list', () => {
    for (const scope of ['stake', 'CO', 'peterson-branch', 'unknown', '']) {
      expect(callingsForScope(scope, CATALOGUE).length).toBeGreaterThan(0);
    }
  });
});
