// Stake-timezone date/time formatters. Render format
// `yyyy-MM-dd h:mm am/pm` with lowercase am/pm and a space between
// time and meridiem (`9:30 am` rather than `9:30am`).
//
// All app-surfaced timestamps render in the stake's timezone (read
// from `stake.timezone`, e.g. `America/Denver`) so the audit log,
// dashboard, and roster cards all agree on local-time semantics.
//
// Fallback when no timezone is supplied (the stake doc snapshot is
// still loading, or the field is missing): `America/Denver`. This
// matches the v1 deploy's stake; multi-stake needs a per-stake
// default seeded by `createStake`. UTC is wrong for our only deployed
// stake — the operator would hit a 6-hour negative offset on every
// audit timestamp before this fallback applies.
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
  // `09`) — the `h:mma` shape we want.
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

/**
 * Absolute instant for the **start of the calendar day** named by
 * `dateStr` (`YYYY-MM-DD`) in the stake's IANA timezone — the wall-clock
 * moment `00:00:00.000` of that day in `tz`.
 *
 * Used to convert an Audit Log "from" filter into a Firestore-queryable
 * `Timestamp` boundary so the inclusive date range matches the
 * stake-timezone display (per spec.md §5.3). Falls back to
 * `America/Denver` when `tz` is undefined — the same default the display
 * formatters use, so behaviour is unchanged for the current Denver stake.
 *
 * A sub-millisecond skew is possible right at a DST transition (the
 * offset is sampled at noon to dodge the ambiguous/absent midnight hour);
 * acceptable at v1 scale.
 */
export function startOfDayInStakeTz(dateStr: string, timezone: string | undefined): Date {
  return dayBoundaryInStakeTz(dateStr, timezone, 0, 0, 0, 0);
}

/**
 * Absolute instant for the **end of the calendar day** named by
 * `dateStr` (`YYYY-MM-DD`) in the stake's IANA timezone — the wall-clock
 * moment `23:59:59.999` of that day in `tz`. Inclusive upper bound for
 * the Audit Log "to" filter. Same `America/Denver` fallback as
 * `startOfDayInStakeTz`.
 */
export function endOfDayInStakeTz(dateStr: string, timezone: string | undefined): Date {
  return dayBoundaryInStakeTz(dateStr, timezone, 23, 59, 59, 999);
}

/**
 * Resolve a wall-clock time (`h:m:s.ms`) on calendar day `dateStr` in
 * timezone `tz` to its absolute UTC instant. We can't build the instant
 * directly from a tz name, so: form the naive UTC instant for that
 * wall-clock time, measure how far `tz` sits from UTC at that day (via
 * `Intl`), and subtract the offset. The offset is sampled at noon of the
 * target day so DST transitions near midnight don't land us in the
 * absent/duplicated hour.
 */
function dayBoundaryInStakeTz(
  dateStr: string,
  timezone: string | undefined,
  hours: number,
  minutes: number,
  seconds: number,
  ms: number,
): Date {
  const tz = timezone || DEFAULT_STAKE_TZ;
  const [yStr, mStr, dStr] = dateStr.split('-');
  const y = Number.parseInt(yStr ?? '', 10);
  const m = Number.parseInt(mStr ?? '', 10);
  const d = Number.parseInt(dStr ?? '', 10);
  // Naive instant: pretend the wall-clock time is UTC.
  const naiveUtc = Date.UTC(y, m - 1, d, hours, minutes, seconds, ms);
  // Offset of `tz` from UTC on this calendar day (sampled at noon UTC to
  // avoid the DST-transition edge). Positive = tz is ahead of UTC.
  const offsetMs = tzOffsetMs(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)), tz);
  return new Date(naiveUtc - offsetMs);
}

/**
 * Signed offset, in milliseconds, of `tz` from UTC at the given instant.
 * Positive when `tz` is east of UTC. Computed by formatting the same
 * instant in `tz` and differencing its wall-clock fields against the
 * instant's true UTC value — the inverse of what the display formatters
 * do.
 */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): number =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  let hour = get('hour');
  // `hour12: false` renders midnight as `24` in some engines; normalise.
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );
  return asUtc - at.getTime();
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
