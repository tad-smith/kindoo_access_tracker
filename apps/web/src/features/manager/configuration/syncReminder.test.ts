// Pure reads over a stake's `syncReminder` scheduled-task row.

import { describe, expect, it } from 'vitest';
import type { ScheduledTask, TimestampLike } from '@kindoo/shared';
import { SYNC_REMINDER_JOB, syncReminderNextCheckLabel, syncReminderTask } from './syncReminder';

const actor = { email: 'mgr@example.com', canonical: 'mgr@example.com' };

function ts(iso: string): TimestampLike {
  const d = new Date(iso);
  return {
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    toDate: () => d,
    toMillis: () => d.getTime(),
  };
}

function reminderRow(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    job: SYNC_REMINDER_JOB,
    enabled: false,
    schedule: { type: 'daily', hour: 6 },
    ...overrides,
  };
}

function otherRow(): ScheduledTask {
  return {
    job: 'someOtherJob',
    enabled: true,
    schedule: { type: 'weekly', weekday: 1, hour: 9 },
  };
}

describe('syncReminderTask', () => {
  it('returns null when the stake has no schedule document', () => {
    expect(syncReminderTask(undefined)).toBeNull();
  });

  it('returns null when the dispatcher has seeded other jobs but not this one', () => {
    expect(syncReminderTask({ tasks: [otherRow()], lastActor: actor })).toBeNull();
  });

  it('returns the syncReminder row when the dispatcher has seeded it', () => {
    const row = reminderRow({ enabled: true });
    expect(syncReminderTask({ tasks: [otherRow(), row], lastActor: actor })).toBe(row);
  });
});

describe('syncReminderNextCheckLabel', () => {
  const now = new Date('2026-09-05T18:30:00Z');

  it('says nothing when the row has not been seeded', () => {
    expect(syncReminderNextCheckLabel(null, 'America/Denver', now)).toBeNull();
  });

  it('says nothing while the reminder is off, because the stored slot has gone stale', () => {
    // A disabled row is never stamped, so its `next_trigger_time` is
    // whatever the seeder wrote — printing it would name a slot that
    // has already passed.
    const row = reminderRow({ enabled: false, next_trigger_time: ts('2026-01-01T13:00:00Z') });
    expect(syncReminderNextCheckLabel(row, 'America/Denver', now)).toBeNull();
  });

  it('reports the next hourly tick when the stored slot has already passed', () => {
    // The ordinary state immediately after switching on: the stale slot
    // makes the row due at once (spec §17, "Turning a job on").
    const row = reminderRow({ enabled: true, next_trigger_time: ts('2026-09-05T12:00:00Z') });
    expect(syncReminderNextCheckLabel(row, 'America/Denver', now)).toBe('within the hour');
  });

  it('reports the next hourly tick when the row carries no stored slot at all', () => {
    const row = reminderRow({ enabled: true });
    expect(syncReminderNextCheckLabel(row, 'America/Denver', now)).toBe('within the hour');
  });

  it('reports the stored slot in the stake timezone once it is in the future', () => {
    const row = reminderRow({ enabled: true, next_trigger_time: ts('2026-09-06T12:00:00Z') });
    expect(syncReminderNextCheckLabel(row, 'America/Denver', now)).toBe('2026-09-06 06:00');
  });

  it('reports the same instant differently for a stake in another timezone', () => {
    const row = reminderRow({ enabled: true, next_trigger_time: ts('2026-09-06T12:00:00Z') });
    expect(syncReminderNextCheckLabel(row, 'Pacific/Honolulu', now)).toBe('2026-09-06 02:00');
  });

  it('falls back to the next hourly tick when the stored slot is unreadable', () => {
    // The array is manager-writable and rules cannot validate inside its
    // elements, so a hand-edited value reaches here.
    const row = reminderRow({
      enabled: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      next_trigger_time: 'tomorrow' as any,
    });
    expect(syncReminderNextCheckLabel(row, 'America/Denver', now)).toBe('within the hour');
  });
});
