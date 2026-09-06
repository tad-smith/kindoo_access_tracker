// Pure reads over a stake's `syncReminder` scheduled-task row.

import { describe, expect, it } from 'vitest';
import type { ScheduledTask } from '@kindoo/shared';
import { SYNC_REMINDER_JOB, syncReminderTask } from './syncReminder';

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
