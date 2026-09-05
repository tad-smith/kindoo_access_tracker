// Per-stake scheduled tasks — the shapes and the calendar maths.
//
// One hourly dispatcher walks every stake, fires the tasks that are due,
// and precomputes when each should next fire. Everything in this file is
// the "when" half: pure, timezone-aware, and shared so the dispatcher,
// its tests, and any future manager-facing schedule editor all agree on
// what a schedule means.
//
// `Intl` only, so `@kindoo/shared` stays runtime-dep-free.
//
// **Schedules are a closed set of shapes, not cron strings.** The
// dispatcher only wakes hourly, so a cron string's minute field would be
// inert and `*/15 * * * *` would silently mean "hourly". A shape cannot
// lie about what it does.

import type { ActorRef } from './types/actor.js';
import type { TimestampLike } from './types/userIndex.js';
import {
  addIsoDays,
  formatDateInStakeTz,
  isoDateWeekday,
  toDate,
  wallClockInStakeTz,
} from './stakeTime.js';

/**
 * When a task wants to run. The `hour` / `weekday` / `day` fields are
 * read in the **stake's** timezone, which is the only reason this needs
 * a timezone at all.
 *
 * `hourly` carries no fields: its phase within the hour comes from the
 * stored `next_trigger_time`, not from the shape (see
 * `nextTriggerTime`).
 */
export type TaskSchedule =
  | { type: 'hourly' }
  | { type: 'daily'; hour: number }
  | { type: 'weekly'; weekday: number; hour: number }
  | { type: 'monthly'; day: number; hour: number };

/** One row in a stake's schedule array. */
export type ScheduledTask = {
  /** Registry key of the job to enqueue. An entry naming an unknown job is inert. */
  job: string;
  /**
   * The opt-in flag. Seeded `false` for every job — a newly seeded task
   * must never start acting on a stake's behalf before someone turns it
   * on.
   */
  enabled: boolean;
  schedule: TaskSchedule;
  /** Last dispatch. Bookkeeping only; nothing reads it to decide anything. */
  last_trigger_time?: TimestampLike;
  /**
   * Absolute instant of the next dispatch, precomputed when the task
   * last fired. This is what makes "is anything due" one comparison
   * against `now` with no timezone maths at dispatch time.
   */
  next_trigger_time?: TimestampLike;
};

/** `stakeSchedules/{stakeId}` document body. */
export type StakeSchedule = {
  tasks: ScheduledTask[];
  lastActor: ActorRef;
};

/**
 * Ceiling on how many slots `nextTriggerTime` will walk before giving up
 * and re-basing on `now`. Reached only by a stored value far in the past
 * — roughly 14 months for `hourly`, decades for the rest — which means
 * either a long outage or a hand-typed value, and neither is worth
 * spinning a Cloud Function over.
 */
export const MAX_SCHEDULE_ADVANCES = 10_000;

const MS_PER_HOUR = 3_600_000;

/**
 * The first slot of `schedule` strictly after `from`, in `timezone`.
 *
 * Strictness is what makes the `nextTriggerTime` loop terminate: every
 * call moves forward by at least one slot.
 */
export function advanceTriggerTime(
  schedule: TaskSchedule,
  timezone: string | undefined,
  from: Date,
): Date {
  switch (schedule.type) {
    case 'hourly':
      // The next exact top of the hour, not one hour on from whatever
      // minute `from` sits at. Snapping is load-bearing: a seeded
      // slot is derived from the dispatcher's own start instant, which
      // sits a few cold-start seconds past `:00` and varies run to
      // run. Carrying that phase forward would strand the task
      // whenever a later run started marginally earlier in the hour
      // than the stored second — not yet due, so it waits a further
      // hour, and the phase survives to do the same again. The other
      // three shapes already land on wall-clock hours, which is why
      // only this one could drift. Anchoring to UTC hour boundaries
      // matches the dispatcher's own `0 * * * *` wake-up, and flooring
      // in absolute milliseconds keeps DST out of a question that has
      // no wall clock in it.
      return new Date(Math.floor(from.getTime() / MS_PER_HOUR) * MS_PER_HOUR + MS_PER_HOUR);

    case 'daily': {
      const hour = clamp(schedule.hour, 0, 23);
      const today = formatDateInStakeTz(from, timezone);
      const candidate = wallClockInStakeTz(today, timezone, hour);
      if (candidate.getTime() > from.getTime()) return candidate;
      return wallClockInStakeTz(addIsoDays(today, 1), timezone, hour);
    }

    case 'weekly': {
      const hour = clamp(schedule.hour, 0, 23);
      const weekday = clamp(schedule.weekday, 0, 6);
      const today = formatDateInStakeTz(from, timezone);
      const delta = (weekday - isoDateWeekday(today) + 7) % 7;
      const candidate = wallClockInStakeTz(addIsoDays(today, delta), timezone, hour);
      if (candidate.getTime() > from.getTime()) return candidate;
      return wallClockInStakeTz(addIsoDays(today, delta + 7), timezone, hour);
    }

    case 'monthly': {
      const hour = clamp(schedule.hour, 0, 23);
      const day = clamp(schedule.day, 1, 31);
      const today = formatDateInStakeTz(from, timezone);
      const year = Number.parseInt(today.slice(0, 4), 10);
      const month = Number.parseInt(today.slice(5, 7), 10);
      const candidate = monthlyCandidate(year, month, day, hour, timezone);
      if (candidate.getTime() > from.getTime()) return candidate;
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      return monthlyCandidate(nextYear, nextMonth, day, hour, timezone);
    }
  }
}

/**
 * The instant a task should next fire.
 *
 * **Advance from `stored`, never from `now`.** Phase stability is the
 * whole point: an `hourly` task seeded at :17 stays at :17 forever,
 * where re-basing on `now` walks it forward by however late each
 * dispatch happened to run. A `daily 06:00` task is less obviously
 * fragile but has the same property.
 *
 * A task that slept through many windows (queue paused, job disabled and
 * re-enabled, a long outage) still fires **once** and re-bases rather
 * than replaying every window — the loop stops at the first slot in the
 * future.
 *
 * `stored` absent or unreadable re-bases on `now`, as does a stored
 * value so old that walking to it would exceed `MAX_SCHEDULE_ADVANCES`.
 */
export function nextTriggerTime(
  schedule: TaskSchedule,
  timezone: string | undefined,
  stored: Date | undefined,
  now: Date,
): Date {
  if (!stored || !Number.isFinite(stored.getTime())) {
    return advanceTriggerTime(schedule, timezone, now);
  }
  let next = stored;
  for (let i = 0; i < MAX_SCHEDULE_ADVANCES; i += 1) {
    next = advanceTriggerTime(schedule, timezone, next);
    if (next.getTime() > now.getTime()) return next;
  }
  // `console` rather than a logger: this package is consumed by the SPA,
  // the extension and Cloud Functions, and Cloud Logging captures
  // `console.warn` from the last of those.
  console.warn('scheduledTasks: stored next_trigger_time too far in the past; re-basing on now', {
    schedule,
    stored: stored.toISOString(),
    now: now.toISOString(),
  });
  return advanceTriggerTime(schedule, timezone, now);
}

/**
 * Is this task due at `now`?
 *
 * A missing `next_trigger_time` reads as due. The seeder always stamps
 * one, so the normal path never takes that branch; it exists so a
 * hand-created entry fires and re-bases instead of sitting inert.
 */
export function isTaskDue(task: ScheduledTask, now: Date): boolean {
  if (task.enabled !== true) return false;
  const next = toDate(task.next_trigger_time);
  if (!next || !Number.isFinite(next.getTime())) return true;
  return next.getTime() <= now.getTime();
}

/**
 * A monthly slot, with the day clamped to the month's length: day 31 in
 * a 30-day month is the 30th, and in February the 28th or 29th. Clamping
 * rather than skipping — a monthly task must fire every month.
 */
function monthlyCandidate(
  year: number,
  month: number,
  day: number,
  hour: number,
  timezone: string | undefined,
): Date {
  const clampedDay = Math.min(day, daysInMonth(year, month));
  const dateStr = `${pad(year, 4)}-${pad(month, 2)}-${pad(clampedDay, 2)}`;
  return wallClockInStakeTz(dateStr, timezone, hour);
}

/** Days in `month` (1-based) of `year`. Day 0 of the next month is the last of this one. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Guard against a hand-typed out-of-range field producing nonsense slots. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
