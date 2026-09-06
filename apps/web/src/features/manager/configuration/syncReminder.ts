// Pure reads over a stake's `syncReminder` scheduled-task row.
//
// Separate from `hooks.ts` because that module pulls in the Firestore
// SDK: keeping the derivations here lets the Config tab's card and its
// component tests share the real implementations rather than a stubbed
// copy of them.
//
// Nothing here writes. The only field this feature may change is
// `enabled` (`useSetSyncReminderEnabledMutation`); seeding, scheduling
// and the trigger stamps all belong to the hourly dispatcher (D38).
//
// Deliberately small. The row's `next_trigger_time` is not read at all:
// the toggle's tooltip states what the reminder does, not when it will
// next run, so there is no schedule-formatting here to drift from what
// the dispatcher actually decides.

import { SYNC_REMINDER_JOB, type ScheduledTask, type StakeSchedule } from '@kindoo/shared';

/**
 * Registry key of the expired-temp-seat reminder. Defined once in
 * `@kindoo/shared` and re-exported here so this module stays the web
 * half's single entry point for the feature. The key is the join
 * between `functions/src/lib/taskRegistry.ts` and this toggle; a second
 * copy would let a rename on one side leave the other reading a row
 * that is not there, and the symptom — a toggle stuck on "not seeded
 * yet" — names neither side.
 */
export { SYNC_REMINDER_JOB };

/**
 * The stake's `syncReminder` row, or `null` when the dispatcher has not
 * seeded it yet (no doc at all, or a doc whose `tasks` carries no such
 * row).
 *
 * `null` is an expected state rather than an error: a stake created
 * between two hourly dispatches has no schedule document.
 */
export function syncReminderTask(schedule: StakeSchedule | undefined): ScheduledTask | null {
  return schedule?.tasks?.find((t) => t.job === SYNC_REMINDER_JOB) ?? null;
}
