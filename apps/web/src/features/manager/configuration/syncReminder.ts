// Pure reads over a stake's per-job scheduled-task row.
//
// Separate from `hooks.ts` because that module pulls in the Firestore
// SDK: keeping the derivations here lets the Config tab's rows and
// their component tests share the real implementation rather than a
// stubbed copy of it.
//
// Nothing here writes. The only field the Config tab may change on a
// row is `enabled` (`useSetScheduledJobEnabledMutation` in `hooks.ts`);
// seeding, scheduling and the trigger stamps all belong to the hourly
// dispatcher (D38).
//
// Deliberately small. A row's `next_trigger_time` is not read at all:
// each toggle's tooltip states what its job does, not when it will next
// run, so there is no schedule-formatting here to drift from what the
// dispatcher actually decides.

import type { ScheduledTask, StakeSchedule } from '@kindoo/shared';

/**
 * The stake's row for `job`, or `null` when the dispatcher has not
 * seeded it yet (no doc at all, or a doc whose `tasks` carries no such
 * row).
 *
 * `null` is an expected state rather than an error: a stake created
 * between two hourly dispatches has no schedule document, and a
 * registry job added after that has no row until the next dispatch
 * seeds it.
 */
export function scheduledTask(
  schedule: StakeSchedule | undefined,
  job: string,
): ScheduledTask | null {
  return schedule?.tasks?.find((t) => t.job === job) ?? null;
}
