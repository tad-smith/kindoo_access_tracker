// What the registry actually contains. Dispatch and run both take a
// registry as a parameter (and every other test passes a fixture), so
// this file is the only place the real `SCHEDULED_JOBS` is asserted —
// and it is worth asserting, because the seeding defaults are the
// difference between a stake being offered a job and being mailed by
// one.

import { describe, expect, it } from 'vitest';
import { SYNC_REMINDER_JOB } from '@kindoo/shared';
import { sendSyncReminderIfDue } from '../services/SyncReminderService.js';
import { SCHEDULED_JOBS } from './taskRegistry.js';

describe('SCHEDULED_JOBS', () => {
  it('registers the sync reminder against its handler', () => {
    expect(Object.keys(SCHEDULED_JOBS)).toEqual([SYNC_REMINDER_JOB]);
    // Identity, not a wrapper: the dispatcher calls this with
    // `(stakeId, now)` and nothing else.
    expect(SCHEDULED_JOBS[SYNC_REMINDER_JOB]?.handler).toBe(sendSyncReminderIfDue);
  });

  it('checks daily at 06:00 in the stake’s own timezone', () => {
    // Daily is a CHECK cadence. `SYNC_REMINDER_BACKOFF_DAYS = 3` inside
    // the handler decides whether anything is sent, so this is "look
    // every day", not "mail every day". Weekly here would instead delay
    // a brand-new expiry by up to a week.
    expect(SCHEDULED_JOBS[SYNC_REMINDER_JOB]?.defaultSchedule).toEqual({
      type: 'daily',
      hour: 6,
    });
  });

  it('seeds every job disabled', () => {
    // Non-negotiable: the dispatcher seeds a row onto every stake by
    // itself, and a seeded job must not start mailing a stake's
    // managers before a human opts in. Assert it across the whole
    // registry, not just this entry, so a future job cannot slip in
    // enabled.
    for (const [job, definition] of Object.entries(SCHEDULED_JOBS)) {
      expect(definition.defaultEnabled, `${job} must seed disabled`).toBe(false);
    }
  });
});
