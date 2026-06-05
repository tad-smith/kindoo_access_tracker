// Pure section logic for the extension's pending-request queue. Splits
// a pending-requests snapshot into three ordered buckets:
//
//   1. Urgent      — `urgent === true`, sorted by comparison_date asc.
//   2. Outstanding — non-urgent AND comparison_date <= today+7.
//   3. Future      — non-urgent AND comparison_date > today+7.
//
// `comparison_date` rule:
//   - `add_temp` → `start_date` if present + ISO; else `requested_at`.
//   - everything else → `requested_at`.
//
// This is a deliberate COPY of `apps/web/src/features/manager/queue/
// sections.ts` (not a shared import). The web app's queue is being
// removed next, so extracting to `@kindoo/shared` would be throwaway.
//
// One divergence from the web copy: `requestedAtMs` here also reads the
// `{ seconds, nanoseconds }` / `{ _seconds }` wire shape. The extension
// gets its requests through the `getMyPendingRequests` callable, whose
// `httpsCallable` serialisation strips the `Timestamp` methods and
// leaves the plain numeric shape — the same shape `RequestCard`'s
// `formatTimestamp` already handles. The web copy reads live Firestore
// `Timestamp` objects (methods intact) so it only needs the method path.
//
// Pure (no React, no Firestore) so the logic is unit-testable.

import type { AccessRequest } from '@kindoo/shared';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read the wire-form `requested_at` into millis-since-epoch. Handles a
 * real `Timestamp` (`toMillis` / `toDate`) AND the serialised
 * `{ seconds, nanoseconds }` / `{ _seconds }` shape that survives the
 * callable boundary. Falls back to 0 when the shape can't be coerced —
 * that lands the row in the earliest-first slot, the correct posture
 * for a malformed timestamp on the backlog.
 */
function requestedAtMs(req: AccessRequest): number {
  const raw = req.requested_at as unknown;
  if (raw && typeof raw === 'object') {
    const obj = raw as {
      toMillis?: () => number;
      toDate?: () => Date;
      seconds?: number;
      _seconds?: number;
    };
    if (typeof obj.toMillis === 'function') return obj.toMillis();
    if (typeof obj.toDate === 'function') return obj.toDate().getTime();
    const seconds = typeof obj.seconds === 'number' ? obj.seconds : obj._seconds;
    if (typeof seconds === 'number') return seconds * 1000;
  }
  return 0;
}

/**
 * Convert an ISO date string (`YYYY-MM-DD`) at the user's local
 * midnight to millis. Returns `null` if the string isn't ISO.
 */
function isoDateAtLocalMidnightMs(iso: string): number | null {
  if (!ISO_DATE.test(iso)) return null;
  const parts = iso.split('-').map((s) => Number.parseInt(s, 10));
  const year = parts[0];
  const monthIdx = parts[1];
  const day = parts[2];
  if (year === undefined || monthIdx === undefined || day === undefined) return null;
  // Local midnight — `new Date(year, monthIdx-1, day)` treats values
  // as the runtime's local zone, which is what the spec asks for.
  return new Date(year, monthIdx - 1, day).getTime();
}

/** The ms timestamp the section sort uses for `request`. */
export function comparisonDateMs(req: AccessRequest): number {
  if (req.type === 'add_temp' && req.start_date) {
    const ms = isoDateAtLocalMidnightMs(req.start_date);
    if (ms !== null) return ms;
  }
  return requestedAtMs(req);
}

/**
 * Return the `today + 7 days` boundary at user-local midnight, in ms.
 * Caller passes `now` (Date) so tests can pin time without monkey-
 * patching.
 */
export function outstandingCutoffMs(now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // 7 days = 7 * 24 hours; cross-DST windows exist but a one-hour
  // drift around a multi-day cutoff is not meaningful for sectioning.
  return midnight.getTime() + 7 * 24 * 60 * 60 * 1000;
}

export interface QueueSections {
  urgent: readonly AccessRequest[];
  outstanding: readonly AccessRequest[];
  future: readonly AccessRequest[];
}

/**
 * Bucket pending requests into the three sections. Each bucket is
 * sorted by `comparisonDateMs` ascending (oldest comparison-date
 * first). Caller supplies `now` so the boundary is deterministic in
 * tests.
 */
export function partitionPendingRequests(
  pending: readonly AccessRequest[],
  now: Date,
): QueueSections {
  const cutoff = outstandingCutoffMs(now);
  const urgent: AccessRequest[] = [];
  const outstanding: AccessRequest[] = [];
  const future: AccessRequest[] = [];
  for (const req of pending) {
    if (req.urgent === true) {
      urgent.push(req);
    } else if (comparisonDateMs(req) <= cutoff) {
      outstanding.push(req);
    } else {
      future.push(req);
    }
  }
  const byComparisonAsc = (a: AccessRequest, b: AccessRequest) =>
    comparisonDateMs(a) - comparisonDateMs(b);
  urgent.sort(byComparisonAsc);
  outstanding.sort(byComparisonAsc);
  future.sort(byComparisonAsc);
  return { urgent, outstanding, future };
}
