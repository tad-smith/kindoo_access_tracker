// Tests for the limited-access temp-window cap. The DST case is the
// reason `tempWindow.ts` parses with `Date.UTC` — it fails under
// local-midnight arithmetic in any US zone.
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_LIMITED_TEMP_WINDOW_DAYS,
  exceedsLimitedTempWindow,
  isoDateSpanDays,
} from './tempWindow.js';

describe('MAX_LIMITED_TEMP_WINDOW_DAYS', () => {
  it('is 90', () => {
    expect(MAX_LIMITED_TEMP_WINDOW_DAYS).toBe(90);
  });
});

describe('isoDateSpanDays', () => {
  it('counts a same-day window as zero', () => {
    expect(isoDateSpanDays('2026-08-02', '2026-08-02')).toBe(0);
  });

  it('counts whole days across a month boundary', () => {
    expect(isoDateSpanDays('2026-01-31', '2026-02-01')).toBe(1);
    expect(isoDateSpanDays('2026-08-02', '2026-08-09')).toBe(7);
  });

  it('counts a leap day in a span that crosses one', () => {
    // 2028 is a leap year: Feb 1 -> May 1 is 29 + 31 + 30 = 90 days.
    expect(isoDateSpanDays('2028-02-01', '2028-05-01')).toBe(90);
    // The same calendar span in a non-leap year is one day shorter.
    expect(isoDateSpanDays('2027-02-01', '2027-05-01')).toBe(89);
  });

  it('spans a full non-leap year as 365 days', () => {
    expect(isoDateSpanDays('2026-01-01', '2027-01-01')).toBe(365);
  });

  it('returns a negative count when the end precedes the start', () => {
    expect(isoDateSpanDays('2026-08-09', '2026-08-02')).toBe(-7);
  });

  it('returns NaN for input that is not ISO-shaped', () => {
    expect(isoDateSpanDays('', '2026-08-02')).toBeNaN();
    expect(isoDateSpanDays('2026-08-02', '')).toBeNaN();
    expect(isoDateSpanDays('08/02/2026', '2026-08-02')).toBeNaN();
    expect(isoDateSpanDays('2026-8-2', '2026-08-02')).toBeNaN();
    expect(isoDateSpanDays('2026-08-02T00:00:00Z', '2026-08-02')).toBeNaN();
  });
});

describe('exceedsLimitedTempWindow', () => {
  it('allows exactly 90 days', () => {
    // 2026-05-04 + 90 days = 2026-08-02.
    expect(isoDateSpanDays('2026-05-04', '2026-08-02')).toBe(90);
    expect(exceedsLimitedTempWindow('2026-05-04', '2026-08-02')).toBe(false);
  });

  it('rejects 91 days', () => {
    expect(isoDateSpanDays('2026-05-03', '2026-08-02')).toBe(91);
    expect(exceedsLimitedTempWindow('2026-05-03', '2026-08-02')).toBe(true);
  });

  it('allows a same-day window', () => {
    expect(exceedsLimitedTempWindow('2026-08-02', '2026-08-02')).toBe(false);
  });

  it('allows a 90-day window that crosses a leap day', () => {
    expect(exceedsLimitedTempWindow('2028-02-01', '2028-05-01')).toBe(false);
    // One day past the leap-year 90 is over the cap.
    expect(exceedsLimitedTempWindow('2028-01-31', '2028-05-01')).toBe(true);
  });

  it('rejects a year-long window', () => {
    expect(exceedsLimitedTempWindow('2026-01-01', '2027-01-01')).toBe(true);
  });

  it('answers false for unparseable input (shape is validated upstream)', () => {
    expect(exceedsLimitedTempWindow('not-a-date', 'also-not')).toBe(false);
    expect(exceedsLimitedTempWindow('', '')).toBe(false);
  });
});

describe('timezone independence', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // Both windows straddle a US DST transition: spring-forward on
  // 2026-03-08 (a 23-hour local day) and fall-back on 2026-11-01 (25
  // hours). Local-midnight subtraction reports 89.96 / 90.04 days and
  // flips the cap; UTC parsing does not.
  const cases: ReadonlyArray<readonly [string, string, string, number]> = [
    ['spring forward', '2026-01-01', '2026-04-01', 90],
    ['fall back', '2026-09-15', '2026-12-14', 90],
  ];

  for (const tz of ['UTC', 'America/Denver', 'America/New_York', 'Pacific/Kiritimati']) {
    for (const [label, start, end, expected] of cases) {
      it(`spans ${label} identically in ${tz}`, () => {
        process.env.TZ = tz;
        expect(isoDateSpanDays(start, end)).toBe(expected);
        expect(exceedsLimitedTempWindow(start, end)).toBe(false);
      });
    }
  }

  it('drifts off 90 under local-midnight arithmetic (the bug Date.UTC avoids)', () => {
    // Guards the guard: if the runtime ignored `process.env.TZ` the
    // cases above would pass without ever leaving UTC. Local math over
    // the spring-forward window loses an hour and lands at 89.958.
    process.env.TZ = 'America/Denver';
    const localSpan =
      (new Date(2026, 3, 1).getTime() - new Date(2026, 0, 1).getTime()) / (24 * 60 * 60 * 1000);
    expect(localSpan).not.toBe(90);
    expect(isoDateSpanDays('2026-01-01', '2026-04-01')).toBe(90);
  });
});
