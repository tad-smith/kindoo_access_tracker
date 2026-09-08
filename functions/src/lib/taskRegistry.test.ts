// What the registry actually contains. Dispatch and run both take a
// registry as a parameter (and every other test passes a fixture), so
// this file is the only place the real `SCHEDULED_JOBS` is asserted —
// and it is worth asserting, because the seeding defaults are the
// difference between a stake being offered a job and being mailed by
// one.

import { describe, expect, it } from 'vitest';
import { MANUAL_SEAT_REVIEW_JOB, SYNC_REMINDER_JOB } from '@kindoo/shared';
import { sendManualSeatReviewIfDue } from '../services/ManualSeatReviewService.js';
import { sendSyncReminderIfDue } from '../services/SyncReminderService.js';
import { DISPATCH_DEADLINE_SECONDS } from '../scheduled/dispatchScheduledTasks.js';
import { TIMEOUT_SECONDS } from '../tasks/runScheduledTask.js';
import { SCHEDULED_JOBS } from './taskRegistry.js';

describe('SCHEDULED_JOBS', () => {
  it('registers each job against its handler', () => {
    expect(Object.keys(SCHEDULED_JOBS)).toEqual([SYNC_REMINDER_JOB, MANUAL_SEAT_REVIEW_JOB]);
    // Identity, not a wrapper: the dispatcher calls these with
    // `(stakeId, now)` and nothing else.
    expect(SCHEDULED_JOBS[SYNC_REMINDER_JOB]?.handler).toBe(sendSyncReminderIfDue);
    expect(SCHEDULED_JOBS[MANUAL_SEAT_REVIEW_JOB]?.handler).toBe(sendManualSeatReviewIfDue);
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

  it('checks the manual-seat review monthly — there is no quarterly shape', () => {
    // Same rule as above one level up: `monthly` is the check cadence
    // and `MANUAL_SEAT_REVIEW_INTERVAL_DAYS = 75` decides whether
    // anything sends, so the review lands every third month. A
    // `quarterly` schedule shape would put the interval in two places
    // and let them disagree.
    expect(SCHEDULED_JOBS[MANUAL_SEAT_REVIEW_JOB]?.defaultSchedule).toEqual({
      type: 'monthly',
      day: 1,
      hour: 2,
    });
  });

  it('jitters the review inside the stake-local day it fired on', () => {
    // 02:00 plus at most 20h never crosses midnight, so delivery lands
    // on the same stake-local date the slot fired on — which is what
    // lets the handler's date stamp measure from the slot. Widening this
    // breaks that; the window and the hour move together or not at all.
    const jitter = SCHEDULED_JOBS[MANUAL_SEAT_REVIEW_JOB]?.jitterSeconds ?? 0;
    const hour = (SCHEDULED_JOBS[MANUAL_SEAT_REVIEW_JOB]?.defaultSchedule as { hour: number }).hour;
    expect(jitter).toBe(72_000);
    expect(hour * 3600 + jitter).toBeLessThan(24 * 3600);
  });

  it('leaves the sync reminder unjittered', () => {
    // It mails a handful of managers per stake, at a deliberate 06:00.
    expect(SCHEDULED_JOBS[SYNC_REMINDER_JOB]?.jitterSeconds).toBeUndefined();
  });

  it('gives the dispatcher a longer deadline than the runner’s own timeout', () => {
    // Cross-module, like the jitter invariant above: the two constants
    // live in different files and both sides say in comments that the
    // ordering is load-bearing, but nothing enforced it. Invert it and
    // Cloud Tasks cancels a run that is still mailing and retries it —
    // since the date stamp is written last, the retry re-mails every
    // scope that already succeeded.
    expect(DISPATCH_DEADLINE_SECONDS).toBeGreaterThan(TIMEOUT_SECONDS);
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
