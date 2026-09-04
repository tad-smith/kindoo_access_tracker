// Tests for the stake-timezone date/time helpers.

import { describe, expect, it } from 'vitest';
import {
  endOfDayInStakeTz,
  formatDateInStakeTz,
  formatDateTimeInStakeTz,
  hourInStakeTz,
  previousIsoDate,
  startOfDayInStakeTz,
} from './stakeTime';

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

describe('hourInStakeTz', () => {
  it('reads the stake-local hour, not the UTC one', () => {
    // 12:15 UTC is 06:15 in Denver on MDT (UTC-6).
    const at = new Date('2026-08-18T12:15:00Z');
    expect(hourInStakeTz(at, 'America/Denver')).toBe(6);
    expect(hourInStakeTz(at, 'UTC')).toBe(12);
  });

  it('reports midnight as 0, not 24', () => {
    expect(hourInStakeTz(new Date('2026-08-18T06:00:00Z'), 'America/Denver')).toBe(0);
  });

  it('shifts with the stake zone across the date line', () => {
    // 2026-08-18T23:00Z is 2026-08-19 09:00 in Sydney (UTC+10).
    expect(hourInStakeTz(new Date('2026-08-18T23:00:00Z'), 'Australia/Sydney')).toBe(9);
  });

  it('falls back to America/Denver when the stake has no timezone', () => {
    expect(hourInStakeTz(new Date('2026-08-18T12:15:00Z'), undefined)).toBe(6);
  });

  it('is NaN for a value that names no instant', () => {
    expect(hourInStakeTz(null, 'UTC')).toBeNaN();
  });
});

describe('previousIsoDate', () => {
  it('steps back one calendar day', () => {
    expect(previousIsoDate('2026-08-18')).toBe('2026-08-17');
  });

  it('carries month, year, and leap-day rollover', () => {
    expect(previousIsoDate('2026-08-01')).toBe('2026-07-31');
    expect(previousIsoDate('2026-01-01')).toBe('2025-12-31');
    expect(previousIsoDate('2026-03-01')).toBe('2026-02-28');
    expect(previousIsoDate('2028-03-01')).toBe('2028-02-29');
  });

  it('is unaffected by a DST transition in the stake zone', () => {
    // 2026-11-01 is the US fall-back date; the answer is a calendar
    // step, so the 25-hour local day never enters into it.
    expect(previousIsoDate('2026-11-01')).toBe('2026-10-31');
  });

  it('returns the empty string for a non-ISO input', () => {
    expect(previousIsoDate('')).toBe('');
    expect(previousIsoDate('18/08/2026')).toBe('');
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
