// Schedule maths for the per-stake task dispatcher.
//
// Every case here is a calendar fact, so the fixtures are real dates in
// a real zone: `America/Denver` (MST/MDT), whose 2026 transitions are
// 2026-03-08 (forward) and 2026-11-01 (back). The assertions pair a UTC
// instant with the wall-clock time it renders as, because the whole
// point of the daily / weekly / monthly shapes is that the wall clock
// holds still while the instant moves.

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SCHEDULE_ADVANCES,
  advanceTriggerTime,
  isTaskDue,
  nextTriggerTime,
  type ScheduledTask,
  type TaskSchedule,
} from './scheduledTasks.js';
import type { TimestampLike } from './types/userIndex.js';

const TZ = 'America/Denver';

/** `YYYY-MM-DD HH:mm` as rendered in `TZ` — what a manager would see. */
function local(date: Date, timezone = TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

const daily = (hour: number): TaskSchedule => ({ type: 'daily', hour });
const weekly = (weekday: number, hour: number): TaskSchedule => ({ type: 'weekly', weekday, hour });
const monthly = (day: number, hour: number): TaskSchedule => ({ type: 'monthly', day, hour });

describe('advanceTriggerTime — hourly', () => {
  it('adds exactly one hour, preserving the minute phase', () => {
    const from = new Date('2026-09-05T14:17:00.000Z');
    expect(advanceTriggerTime({ type: 'hourly' }, TZ, from).toISOString()).toBe(
      '2026-09-05T15:17:00.000Z',
    );
  });

  it('is an hour of real time across a DST transition, not an hour of wall clock', () => {
    // 01:30 MST on spring-forward day; the wall clock jumps to 03:30.
    const from = new Date('2026-03-08T08:30:00.000Z');
    const next = advanceTriggerTime({ type: 'hourly' }, TZ, from);
    expect(next.toISOString()).toBe('2026-03-08T09:30:00.000Z');
    expect(local(from)).toBe('2026-03-08 01:30');
    expect(local(next)).toBe('2026-03-08 03:30');
  });
});

describe('advanceTriggerTime — daily', () => {
  it('returns today’s slot when it is still ahead', () => {
    const from = new Date('2026-09-05T09:00:00.000Z'); // 03:00 Denver
    expect(local(advanceTriggerTime(daily(6), TZ, from))).toBe('2026-09-05 06:00');
  });

  it('rolls to tomorrow when today’s slot has passed', () => {
    const from = new Date('2026-09-05T18:00:00.000Z'); // 12:00 Denver
    expect(local(advanceTriggerTime(daily(6), TZ, from))).toBe('2026-09-06 06:00');
  });

  it('is strictly after `from` when `from` is exactly the slot', () => {
    const from = new Date('2026-09-05T12:00:00.000Z'); // 06:00 Denver
    const next = advanceTriggerTime(daily(6), TZ, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(local(next)).toBe('2026-09-06 06:00');
  });

  it('holds the wall clock across the spring-forward transition (a 23-hour day)', () => {
    const from = new Date('2026-03-07T13:00:00.000Z'); // 06:00 MST
    const next = advanceTriggerTime(daily(6), TZ, from);
    expect(next.toISOString()).toBe('2026-03-08T12:00:00.000Z');
    expect(local(next)).toBe('2026-03-08 06:00');
    expect(next.getTime() - from.getTime()).toBe(23 * 3_600_000);
  });

  it('holds the wall clock across the fall-back transition (a 25-hour day)', () => {
    const from = new Date('2026-10-31T12:00:00.000Z'); // 06:00 MDT
    const next = advanceTriggerTime(daily(6), TZ, from);
    expect(next.toISOString()).toBe('2026-11-01T13:00:00.000Z');
    expect(local(next)).toBe('2026-11-01 06:00');
    expect(next.getTime() - from.getTime()).toBe(25 * 3_600_000);
  });

  it('reads the hour in the stake’s zone, not the server’s', () => {
    const from = new Date('2026-09-05T09:00:00.000Z');
    expect(local(advanceTriggerTime(daily(6), 'Pacific/Honolulu', from), 'Pacific/Honolulu')).toBe(
      '2026-09-05 06:00',
    );
  });
});

describe('advanceTriggerTime — weekly', () => {
  it('finds the next occurrence of the weekday later this week', () => {
    // 2026-09-02 is a Wednesday; Monday is weekday 1.
    const from = new Date('2026-09-02T18:00:00.000Z');
    expect(local(advanceTriggerTime(weekly(1, 9), TZ, from))).toBe('2026-09-07 09:00');
  });

  it('rolls a full week when today is the weekday and the slot has passed', () => {
    const from = new Date('2026-09-07T18:00:00.000Z'); // Monday 12:00 Denver
    expect(local(advanceTriggerTime(weekly(1, 9), TZ, from))).toBe('2026-09-14 09:00');
  });

  it('stays today when today is the weekday and the slot is still ahead', () => {
    const from = new Date('2026-09-07T12:00:00.000Z'); // Monday 06:00 Denver
    expect(local(advanceTriggerTime(weekly(1, 9), TZ, from))).toBe('2026-09-07 09:00');
  });

  it('rolls across the year boundary', () => {
    // 2026-12-30 is a Wednesday; the next Monday is 2027-01-04.
    const from = new Date('2026-12-30T18:00:00.000Z');
    expect(local(advanceTriggerTime(weekly(1, 9), TZ, from))).toBe('2027-01-04 09:00');
  });

  it('handles Sunday (weekday 0) without wrapping backwards', () => {
    const from = new Date('2026-09-02T18:00:00.000Z'); // Wednesday
    expect(local(advanceTriggerTime(weekly(0, 7), TZ, from))).toBe('2026-09-06 07:00');
  });
});

describe('advanceTriggerTime — monthly', () => {
  it('finds this month’s slot when it is still ahead', () => {
    const from = new Date('2026-09-05T18:00:00.000Z');
    expect(local(advanceTriggerTime(monthly(20, 8), TZ, from))).toBe('2026-09-20 08:00');
  });

  it('rolls to next month when this month’s slot has passed', () => {
    const from = new Date('2026-09-25T18:00:00.000Z');
    expect(local(advanceTriggerTime(monthly(20, 8), TZ, from))).toBe('2026-10-20 08:00');
  });

  it('clamps day 31 to the last day of a 30-day month', () => {
    const from = new Date('2026-04-15T18:00:00.000Z');
    expect(local(advanceTriggerTime(monthly(31, 8), TZ, from))).toBe('2026-04-30 08:00');
  });

  it('clamps to the 28th in a non-leap February and the 29th in a leap one', () => {
    expect(
      local(advanceTriggerTime(monthly(31, 8), TZ, new Date('2026-02-01T18:00:00.000Z'))),
    ).toBe('2026-02-28 08:00');
    expect(
      local(advanceTriggerTime(monthly(31, 8), TZ, new Date('2028-02-01T18:00:00.000Z'))),
    ).toBe('2028-02-29 08:00');
  });

  it('clamps only for the short month — the next month gets the real day back', () => {
    const from = new Date('2026-04-30T14:00:00.000Z'); // just after the clamped April slot
    expect(local(advanceTriggerTime(monthly(31, 8), TZ, from))).toBe('2026-05-31 08:00');
  });

  it('rolls across the year boundary', () => {
    const from = new Date('2026-12-20T18:00:00.000Z');
    expect(local(advanceTriggerTime(monthly(5, 8), TZ, from))).toBe('2027-01-05 08:00');
  });
});

describe('nextTriggerTime', () => {
  it('re-bases on `now` when nothing is stored', () => {
    const now = new Date('2026-09-05T14:17:00.000Z');
    expect(nextTriggerTime({ type: 'hourly' }, TZ, undefined, now).toISOString()).toBe(
      '2026-09-05T15:17:00.000Z',
    );
  });

  it('holds an hourly task’s minute phase even when the dispatch ran late', () => {
    // Seeded at :17; the dispatcher woke at :03 of the following hour.
    const stored = new Date('2026-09-05T14:17:00.000Z');
    const now = new Date('2026-09-05T15:03:00.000Z');
    const next = nextTriggerTime({ type: 'hourly' }, TZ, stored, now);
    // Computing from `now` would have produced :03 and kept drifting.
    expect(next.toISOString()).toBe('2026-09-05T15:17:00.000Z');
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('fires once and re-bases after many slept-through windows, rather than replaying them', () => {
    const stored = new Date('2026-09-01T06:17:00.000Z');
    const now = new Date('2026-09-05T15:03:00.000Z');
    const next = nextTriggerTime({ type: 'hourly' }, TZ, stored, now);
    // The first slot after `now`, not the ~100 slots between — and still
    // on the original :17 phase.
    expect(next.toISOString()).toBe('2026-09-05T15:17:00.000Z');
  });

  it('keeps a daily task on its wall-clock hour after a multi-day outage', () => {
    const stored = new Date('2026-09-01T12:00:00.000Z'); // 06:00 Denver
    const now = new Date('2026-09-05T15:03:00.000Z');
    expect(local(nextTriggerTime(daily(6), TZ, stored, now))).toBe('2026-09-06 06:00');
  });

  it('re-bases on `now` and warns when the stored value is beyond the advance bound', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Hourly, so the bound is ~14 months of slots; two years exceeds it.
      const stored = new Date('2024-09-05T14:17:00.000Z');
      const now = new Date('2026-09-05T15:03:00.000Z');
      const next = nextTriggerTime({ type: 'hourly' }, TZ, stored, now);
      expect(next.toISOString()).toBe('2026-09-05T16:03:00.000Z');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('re-basing on now');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays inside the advance bound for a daily task stored years back', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // MAX_SCHEDULE_ADVANCES daily slots is ~27 years, so two is fine.
      const stored = new Date('2024-09-05T12:00:00.000Z');
      const now = new Date('2026-09-05T15:03:00.000Z');
      expect(local(nextTriggerTime(daily(6), TZ, stored, now))).toBe('2026-09-06 06:00');
      expect(warn).not.toHaveBeenCalled();
      expect(MAX_SCHEDULE_ADVANCES).toBeGreaterThan(1000);
    } finally {
      warn.mockRestore();
    }
  });

  it('re-bases on an unreadable stored value instead of producing an invalid date', () => {
    const now = new Date('2026-09-05T14:17:00.000Z');
    const next = nextTriggerTime({ type: 'hourly' }, TZ, new Date('nonsense'), now);
    expect(next.toISOString()).toBe('2026-09-05T15:17:00.000Z');
  });
});

describe('isTaskDue', () => {
  const task = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
    job: 'demo',
    enabled: true,
    schedule: { type: 'hourly' },
    ...overrides,
  });

  const now = new Date('2026-09-05T15:00:00.000Z');

  /** A structural Firestore `Timestamp` — what the field actually holds. */
  const stamp = (iso: string): TimestampLike => {
    const at = new Date(iso);
    return {
      seconds: Math.floor(at.getTime() / 1000),
      nanoseconds: (at.getTime() % 1000) * 1_000_000,
      toDate: () => at,
      toMillis: () => at.getTime(),
    };
  };

  it('is false for a disabled task even when its slot has passed', () => {
    const t = task({ enabled: false, next_trigger_time: stamp('2026-09-05T14:00:00.000Z') });
    expect(isTaskDue(t, now)).toBe(false);
  });

  it('is true when the slot is in the past', () => {
    expect(isTaskDue(task({ next_trigger_time: stamp('2026-09-05T14:00:00.000Z') }), now)).toBe(
      true,
    );
  });

  it('is true at exactly the slot', () => {
    expect(isTaskDue(task({ next_trigger_time: stamp('2026-09-05T15:00:00.000Z') }), now)).toBe(
      true,
    );
  });

  it('is false when the slot is still ahead', () => {
    expect(isTaskDue(task({ next_trigger_time: stamp('2026-09-05T16:00:00.000Z') }), now)).toBe(
      false,
    );
  });

  it('treats an absent slot as due', () => {
    expect(isTaskDue(task(), now)).toBe(true);
  });
});
