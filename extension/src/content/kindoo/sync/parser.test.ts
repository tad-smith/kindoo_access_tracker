// Parser tests. Covers every shape variant the design doc lists plus
// the picker-primary helper. Wards / stake supplied inline so the tests
// stay decoupled from real Firestore docs.

import { describe, expect, it } from 'vitest';
import { parseDescription, pickPrimarySegment } from './parser';

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
});
