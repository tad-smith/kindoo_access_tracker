// Scheduled-dispatch helpers. The hourly Cloud Scheduler fires a single
// `runImporter` / `runExpiry` Cloud Function; that function loops over
// stakes and runs only those whose schedule matches the current time
// (in the stake's tz). Pure helpers — caller passes `now` so tests can
// pin a deterministic clock.

import type { ImportDay, Stake } from '@kindoo/shared';

const DAY_MAP: ImportDay[] = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

/** Format `now` in the stake's timezone, returning `{dayOfWeek, hour}` (0-23). */
export function localTimeFor(now: Date, timezone: string): { day: ImportDay; hour: number } {
  // Intl.DateTimeFormat is the cross-platform way to get a TZ-resolved
  // hour + weekday without pulling in a date library. The `weekday`
  // option returns a long English string ('Monday'); `hour` returns 0-23.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    hour: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekdayPart = parts.find((p) => p.type === 'weekday')?.value ?? 'Sunday';
  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // Intl returns '24' for midnight in some locales/locales-extension
  // implementations when `hour12: false`; normalise to 0.
  const hour = Number(hourPart) % 24;
  const day = weekdayPart.toUpperCase() as ImportDay;
  // Map back through DAY_MAP to ensure it's one of the canonical values.
  const dayValid = DAY_MAP.find((d) => d === day) ?? 'SUNDAY';
  return { day: dayValid, hour };
}

/** Returns true if the stake's importer should run at `now`. */
export function shouldRunImporter(stake: Stake, now: Date): boolean {
  if (!stake.setup_complete) return false;
  const { day, hour } = localTimeFor(now, stake.timezone);
  return stake.import_day === day && stake.import_hour === hour;
}

/** Returns true if the stake's expiry should run at `now`. */
export function shouldRunExpiry(stake: Stake, now: Date): boolean {
  if (!stake.setup_complete) return false;
  const { hour } = localTimeFor(now, stake.timezone);
  return stake.expiry_hour === hour;
}
