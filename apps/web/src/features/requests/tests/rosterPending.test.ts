// Unit tests for the pure roster-pending partitioner.

import { describe, expect, it } from 'vitest';
import { makeRequest } from '../../../../test/fixtures';
import { partitionPendingForRoster } from '../rosterPending';

describe('partitionPendingForRoster', () => {
  it('returns empty partition for an empty request stream', () => {
    const result = partitionPendingForRoster([], 'CO');
    expect(result.pendingAdds).toEqual([]);
    expect(result.pendingRemovesByCanonical.size).toBe(0);
  });

  it('separates pending adds from pending removes for the requested scope', () => {
    const add = makeRequest({
      request_id: 'r1',
      type: 'add_manual',
      scope: 'CO',
      member_canonical: 'a@x.com',
    });
    const remove = makeRequest({
      request_id: 'r2',
      type: 'remove',
      scope: 'CO',
      member_canonical: 'b@x.com',
    });
    const result = partitionPendingForRoster([add, remove], 'CO');
    expect(result.pendingAdds).toEqual([add]);
    expect(result.pendingRemovesByCanonical.get('b@x.com')).toEqual(remove);
  });

  it('keys the remove map by member_canonical for O(1) row lookup', () => {
    const remove = makeRequest({
      request_id: 'r1',
      type: 'remove',
      scope: 'CO',
      member_canonical: 'someone@example.com',
    });
    const { pendingRemovesByCanonical } = partitionPendingForRoster([remove], 'CO');
    expect(pendingRemovesByCanonical.has('someone@example.com')).toBe(true);
    expect(pendingRemovesByCanonical.has('nobody@example.com')).toBe(false);
  });

  it('drops requests for other scopes', () => {
    const otherScope = makeRequest({
      request_id: 'r1',
      type: 'add_manual',
      scope: 'GE',
      member_canonical: 'a@x.com',
    });
    const result = partitionPendingForRoster([otherScope], 'CO');
    expect(result.pendingAdds).toEqual([]);
    expect(result.pendingRemovesByCanonical.size).toBe(0);
  });

  it('drops non-pending requests defensively', () => {
    const completed = makeRequest({
      request_id: 'r1',
      type: 'add_manual',
      scope: 'CO',
      status: 'complete',
      member_canonical: 'a@x.com',
    });
    const cancelled = makeRequest({
      request_id: 'r2',
      type: 'remove',
      scope: 'CO',
      status: 'cancelled',
      member_canonical: 'b@x.com',
    });
    const result = partitionPendingForRoster([completed, cancelled], 'CO');
    expect(result.pendingAdds).toEqual([]);
    expect(result.pendingRemovesByCanonical.size).toBe(0);
  });

  it('treats add_manual and add_temp identically as pending adds', () => {
    const manual = makeRequest({
      request_id: 'r1',
      type: 'add_manual',
      scope: 'CO',
      member_canonical: 'a@x.com',
    });
    const temp = makeRequest({
      request_id: 'r2',
      type: 'add_temp',
      scope: 'CO',
      member_canonical: 'b@x.com',
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
    const result = partitionPendingForRoster([manual, temp], 'CO');
    expect(result.pendingAdds.map((r) => r.request_id)).toEqual(['r1', 'r2']);
  });

  it('preserves caller-supplied order on pendingAdds (FIFO from the live hook)', () => {
    const a = makeRequest({
      request_id: 'r-old',
      type: 'add_manual',
      scope: 'stake',
      member_canonical: 'a@x.com',
      building_names: ['North Building'],
    });
    const b = makeRequest({
      request_id: 'r-new',
      type: 'add_manual',
      scope: 'stake',
      member_canonical: 'b@x.com',
      building_names: ['North Building'],
    });
    const result = partitionPendingForRoster([a, b], 'stake');
    expect(result.pendingAdds.map((r) => r.request_id)).toEqual(['r-old', 'r-new']);
  });

  it('keeps the first remove when multiple pending removes target the same member', () => {
    const first = makeRequest({
      request_id: 'r-first',
      type: 'remove',
      scope: 'CO',
      member_canonical: 'a@x.com',
    });
    const second = makeRequest({
      request_id: 'r-second',
      type: 'remove',
      scope: 'CO',
      member_canonical: 'a@x.com',
    });
    const result = partitionPendingForRoster([first, second], 'CO');
    expect(result.pendingRemovesByCanonical.get('a@x.com')?.request_id).toBe('r-first');
  });
});
