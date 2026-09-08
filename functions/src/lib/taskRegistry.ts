// The scheduled-job registry: job name → handler + seeding defaults.
//
// This is the whole extension point. Adding a scheduled feature is one
// entry here; the dispatcher seeds it onto every stake, and
// `runScheduledTask` resolves and runs it. There is no second Cloud
// Scheduler job, no second `onTaskDispatched` function, and no deploy
// shape change — deliberately, because Cloud Scheduler's free tier is
// three jobs per billing account and staging + prod spend two of them
// on any single job.
//
// A handler takes `(stakeId, now)` and nothing about scheduling: it is a
// unit of work for one stake at one instant. `SyncReminderService`'s
// `sendSyncReminderIfDue` is the shape to copy.

import { MANUAL_SEAT_REVIEW_JOB, SYNC_REMINDER_JOB, type TaskSchedule } from '@kindoo/shared';
import { sendManualSeatReviewIfDue } from '../services/ManualSeatReviewService.js';
import { sendSyncReminderIfDue } from '../services/SyncReminderService.js';

export type ScheduledJob = {
  /** One stake, one instant. Must be idempotent — see `dispatchScheduledTasks`. */
  handler: (stakeId: string, now: Date) => Promise<unknown>;
  /** Schedule stamped onto a stake the first time the dispatcher sees the job. */
  defaultSchedule: TaskSchedule;
  /**
   * Spread this job's stakes across a window this many seconds wide,
   * by a per-stake deterministic offset (`jitterDelaySeconds`). Absent
   * or 0 ⇒ every stake fires at the slot. Set it on a job that fans out
   * to many recipients per stake; leave it off for one that mails a
   * handful.
   */
  jitterSeconds?: number;
  /**
   * Seeded `enabled` value. **`false` for everything.** A job that
   * appears on a stake by seeding must not start mailing that stake's
   * managers before a human turns it on; the opt-in is the consent.
   */
  defaultEnabled: boolean;
};

export type JobRegistry = Record<string, ScheduledJob>;

/**
 * Every schedulable job, keyed by the name stored in
 * `stakeSchedules/{stakeId}.tasks[].job`.
 *
 * Never reach for this constant directly from dispatch or run code —
 * both take the registry as a parameter so tests can pass a fixture.
 */
export const SCHEDULED_JOBS: JobRegistry = {
  /**
   * The expired-temp-seat reminder (D37, spec §9).
   *
   * `daily` is a CHECK cadence, not a mail cadence. The handler's own
   * `SYNC_REMINDER_BACKOFF_DAYS = 3` decides whether anything is sent,
   * so a stake whose seats stay expired is mailed at most every third
   * day while being looked at every day. Weekly here would instead
   * delay a brand-new expiry by up to a week, which is the case the
   * reminder exists for.
   *
   * 06:00 in the stake's own timezone: in the manager's inbox before
   * the working day, not overnight.
   *
   * Keyed off the shared constant because the manager toggle finds this
   * row by the same string — a literal on each side would drift.
   */
  [SYNC_REMINDER_JOB]: {
    handler: sendSyncReminderIfDue,
    defaultSchedule: { type: 'daily', hour: 6 },
    defaultEnabled: false,
  },

  /**
   * The quarterly manual-seat review (spec §9).
   *
   * **`monthly` is a CHECK cadence, not a mail cadence — there is
   * deliberately no `quarterly` shape.** The handler's own
   * `MANUAL_SEAT_REVIEW_INTERVAL_DAYS = 75` is what decides whether
   * anything sends, exactly as `daily` + a three-day backoff works for
   * the sync reminder above. Adding a fourth schedule shape to express
   * this would put the interval in two places and let them disagree;
   * checking monthly also means a stake whose review slipped (a stake
   * created mid-quarter, a month of failures) catches up at the next
   * month rather than waiting a whole quarter.
   *
   * 02:00 stake-local plus up to 20h of jitter never crosses midnight,
   * so delivery always lands on the same stake-local calendar date the
   * slot fired on — which is what lets the date stamp measure from the
   * slot rather than from wherever jitter happened to land. A wider
   * window would break that; widen the window and you must move the
   * stamp to delivery time.
   *
   * Jittered because one run fans out to one mail per scope — up to
   * ~13 on a large stake — and dozens of stakes firing at the same slot
   * would burst the whole estate's mail into one minute.
   */
  [MANUAL_SEAT_REVIEW_JOB]: {
    handler: sendManualSeatReviewIfDue,
    defaultSchedule: { type: 'monthly', day: 1, hour: 2 },
    jitterSeconds: 72_000,
    defaultEnabled: false,
  },
};
