// Unit tests for `formatDate` / `formatDateTime`. Anchored on the
// stake's display tz (`America/Denver`) so the assertions are
// independent of the host's local zone.

import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from './formatDate';

const TZ = 'America/Denver';

describe('formatDate', () => {
  it('returns empty string for null and undefined', () => {
    expect(formatDate(null, TZ)).toBe('');
    expect(formatDate(undefined, TZ)).toBe('');
  });

  it('formats an ISO date string in the stake tz', () => {
    expect(formatDate('2026-04-15', TZ)).toBe('2026-04-15');
  });

  it('formats a Date instance in the stake tz', () => {
    // 2026-04-15 12:00 UTC → 2026-04-15 06:00 Denver (MDT).
    const d = new Date('2026-04-15T12:00:00Z');
    expect(formatDate(d, TZ)).toBe('2026-04-15');
  });

  it('formats a numeric timestamp in the stake tz', () => {
    const ts = Date.UTC(2026, 3, 15, 12, 0, 0); // months are 0-based
    expect(formatDate(ts, TZ)).toBe('2026-04-15');
  });

  it('returns empty string for invalid date inputs', () => {
    expect(formatDate('not a date', TZ)).toBe('');
    expect(formatDate(NaN, TZ)).toBe('');
    expect(formatDate(new Date(NaN), TZ)).toBe('');
  });

  it('honours the timezone shift across UTC midnight', () => {
    // 2026-04-15 04:00 UTC → still 2026-04-14 22:00 Denver.
    const d = new Date('2026-04-15T04:00:00Z');
    expect(formatDate(d, TZ)).toBe('2026-04-14');
    // Same instant rendered in UTC: 2026-04-15.
    expect(formatDate(d, 'UTC')).toBe('2026-04-15');
  });
});

describe('formatDateTime', () => {
  it('returns empty string for null and undefined', () => {
    expect(formatDateTime(null, TZ)).toBe('');
    expect(formatDateTime(undefined, TZ)).toBe('');
  });

  it('formats a Date instance in the stake tz with HH:mm', () => {
    // 2026-04-15 18:30 UTC = 12:30 MDT.
    const d = new Date('2026-04-15T18:30:00Z');
    expect(formatDateTime(d, TZ)).toBe('2026-04-15 12:30');
  });

  it('uses 24-hour clock', () => {
    const d = new Date('2026-04-15T23:00:00Z'); // 17:00 MDT
    expect(formatDateTime(d, TZ)).toBe('2026-04-15 17:00');
  });

  it('renders midnight as 00:00, not 24:00', () => {
    // Midnight UTC = 18:00 previous day in Denver — pick a UTC
    // moment that lands on midnight Denver instead.
    // 2026-04-15 06:00 UTC = 00:00 MDT.
    const d = new Date('2026-04-15T06:00:00Z');
    expect(formatDateTime(d, TZ)).toBe('2026-04-15 00:00');
  });

  it('returns empty string for invalid inputs', () => {
    expect(formatDateTime('garbage', TZ)).toBe('');
    expect(formatDateTime(NaN, TZ)).toBe('');
  });
});
