// Pure unit tests for the shared queue section-partition logic. Exercises
// the comparison-date math + sort order + bucket boundaries directly,
// across both timestamp shapes the two consumers feed in:
//   - a live Firestore `Timestamp` (methods intact) — the web app.
//   - the serialised `{ seconds }` / `{ _seconds }` wire shape that
//     survives the `getMyPendingRequests` callable boundary — the
//     extension.

import { describe, expect, it } from 'vitest';
import type { AccessRequest, TimestampLike } from './types/index.js';
import {
  comparisonDateMs,
  outstandingCutoffMs,
  partitionPendingRequests,
} from './queueSections.js';

/** Live Firestore `Timestamp`-like value with the methods intact (web shape). */
function ts(iso: string): TimestampLike {
  const d = new Date(iso);
  const ms = d.getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: 0,
    toDate: () => d,
    toMillis: () => ms,
  };
}

/**
 * The plain `{ seconds, nanoseconds }` wire shape that survives the
 * callable serialisation (methods stripped) — what the extension feeds
 * in. Typed through `unknown` because `AccessRequest.requested_at` is
 * `TimestampLike` (methods present) but the runtime value is the bare
 * serialised object.
 */
function wireTs(iso: string): AccessRequest['requested_at'] {
  const ms = new Date(iso).getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: 0,
  } as unknown as AccessRequest['requested_at'];
}

function makeRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'req-1',
    type: 'add_manual',
    scope: 'CO',
    member_email: 'bob@example.com',
    member_canonical: 'bob@example.com',
    member_name: 'Bob Example',
    reason: 'Sub Sunday teacher',
    comment: '',
    building_names: [],
    status: 'pending',
    requester_email: 'bishop@example.com',
    requester_canonical: 'bishop@example.com',
    requested_at: ts('2026-04-28T12:00:00Z'),
    lastActor: { email: 'bishop@example.com', canonical: 'bishop@example.com' },
    ...overrides,
  } satisfies AccessRequest;
}

describe('comparisonDateMs', () => {
  it('uses start_date for add_temp when present and ISO', () => {
    const req = makeRequest({
      type: 'add_temp',
      start_date: '2026-06-01',
      end_date: '2026-06-08',
      requested_at: ts('2026-04-01T00:00:00Z'),
    });
    const expected = new Date(2026, 5, 1).getTime();
    expect(comparisonDateMs(req)).toBe(expected);
  });

  it('falls back to requested_at when add_temp start_date is missing', () => {
    const req = makeRequest({
      type: 'add_temp',
      requested_at: ts('2026-04-01T12:00:00Z'),
    });
    expect(comparisonDateMs(req)).toBe(new Date('2026-04-01T12:00:00Z').getTime());
  });

  it('uses requested_at for add_manual', () => {
    const req = makeRequest({
      type: 'add_manual',
      requested_at: ts('2026-04-15T08:00:00Z'),
    });
    expect(comparisonDateMs(req)).toBe(new Date('2026-04-15T08:00:00Z').getTime());
  });

  it('uses requested_at for remove', () => {
    const req = makeRequest({
      type: 'remove',
      requested_at: ts('2026-03-30T08:00:00Z'),
    });
    expect(comparisonDateMs(req)).toBe(new Date('2026-03-30T08:00:00Z').getTime());
  });

  it('reads the serialised { seconds } wire shape (callable boundary) when the Timestamp methods are stripped', () => {
    const req = makeRequest({
      type: 'add_manual',
      requested_at: wireTs('2026-04-15T08:00:00Z'),
    });
    expect(comparisonDateMs(req)).toBe(new Date('2026-04-15T08:00:00Z').getTime());
  });

  it('reads the { _seconds } wire shape too', () => {
    const ms = new Date('2026-04-10T00:00:00Z').getTime();
    const req = makeRequest({
      type: 'add_manual',
      requested_at: { _seconds: Math.floor(ms / 1000) } as unknown as AccessRequest['requested_at'],
    });
    expect(comparisonDateMs(req)).toBe(ms);
  });

  it('falls back to 0 on an uncoercible requested_at shape', () => {
    const req = makeRequest({
      type: 'add_manual',
      requested_at: {} as unknown as AccessRequest['requested_at'],
    });
    expect(comparisonDateMs(req)).toBe(0);
  });
});

describe('outstandingCutoffMs', () => {
  it('returns local-midnight + 7 days', () => {
    const now = new Date(2026, 3, 28, 14, 30, 12);
    const expected = new Date(2026, 3, 28).getTime() + 7 * 24 * 60 * 60 * 1000;
    expect(outstandingCutoffMs(now)).toBe(expected);
  });
});

describe('partitionPendingRequests', () => {
  const NOW = new Date(2026, 3, 28, 12, 0, 0); // 2026-04-28 noon local

  it('puts urgent requests in the urgent bucket regardless of date', () => {
    const urgentFar = makeRequest({
      request_id: 'urg-far',
      urgent: true,
      type: 'add_temp',
      start_date: '2027-01-01',
      end_date: '2027-01-08',
    });
    const urgentNear = makeRequest({
      request_id: 'urg-near',
      urgent: true,
      requested_at: ts('2026-04-25T08:00:00Z'),
    });
    const result = partitionPendingRequests([urgentFar, urgentNear], NOW);
    expect(result.urgent).toHaveLength(2);
    expect(result.outstanding).toHaveLength(0);
    expect(result.future).toHaveLength(0);
  });

  it('separates outstanding (≤ today+7) from future (> today+7)', () => {
    const within = makeRequest({
      request_id: 'within',
      type: 'add_temp',
      start_date: '2026-05-04', // 6 days from 2026-04-28 → outstanding
      end_date: '2026-05-04',
    });
    const past = makeRequest({
      request_id: 'past',
      requested_at: ts('2026-04-20T08:00:00Z'), // older add_manual → outstanding
    });
    const beyond = makeRequest({
      request_id: 'beyond',
      type: 'add_temp',
      start_date: '2026-05-15', // > today+7 → future
      end_date: '2026-05-22',
    });
    const result = partitionPendingRequests([within, past, beyond], NOW);
    expect(result.urgent).toHaveLength(0);
    expect(result.outstanding.map((r) => r.request_id).sort()).toEqual(['past', 'within']);
    expect(result.future.map((r) => r.request_id)).toEqual(['beyond']);
  });

  it('sorts each section by comparisonDate ascending (oldest first)', () => {
    const a = makeRequest({
      request_id: 'a',
      requested_at: ts('2026-04-26T08:00:00Z'),
    });
    const b = makeRequest({
      request_id: 'b',
      requested_at: ts('2026-04-20T08:00:00Z'),
    });
    const c = makeRequest({
      request_id: 'c',
      requested_at: ts('2026-04-25T08:00:00Z'),
    });
    const result = partitionPendingRequests([a, b, c], NOW);
    expect(result.outstanding.map((r) => r.request_id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by comparisonDate across mixed wire + Timestamp shapes', () => {
    // The extension may receive a heterogeneous list if some rows carry
    // a serialised wire shape; ordering must still hold.
    const a = makeRequest({ request_id: 'a', requested_at: wireTs('2026-04-26T08:00:00Z') });
    const b = makeRequest({ request_id: 'b', requested_at: ts('2026-04-20T08:00:00Z') });
    const c = makeRequest({ request_id: 'c', requested_at: wireTs('2026-04-25T08:00:00Z') });
    const result = partitionPendingRequests([a, b, c], NOW);
    expect(result.outstanding.map((r) => r.request_id)).toEqual(['b', 'c', 'a']);
  });

  it('treats missing urgent as non-urgent', () => {
    // Fixture omits the field — `urgent` is optional on the wire.
    const ambiguous = makeRequest({ request_id: 'amb' });
    const result = partitionPendingRequests([ambiguous], NOW);
    expect(result.urgent).toHaveLength(0);
    expect(result.outstanding).toHaveLength(1);
  });

  it('boundary: comparison_date exactly today+7 lands in outstanding', () => {
    const cutoffMs = outstandingCutoffMs(NOW);
    const cutoffIso = (() => {
      const d = new Date(cutoffMs);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    })();
    const onBoundary = makeRequest({
      request_id: 'boundary',
      type: 'add_temp',
      start_date: cutoffIso,
      end_date: cutoffIso,
    });
    const result = partitionPendingRequests([onBoundary], NOW);
    expect(result.outstanding).toHaveLength(1);
    expect(result.future).toHaveLength(0);
  });
});
