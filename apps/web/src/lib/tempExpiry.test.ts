// Expired-temp-grant predicate (spec §7).

import { describe, expect, it } from 'vitest';
import { isExpiredTempGrant, todayInStakeTz } from './tempExpiry';

const temp = (end_date?: string) => ({ type: 'temp' as const, ...(end_date ? { end_date } : {}) });

describe('isExpiredTempGrant', () => {
  it('is false on the end date itself — the seat is held THROUGH it', () => {
    expect(isExpiredTempGrant(temp('2026-08-17'), '2026-08-17')).toBe(false);
  });

  it('is true the day after the end date', () => {
    expect(isExpiredTempGrant(temp('2026-08-17'), '2026-08-18')).toBe(true);
  });

  it('is false before the end date', () => {
    expect(isExpiredTempGrant(temp('2026-09-01'), '2026-08-17')).toBe(false);
  });

  it('compares chronologically across month and year rollovers', () => {
    expect(isExpiredTempGrant(temp('2025-12-31'), '2026-01-01')).toBe(true);
    expect(isExpiredTempGrant(temp('2026-01-01'), '2025-12-31')).toBe(false);
    expect(isExpiredTempGrant(temp('2026-08-09'), '2026-08-10')).toBe(true);
  });

  it('never expires a temp grant with no end date', () => {
    expect(isExpiredTempGrant(temp(), '2099-01-01')).toBe(false);
  });

  it('never expires a non-temp grant, even one carrying a past end date', () => {
    expect(isExpiredTempGrant({ type: 'auto', end_date: '2020-01-01' }, '2026-08-17')).toBe(false);
    expect(isExpiredTempGrant({ type: 'manual', end_date: '2020-01-01' }, '2026-08-17')).toBe(
      false,
    );
  });
});

describe('todayInStakeTz', () => {
  it('names the stake calendar day, not the viewer/UTC one', () => {
    // 2026-08-18 05:30 UTC is still 2026-08-17 in Denver (UTC-6).
    const at = new Date('2026-08-18T05:30:00Z');
    expect(todayInStakeTz('America/Denver', at)).toBe('2026-08-17');
    expect(todayInStakeTz('UTC', at)).toBe('2026-08-18');
  });

  it('falls back to America/Denver when the stake doc has not landed', () => {
    const at = new Date('2026-08-18T05:30:00Z');
    expect(todayInStakeTz(undefined, at)).toBe('2026-08-17');
  });
});
