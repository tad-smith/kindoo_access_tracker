// Unit tests for the pure roster-pending partitioner.

import { describe, expect, it } from 'vitest';
import { makeRequest } from '../../../../test/fixtures';
import { partitionPendingForRoster, pendingRemoveKey } from '../rosterPending';

describe('partitionPendingForRoster', () => {
  it('returns empty partition for an empty request stream', () => {
    const result = partitionPendingForRoster([], 'CO');
    expect(result.pendingAdds).toEqual([]);
    expect(result.pendingRemovesByKey.size).toBe(0);
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
    expect(result.pendingRemovesByKey.get(pendingRemoveKey('b@x.com', 'CO', null))).toEqual(remove);
  });

  it('keys the remove map by (member_canonical, scope, kindoo_site_id) for per-grant lookup', () => {
    const remove = makeRequest({
      request_id: 'r1',
      type: 'remove',
      scope: 'CO',
      member_canonical: 'someone@example.com',
    });
    const { pendingRemovesByKey } = partitionPendingForRoster([remove], 'CO');
    expect(pendingRemovesByKey.has(pendingRemoveKey('someone@example.com', 'CO', null))).toBe(true);
    expect(pendingRemovesByKey.has(pendingRemoveKey('nobody@example.com', 'CO', null))).toBe(false);
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
    expect(result.pendingRemovesByKey.size).toBe(0);
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
    expect(result.pendingRemovesByKey.size).toBe(0);
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

  it('keeps the first remove when multiple pending removes target the same (member, scope, site)', () => {
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
    expect(
      result.pendingRemovesByKey.get(pendingRemoveKey('a@x.com', 'CO', null))?.request_id,
    ).toBe('r-first');
  });

  // T-43 Phase B AC #13 — a pending remove on the East-Stake-Cordera
  // duplicate must not light up the home-Cordera row.
  it('discriminates pending removes by kindoo_site_id (Phase B AC #13)', () => {
    const homeRemove = makeRequest({
      request_id: 'r-home',
      type: 'remove',
      scope: 'CO',
      member_canonical: 'a@x.com',
      kindoo_site_id: null,
    });
    const foreignRemove = makeRequest({
      request_id: 'r-foreign',
      type: 'remove',
      scope: 'CO',
      member_canonical: 'a@x.com',
      kindoo_site_id: 'east-stake',
    });
    const result = partitionPendingForRoster([homeRemove, foreignRemove], 'CO');
    expect(
      result.pendingRemovesByKey.get(pendingRemoveKey('a@x.com', 'CO', null))?.request_id,
    ).toBe('r-home');
    expect(
      result.pendingRemovesByKey.get(pendingRemoveKey('a@x.com', 'CO', 'east-stake'))?.request_id,
    ).toBe('r-foreign');
    // A request keyed on a different site does not collide.
    expect(result.pendingRemovesByKey.has(pendingRemoveKey('a@x.com', 'CO', 'west-stake'))).toBe(
      false,
    );
  });

  it('treats a missing kindoo_site_id as equivalent to null (legacy / home)', () => {
    const legacyRemove = makeRequest({
      request_id: 'r-legacy',
      type: 'remove',
      scope: 'CO',
      member_canonical: 'a@x.com',
      // No kindoo_site_id field at all.
    });
    const result = partitionPendingForRoster([legacyRemove], 'CO');
    expect(
      result.pendingRemovesByKey.get(pendingRemoveKey('a@x.com', 'CO', null))?.request_id,
    ).toBe('r-legacy');
    expect(
      result.pendingRemovesByKey.get(pendingRemoveKey('a@x.com', 'CO', undefined))?.request_id,
    ).toBe('r-legacy');
  });
});

describe('pendingRemoveKey', () => {
  it('produces distinct keys for different sites', () => {
    const a = pendingRemoveKey('member@x.com', 'CO', null);
    const b = pendingRemoveKey('member@x.com', 'CO', 'east-stake');
    expect(a).not.toBe(b);
  });

  it('treats undefined and null kindoo_site_id as equivalent', () => {
    expect(pendingRemoveKey('m@x.com', 'CO', null)).toBe(
      pendingRemoveKey('m@x.com', 'CO', undefined),
    );
  });
});
