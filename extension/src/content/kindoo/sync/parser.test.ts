// Parser tests. Covers every shape variant the design doc lists plus
// the picker-primary helper. Wards / stake supplied inline so the tests
// stay decoupled from real Firestore docs.

import { describe, expect, it } from 'vitest';
import { parseDescription, pickPrimarySegment } from './parser';
import type { CallingTemplateSets } from './classifier';

const STAKE = { stake_name: 'Colorado Springs North Stake' };
const WARDS = [
  { ward_code: 'CO', ward_name: 'Cordera Ward' },
  { ward_code: 'PC', ward_name: 'Pine Creek Ward' },
  { ward_code: 'MO', ward_name: 'Monument Ward' },
];

describe('parseDescription', () => {
  it('parses a single ward segment with one calling', () => {
    const parsed = parseDescription('Cordera Ward (Sunday School Teacher)', STAKE, WARDS);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]).toMatchObject({
      rawScopeName: 'Cordera Ward',
      scope: 'CO',
      calling: 'Sunday School Teacher',
      resolvedScope: true,
    });
  });

  it('parses a stake-scope segment', () => {
    const parsed = parseDescription('Colorado Springs North Stake (Stake Clerk)', STAKE, WARDS);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]).toMatchObject({
      scope: 'stake',
      calling: 'Stake Clerk',
      resolvedScope: true,
    });
  });

  it('parses two cross-scope segments separated by " | "', () => {
    const parsed = parseDescription(
      'Cordera Ward (Elders Quorum President) | Pine Creek Ward (Sunday School Teacher)',
      STAKE,
      WARDS,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]?.scope).toBe('CO');
    expect(parsed.segments[1]?.scope).toBe('PC');
  });

  it('parses three cross-scope segments', () => {
    const parsed = parseDescription(
      'Cordera Ward (A) | Pine Creek Ward (B) | Monument Ward (C)',
      STAKE,
      WARDS,
    );
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.segments.map((s) => s.scope)).toEqual(['CO', 'PC', 'MO']);
  });

  it('preserves a multi-calling parens body as a single comma-separated string', () => {
    const parsed = parseDescription(
      'Cordera Ward (Elders Quorum First Counselor, Accompanist)',
      STAKE,
      WARDS,
    );
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.calling).toBe('Elders Quorum First Counselor, Accompanist');
  });

  it('matches scope names case-insensitively and ignores surrounding whitespace', () => {
    const parsed = parseDescription('  CORDERA WARD  (Test)', STAKE, WARDS);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('CO');
  });

  it('flags unparseable when input is empty', () => {
    const parsed = parseDescription('', STAKE, WARDS);
    expect(parsed.unparseable).toBe(true);
    expect(parsed.segments).toHaveLength(0);
  });

  it('flags unparseable when the segment has no parens', () => {
    const parsed = parseDescription('Random free text', STAKE, WARDS);
    expect(parsed.unparseable).toBe(true);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.resolvedScope).toBe(false);
  });

  it('flags unparseable when the scope name does not match any ward or the stake', () => {
    const parsed = parseDescription('Springfield Ward (Bishop)', STAKE, WARDS);
    expect(parsed.unparseable).toBe(true);
    expect(parsed.segments[0]?.resolvedScope).toBe(false);
    expect(parsed.segments[0]?.rawScopeName).toBe('Springfield Ward');
  });

  it('flags unparseable for a Kindoo Manager-style description', () => {
    const parsed = parseDescription('Kindoo Manager - Stake Clerk account', STAKE, WARDS);
    expect(parsed.unparseable).toBe(true);
  });

  it('marks partial-match descriptions as parseable when at least one segment resolves', () => {
    const parsed = parseDescription(
      'Cordera Ward (Elders Quorum President) | Unknown Ward (Whatever)',
      STAKE,
      WARDS,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.resolvedScope).toBe(true);
    expect(parsed.segments[1]?.resolvedScope).toBe(false);
  });

  it('keeps the original raw input on the result', () => {
    const input = 'Cordera Ward (Sunday School Teacher)';
    const parsed = parseDescription(input, STAKE, WARDS);
    expect(parsed.raw).toBe(input);
  });

  it('handles parens nested in calling text by greedy-matching to the last close paren', () => {
    const parsed = parseDescription('Cordera Ward (Sunday School Teacher (Primary))', STAKE, WARDS);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.calling).toBe('Sunday School Teacher (Primary)');
  });

  // ----- kindoo_expected_site_name override -----

  it('resolves stake scope via kindoo_expected_site_name override when present', () => {
    // Staging Firestore: `stake_name` carries a STAGING prefix, but
    // Kindoo's description carries the un-prefixed real name. The
    // override field bridges the gap.
    const stagingStake = {
      stake_name: 'STAGING - Colorado Springs North Stake',
      kindoo_expected_site_name: 'Colorado Springs North Stake',
    };
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk)',
      stagingStake,
      WARDS,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]).toMatchObject({ scope: 'stake', resolvedScope: true });
  });

  it('falls back to stake_name when kindoo_expected_site_name is absent', () => {
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk)',
      { stake_name: 'Colorado Springs North Stake' },
      WARDS,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('stake');
  });

  it('falls back to stake_name when kindoo_expected_site_name is empty / whitespace', () => {
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk)',
      { stake_name: 'Colorado Springs North Stake', kindoo_expected_site_name: '   ' },
      WARDS,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('stake');
  });

  it('does not resolve when neither stake_name nor kindoo_expected_site_name matches', () => {
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk)',
      {
        stake_name: 'STAGING - Colorado Springs North Stake',
        kindoo_expected_site_name: 'Some Other Stake',
      },
      WARDS,
    );
    expect(parsed.unparseable).toBe(true);
    expect(parsed.segments[0]?.resolvedScope).toBe(false);
  });

  // ----- ward " Ward" suffix asymmetry -----

  it('resolves a ward when ward_name lacks " Ward" but the description carries it', () => {
    // SBA stores ward names without the trailing " Ward". Kindoo
    // descriptions include it. Both forms must resolve.
    const wardsNoSuffix = [{ ward_code: 'JC', ward_name: 'Jackson Creek' }];
    const parsed = parseDescription(
      'Jackson Creek Ward (Young Women President)',
      STAKE,
      wardsNoSuffix,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('JC');
  });

  it('resolves a ward when neither ward_name nor description carries " Ward"', () => {
    const wardsNoSuffix = [{ ward_code: 'JC', ward_name: 'Jackson Creek' }];
    const parsed = parseDescription('Jackson Creek (Young Women President)', STAKE, wardsNoSuffix);
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('JC');
  });

  it('resolves a ward whose ward_name already ends in " Ward" via the suffix form', () => {
    // ward_name with the suffix → only the with-suffix key is
    // registered. Descriptions with the suffix still resolve.
    const wardsWithSuffix = [{ ward_code: 'JC', ward_name: 'Jackson Creek Ward' }];
    const parsed = parseDescription(
      'Jackson Creek Ward (Young Women President)',
      STAKE,
      wardsWithSuffix,
    );
    expect(parsed.unparseable).toBe(false);
    expect(parsed.segments[0]?.scope).toBe('JC');
  });

  it('does NOT resolve an unsuffixed description against a ward_name that includes " Ward"', () => {
    // When ward_name is "Jackson Creek Ward", only that exact form is
    // registered as a lookup key. An unsuffixed "Jackson Creek (X)"
    // description does not match — the parser only strips/adds the
    // " Ward" suffix on the ward_name side, never on the description
    // side. Documented to keep the two-key behavior asymmetric and
    // predictable.
    const wardsWithSuffix = [{ ward_code: 'JC', ward_name: 'Jackson Creek Ward' }];
    const parsed = parseDescription(
      'Jackson Creek (Young Women President)',
      STAKE,
      wardsWithSuffix,
    );
    expect(parsed.unparseable).toBe(true);
    expect(parsed.segments[0]?.resolvedScope).toBe(false);
  });
});

describe('pickPrimarySegment', () => {
  it('picks the stake-scope segment when present', () => {
    const parsed = parseDescription(
      'Cordera Ward (A) | Colorado Springs North Stake (B) | Pine Creek Ward (C)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed);
    expect(primary?.scope).toBe('stake');
  });

  it('picks the alphabetically-first ward when only wards resolve', () => {
    const parsed = parseDescription(
      'Pine Creek Ward (A) | Cordera Ward (B) | Monument Ward (C)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed);
    // ward_code ordering: CO < MO < PC.
    expect(primary?.scope).toBe('CO');
  });

  it('returns null when nothing resolved', () => {
    const parsed = parseDescription('Random text', STAKE, WARDS);
    expect(pickPrimarySegment(parsed)).toBeNull();
  });

  it('returns the lone resolved segment when only one resolves', () => {
    const parsed = parseDescription('Cordera Ward (A) | Springfield Ward (B)', STAKE, WARDS);
    expect(pickPrimarySegment(parsed)?.scope).toBe('CO');
  });

  // ----- sets-aware auto-preference rule -----

  /**
   * Builds a minimal sets for tests. `wardAuto` is applied to every
   * ward — mirrors the classifier's union-of-templates behavior.
   */
  function buildSets(stakeAuto: string[], wardAuto: string[]): CallingTemplateSets {
    const wardSet = new Set(wardAuto.map((s) => s.toLowerCase()));
    return {
      stakeCallings: new Set(stakeAuto.map((s) => s.toLowerCase())),
      wardCallings: new Map(WARDS.map((w) => [w.ward_code, new Set(wardSet)])),
    };
  }

  it('prefers an auto-matching ward over a non-auto stake segment (corry@corrymac.com shape)', () => {
    // Stake "Technology Specialist" is non-auto; ward "Bishop" is auto.
    // The live false-positive scope-mismatch case: SBA seat lives on
    // the ward, but the alphabetical/stake-first rule would have
    // picked the stake segment as primary. With `sets` the auto ward
    // wins.
    const parsed = parseDescription(
      'Colorado Springs North Stake (Technology Specialist) | Cordera Ward (Bishop)',
      STAKE,
      WARDS,
    );
    const sets = buildSets([], ['Bishop']);
    const primary = pickPrimarySegment(parsed, sets);
    expect(primary?.scope).toBe('CO');
    expect(primary?.calling).toBe('Bishop');
  });

  it('returns the stake segment when both stake and ward auto-match', () => {
    // Existing stake-first tiebreaker is preserved among auto-matching
    // segments.
    const parsed = parseDescription(
      'Colorado Springs North Stake (Stake Clerk) | Cordera Ward (Bishop)',
      STAKE,
      WARDS,
    );
    const sets = buildSets(['Stake Clerk'], ['Bishop']);
    const primary = pickPrimarySegment(parsed, sets);
    expect(primary?.scope).toBe('stake');
  });

  it('returns the alphabetically-first ward when multiple wards auto-match', () => {
    const parsed = parseDescription(
      'Pine Creek Ward (Bishop) | Cordera Ward (Bishop) | Monument Ward (Bishop)',
      STAKE,
      WARDS,
    );
    const sets = buildSets([], ['Bishop']);
    const primary = pickPrimarySegment(parsed, sets);
    expect(primary?.scope).toBe('CO');
  });

  it('falls back to stake-first when no segment auto-matches', () => {
    // Original rule still applies when the auto-match pool is empty.
    const parsed = parseDescription(
      'Colorado Springs North Stake (Technology Specialist) | Cordera Ward (Pianist)',
      STAKE,
      WARDS,
    );
    const sets = buildSets([], []);
    const primary = pickPrimarySegment(parsed, sets);
    expect(primary?.scope).toBe('stake');
  });

  it('without `sets` behaves identically to the legacy stake-first rule', () => {
    // Backward-compat guard: existing call sites that don't pass sets
    // continue to see the original behavior.
    const parsed = parseDescription(
      'Colorado Springs North Stake (Technology Specialist) | Cordera Ward (Bishop)',
      STAKE,
      WARDS,
    );
    const primary = pickPrimarySegment(parsed);
    expect(primary?.scope).toBe('stake');
  });
});
