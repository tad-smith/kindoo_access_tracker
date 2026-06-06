// Tests for the stake-timezone datetime formatters.

import { describe, expect, it } from 'vitest';
import {
  endOfDayInStakeTz,
  formatDateInStakeTz,
  formatDateTimeInStakeTz,
  startOfDayInStakeTz,
} from './datetime';

describe('formatDateTimeInStakeTz', () => {
  it('formats a UTC instant in America/Denver as YYYY-MM-DD h:mm am/pm', () => {
    // 2026-04-29T18:30:00Z = 2026-04-29 12:30 pm in MDT (UTC-6)
    const d = new Date('2026-04-29T18:30:00Z');
    expect(formatDateTimeInStakeTz(d, 'America/Denver')).toBe('2026-04-29 12:30 pm');
  });

  it('formats midnight Denver as 12:00 am', () => {
    // 2026-04-29T06:00:00Z = 2026-04-29 00:00 in MDT
    const d = new Date('2026-04-29T06:00:00Z');
    expect(formatDateTimeInStakeTz(d, 'America/Denver')).toBe('2026-04-29 12:00 am');
  });

  it('handles a Firestore-Timestamp-shaped value via toDate()', () => {
    const ts = {
      seconds: Math.floor(Date.UTC(2026, 3, 29, 18, 30) / 1000),
      nanoseconds: 0,
      toDate: () => new Date('2026-04-29T18:30:00Z'),
      toMillis: () => Date.UTC(2026, 3, 29, 18, 30),
    };
    expect(formatDateTimeInStakeTz(ts, 'America/Denver')).toBe('2026-04-29 12:30 pm');
  });

  it('returns the empty string for null / undefined', () => {
    expect(formatDateTimeInStakeTz(null, 'UTC')).toBe('');
    expect(formatDateTimeInStakeTz(undefined, 'UTC')).toBe('');
  });

  it('falls back to America/Denver when no timezone is provided', () => {
    // 2026-04-29T18:30:00Z = 2026-04-29 12:30 pm in MDT (UTC-6).
    // Default fallback fires because the stake doc snapshot may be
    // mid-load when the audit row first renders.
    const d = new Date('2026-04-29T18:30:00Z');
    expect(formatDateTimeInStakeTz(d, undefined)).toBe('2026-04-29 12:30 pm');
  });
});

describe('formatDateInStakeTz', () => {
  it('formats date-only in the stake timezone', () => {
    const d = new Date('2026-04-30T05:00:00Z'); // 2026-04-29 in MDT
    expect(formatDateInStakeTz(d, 'America/Denver')).toBe('2026-04-29');
  });
});

describe('startOfDayInStakeTz', () => {
  it('resolves a winter date (MST, UTC-7, DST off) to local midnight', () => {
    // 2026-01-15 00:00 in America/Denver (MST, UTC-7) = 2026-01-15T07:00Z.
    expect(startOfDayInStakeTz('2026-01-15', 'America/Denver').toISOString()).toBe(
      '2026-01-15T07:00:00.000Z',
    );
  });

  it('resolves a summer date (MDT, UTC-6, DST on) to local midnight', () => {
    // 2026-07-15 00:00 in America/Denver (MDT, UTC-6) = 2026-07-15T06:00Z.
    expect(startOfDayInStakeTz('2026-07-15', 'America/Denver').toISOString()).toBe(
      '2026-07-15T06:00:00.000Z',
    );
  });

  it('falls back to America/Denver when no timezone is provided', () => {
    expect(startOfDayInStakeTz('2026-07-15', undefined).toISOString()).toBe(
      '2026-07-15T06:00:00.000Z',
    );
  });

  it('honors a non-Denver timezone (UTC stays at the UTC midnight)', () => {
    expect(startOfDayInStakeTz('2026-07-15', 'UTC').toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('honors an east-of-UTC timezone (Europe/London BST, UTC+1)', () => {
    // 2026-07-15 00:00 London (BST, UTC+1) = 2026-07-14T23:00Z.
    expect(startOfDayInStakeTz('2026-07-15', 'Europe/London').toISOString()).toBe(
      '2026-07-14T23:00:00.000Z',
    );
  });
});

describe('endOfDayInStakeTz', () => {
  it('resolves a winter date (MST, UTC-7) to local 23:59:59.999', () => {
    // 2026-01-15 23:59:59.999 MST (UTC-7) = 2026-01-16T06:59:59.999Z.
    expect(endOfDayInStakeTz('2026-01-15', 'America/Denver').toISOString()).toBe(
      '2026-01-16T06:59:59.999Z',
    );
  });

  it('resolves a summer date (MDT, UTC-6) to local 23:59:59.999', () => {
    // 2026-07-15 23:59:59.999 MDT (UTC-6) = 2026-07-16T05:59:59.999Z.
    expect(endOfDayInStakeTz('2026-07-15', 'America/Denver').toISOString()).toBe(
      '2026-07-16T05:59:59.999Z',
    );
  });

  it('falls back to America/Denver when no timezone is provided', () => {
    expect(endOfDayInStakeTz('2026-01-15', undefined).toISOString()).toBe(
      '2026-01-16T06:59:59.999Z',
    );
  });

  it('makes a single-day filter span exactly one local day end-to-end', () => {
    const start = startOfDayInStakeTz('2026-07-15', 'America/Denver');
    const end = endOfDayInStakeTz('2026-07-15', 'America/Denver');
    // 24h minus 1ms.
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });
});
