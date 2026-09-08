// Pure reads over a stake's per-job scheduled-task row.

import { describe, expect, it } from 'vitest';
import { MANUAL_SEAT_REVIEW_JOB, SYNC_REMINDER_JOB, type ScheduledTask } from '@kindoo/shared';
import { scheduledTask } from './syncReminder';

const actor = { email: 'mgr@example.com', canonical: 'mgr@example.com' };

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

describe('scheduledTask', () => {
  it('returns null when the stake has no schedule document', () => {
    expect(scheduledTask(undefined, SYNC_REMINDER_JOB)).toBeNull();
  });

  it('returns null when the dispatcher has seeded other jobs but not this one', () => {
    expect(scheduledTask({ tasks: [otherRow()], lastActor: actor }, SYNC_REMINDER_JOB)).toBeNull();
  });

  it('returns the requested job’s row when the dispatcher has seeded it', () => {
    const row = reminderRow({ enabled: true });
    expect(scheduledTask({ tasks: [otherRow(), row], lastActor: actor }, SYNC_REMINDER_JOB)).toBe(
      row,
    );
  });

  it('distinguishes two different jobs sharing the same tasks array', () => {
    const reminder = reminderRow({ enabled: true });
    const review: ScheduledTask = {
      job: MANUAL_SEAT_REVIEW_JOB,
      enabled: false,
      schedule: { type: 'monthly', day: 1, hour: 6 },
    };
    const schedule = { tasks: [reminder, review], lastActor: actor };
    expect(scheduledTask(schedule, SYNC_REMINDER_JOB)).toBe(reminder);
    expect(scheduledTask(schedule, MANUAL_SEAT_REVIEW_JOB)).toBe(review);
  });
});
