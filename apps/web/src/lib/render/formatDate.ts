// Date formatting helpers — TS port of the same-named utilities in the
// Apps Script `ClientUtils.html`/`Format.gs` axis. The contract:
//
//   formatDate(d, tz)      → 'YYYY-MM-DD' (ISO, locale-stable)
//   formatDateTime(d, tz)  → 'YYYY-MM-DD HH:mm' (24-hour, locale-stable)
//
// Both accept `Date | string | number | null | undefined` and return the
// empty string when the input is null/undefined (the spec's "null →
// empty" rendering rule).
//
// Timezone is a required argument because the stake's display tz is
// part of every read (it lives on the parent stake doc). Passing `tz`
// explicitly keeps the helpers pure (no module-level state) and makes
// the test cases independent of the host's local zone.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDate(input: Date | string | number): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'string') {
    // Treat bare ISO dates ('2026-04-15') as that calendar day in the
    // stake tz, not as midnight UTC. The ICU parts pipeline below picks
    // up the tz from `formatToParts`, so we anchor the input to noon UTC
    // of the encoded day to avoid the tz-shift-into-the-previous-day
    // edge case at midnight.
    if (ISO_DATE_RE.test(input)) {
      const d = new Date(`${input}T12:00:00Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function partsByType(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      out[part.type] = part.value;
    }
  }
  return out;
}

/**
 * Format a date as `YYYY-MM-DD` in the given IANA timezone. `null` or
 * `undefined` → empty string.
 *
 * @example
 *   formatDate('2026-04-15', 'America/Denver') === '2026-04-15'
 *   formatDate(null, 'America/Denver') === ''
 */
export function formatDate(
  input: Date | string | number | null | undefined,
  timeZone: string,
): string {
  if (input === null || input === undefined) return '';
  const d = toDate(input);
  if (!d) return '';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = partsByType(fmt.formatToParts(d));
  if (!parts.year || !parts.month || !parts.day) return '';
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Format a date as `YYYY-MM-DD HH:mm` (24-hour) in the given IANA
 * timezone. `null` / `undefined` → empty string.
 */
export function formatDateTime(
  input: Date | string | number | null | undefined,
  timeZone: string,
): string {
  if (input === null || input === undefined) return '';
  const d = toDate(input);
  if (!d) return '';
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = partsByType(fmt.formatToParts(d));
  if (!parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute) {
    return '';
  }
  // Some locales emit '24' for midnight under hour12: false; clamp to 00.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}
