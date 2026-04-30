// Tests for the stake-timezone datetime formatters.

import { describe, expect, it } from 'vitest';
import { formatDateInStakeTz, formatDateTimeInStakeTz } from './datetime';

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
