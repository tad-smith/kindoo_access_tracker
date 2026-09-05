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

import type { TaskSchedule } from '@kindoo/shared';

export type ScheduledJob = {
  /** One stake, one instant. Must be idempotent — see `dispatchScheduledTasks`. */
  handler: (stakeId: string, now: Date) => Promise<unknown>;
  /** Schedule stamped onto a stake the first time the dispatcher sees the job. */
  defaultSchedule: TaskSchedule;
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
 * Empty: the dispatcher ships before its first consumer.
 * `sendSyncReminderIfDue` (`services/SyncReminderService.ts`) is
 * registered as `syncReminder` in the follow-up that wires it up.
 *
 * Never reach for this constant directly from dispatch or run code —
 * both take the registry as a parameter so tests can pass a fixture.
 */
export const SCHEDULED_JOBS: JobRegistry = {};
