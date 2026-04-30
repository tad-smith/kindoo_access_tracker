// Stake-timezone date/time formatters. Mirrors Apps Script's
// `Utils_formatDateTime`: `yyyy-MM-dd h:mma` with lowercase am/pm.
// We add a space between time and meridiem for readability
// (`9:30 am` rather than `9:30am`).
//
// All app-surfaced timestamps render in the stake's timezone (read
// from `stake.timezone`, e.g. `America/Denver`) so the audit log,
// dashboard, and roster cards all agree on local-time semantics.
//
// Fallback when no timezone is supplied (the stake doc snapshot is
// still loading, or the field is missing): `America/Denver`. This
// matches the v1 deploy's stake; multi-stake (Phase B) needs a
// per-stake default seeded by `createStake`. UTC is wrong for our
// only deployed stake — the operator hits a 6-hour negative offset on
// every audit timestamp before this fallback applies.
const DEFAULT_STAKE_TZ = 'America/Denver';

/**
 * Format a Date / Firestore Timestamp / ISO string in the stake's
 * timezone. Returns `'YYYY-MM-DD h:mm am/pm'`. Returns the empty
 * string for `null` / `undefined`.
 */
export function formatDateTimeInStakeTz(value: unknown, timezone: string | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  const tz = timezone || DEFAULT_STAKE_TZ;
  // `en-CA` for the date side because it formats `YYYY-MM-DD` natively.
  // `en-US` for the time side because `hour: 'numeric'` gives `9` (not
  // `09`) — the Apps Script equivalent of `h:mma`.
  const datePart = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const hour = timeParts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = timeParts.find((p) => p.type === 'minute')?.value ?? '';
  const dayPeriod = (timeParts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase();
  return `${datePart} ${hour}:${minute} ${dayPeriod}`;
}

/**
 * Format a Date / Firestore Timestamp / ISO string as `YYYY-MM-DD` in
 * the stake's timezone. Used wherever date-only display is wanted
 * (e.g. last-import / last-expiry day).
 */
export function formatDateInStakeTz(value: unknown, timezone: string | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  const tz = timezone || DEFAULT_STAKE_TZ;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const v = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
    if (typeof v.toDate === 'function') {
      try {
        return v.toDate();
      } catch {
        return null;
      }
    }
    if (typeof v.seconds === 'number') {
      return new Date(v.seconds * 1000 + (v.nanoseconds ?? 0) / 1_000_000);
    }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
