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

import { SYNC_REMINDER_JOB, type ScheduledTask, type StakeSchedule } from '@kindoo/shared';
import { formatDateTime } from '../../../lib/render/formatDate';

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

/**
 * When the dispatcher will next look at this stake's sync reminder, as
 * display text — or `null` when there is nothing honest to say.
 *
 * Three answers, and the ordering matters:
 *   - No row, or the row is off → `null`. A disabled row is never
 *     stamped, so its stored `next_trigger_time` goes stale sitting
 *     there; printing it would name a slot that has already passed.
 *   - On, with a stored slot already past → "within the hour". This is
 *     the normal state immediately after switching on (spec §17,
 *     "Turning a job on"): the stale slot makes the row due at once, so
 *     the next hourly tick runs it rather than the configured hour.
 *   - Otherwise → the stored slot, in the stake's timezone.
 *
 * "Check", not "send": a run that finds nothing expired, or that is
 * inside the three-day backoff, mails nobody.
 */
export function syncReminderNextCheckLabel(
  task: ScheduledTask | null,
  timezone: string,
  now: Date,
): string | null {
  if (!task || task.enabled !== true) return null;
  if (syncReminderDueAtOnce(task, now)) return 'within the hour';
  return syncReminderSlotLabel(task, timezone);
}

/**
 * Whether flipping this row on would make it due at the very next
 * hourly tick — i.e. its stored slot is absent or already past.
 *
 * The distinction matters on rollout and nowhere else, which is exactly
 * when the copy is first read: the dispatcher seeds every existing
 * stake with `next_trigger_time` set to the next local 06:00, so a
 * manager switching the reminder on that afternoon gets the first check
 * tomorrow morning, not within the hour. Only once that seeded slot has
 * passed (or on a row that has been off long enough for its stamp to go
 * stale) is "within the hour" true.
 *
 * `false` for a missing row: there is nothing to turn on.
 */
export function syncReminderDueAtOnce(task: ScheduledTask | null, now: Date): boolean {
  if (!task) return false;
  const next = timestampToDate(task.next_trigger_time);
  if (!next) return true;
  return next.getTime() <= now.getTime();
}

/**
 * The row's stored slot as display text in the stake's timezone,
 * regardless of `enabled` — `null` when there is no row or no stamp.
 *
 * Unlike `syncReminderNextCheckLabel` this makes no claim about
 * staleness; callers pair it with `syncReminderDueAtOnce` and say the
 * right thing for the row's actual state.
 */
export function syncReminderSlotLabel(task: ScheduledTask | null, timezone: string): string | null {
  const next = timestampToDate(task?.next_trigger_time);
  return next ? formatDateTime(next, timezone) : null;
}

/**
 * Firestore `Timestamp` (or an already-`Date` value) to a `Date`.
 * Local because `@kindoo/shared`'s `toDate` is not re-exported from its
 * barrel and this workspace may not widen that barrel.
 */
function timestampToDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as TimestampShape).toDate === 'function'
  ) {
    try {
      const d = (value as TimestampShape).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  return null;
}

interface TimestampShape {
  toDate(): Date;
}
