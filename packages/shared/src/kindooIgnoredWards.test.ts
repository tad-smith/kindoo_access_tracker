import { describe, expect, it } from 'vitest';
import {
  collidesWithOwnWard,
  matchesIgnoredWard,
  normaliseIgnoredWard,
} from './kindooIgnoredWards.js';

describe('normaliseIgnoredWard', () => {
  it('trims and lowercases', () => {
    expect(normaliseIgnoredWard('  Maple Ward  ')).toBe('maple ward');
  });
});

describe('matchesIgnoredWard', () => {
  const list = ['Maple Ward', 'Oak Ridge Ward'];

  it('matches an entry exactly, ignoring case and surrounding whitespace', () => {
    expect(matchesIgnoredWard('Maple Ward', list)).toBe(true);
    expect(matchesIgnoredWard('  maple ward ', list)).toBe(true);
    expect(matchesIgnoredWard('OAK RIDGE WARD', list)).toBe(true);
  });

  it('does not match a longer name that merely starts with an entry', () => {
    expect(matchesIgnoredWard('Maple Ward Annex', list)).toBe(false);
  });

  it('does not match on a substring', () => {
    expect(matchesIgnoredWard('North Maple Ward', list)).toBe(false);
  });

  it('is false for an empty scope name, an empty list, or an absent list', () => {
    expect(matchesIgnoredWard('', list)).toBe(false);
    expect(matchesIgnoredWard('   ', list)).toBe(false);
    expect(matchesIgnoredWard('Maple Ward', [])).toBe(false);
    expect(matchesIgnoredWard('Maple Ward', undefined)).toBe(false);
  });

  it('tolerates untrimmed entries in the stored list', () => {
    expect(matchesIgnoredWard('Maple Ward', ['  Maple Ward  '])).toBe(true);
  });
});

describe('collidesWithOwnWard', () => {
  // The trailing " Ward" is optional in SBA, so the list mixes both.
  const wards = ['Maple', 'Jackson Creek', 'Pine Ward', 'Limon Branch'];

  it('collides on the bare stored form', () => {
    expect(collidesWithOwnWard('Maple', wards)).toBe(true);
    expect(collidesWithOwnWard('jackson creek', wards)).toBe(true);
  });

  it('collides on the " Ward"-suffixed form Kindoo descriptions carry', () => {
    expect(collidesWithOwnWard('Maple Ward', wards)).toBe(true);
    expect(collidesWithOwnWard('  JACKSON CREEK WARD ', wards)).toBe(true);
  });

  it('collides on both forms for a ward whose stored name already ends in " Ward"', () => {
    // The suffix is optional either way round: a ward stored as "Pine
    // Ward" is the same unit as one stored as "Pine", so an ignore
    // entry naming either form is naming our own ward.
    expect(collidesWithOwnWard('Pine Ward', wards)).toBe(true);
    expect(collidesWithOwnWard('Pine', wards)).toBe(true);
  });

  it('collides on a branch only under its verbatim name', () => {
    // Kindoo renders a branch verbatim, so "Limon Branch Ward" is a
    // name nothing produces — inventing a key for it would block an
    // ignore entry that could never match our own unit.
    expect(collidesWithOwnWard('Limon Branch', wards)).toBe(true);
    expect(collidesWithOwnWard('  limon branch ', wards)).toBe(true);
    expect(collidesWithOwnWard('Limon Branch Ward', wards)).toBe(false);
    expect(collidesWithOwnWard('Limon', wards)).toBe(false);
  });

  it('does not collide with a ward this stake does not own', () => {
    expect(collidesWithOwnWard('Oak Ridge Ward', wards)).toBe(false);
  });

  it('is false for an empty entry or an empty ward list', () => {
    expect(collidesWithOwnWard('', wards)).toBe(false);
    expect(collidesWithOwnWard('Maple', [])).toBe(false);
  });
});
