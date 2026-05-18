// Scheduled-dispatch helpers. The hourly Cloud Scheduler fires a single
// `runExpiry` Cloud Function; that function loops over stakes and runs
// only those whose schedule matches the current time (in the stake's
// tz). Pure helpers — caller passes `now` so tests can pin a
// deterministic clock.

import type { Stake } from '@kindoo/shared';

/** Format `now` in the stake's timezone, returning the local hour (0-23). */
export function localHourFor(now: Date, timezone: string): number {
  // Intl.DateTimeFormat is the cross-platform way to get a TZ-resolved
  // hour without pulling in a date library. `hour: 'numeric'` with
  // `hour12: false` returns 0-23.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // Intl returns '24' for midnight in some locale-extension
  // implementations when `hour12: false`; normalise to 0.
  return Number(hourPart) % 24;
}

/** Returns true if the stake's expiry should run at `now`. */
export function shouldRunExpiry(stake: Stake, now: Date): boolean {
  if (!stake.setup_complete) return false;
  return stake.expiry_hour === localHourFor(now, stake.timezone);
}
