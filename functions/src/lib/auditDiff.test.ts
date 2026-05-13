// Unit tests for the audit-trigger diff helper. Pure logic; no
// emulator. The helper drives the trigger's no-op skip and excludes
// bookkeeping fields from the changed-keys check.

import { describe, expect, it } from 'vitest';
import { changedKeys, isNoOpUpdate } from './auditDiff.js';

describe('changedKeys', () => {
  it('returns empty when before and after are identical', () => {
    expect(changedKeys({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toEqual([]);
  });

  it('reports keys whose values changed', () => {
    expect(changedKeys({ a: 1, b: 'x' }, { a: 2, b: 'x' })).toEqual(['a']);
  });

  it('reports a missing key on either side as a change', () => {
    expect(changedKeys({ a: 1 }, { a: 1, b: 'x' })).toEqual(['b']);
    expect(changedKeys({ a: 1, b: 'x' }, { a: 1 })).toEqual(['b']);
  });

  it('excludes bookkeeping fields from the changed set', () => {
    const before = { lastActor: { canonical: 'a' }, member_name: 'Alice' };
    const after = { lastActor: { canonical: 'b' }, member_name: 'Alice' };
    expect(changedKeys(before, after)).toEqual([]);
  });

  it('treats a real field change alongside a lastActor change as material', () => {
    const before = { lastActor: { canonical: 'a' }, member_name: 'Alice' };
    const after = { lastActor: { canonical: 'b' }, member_name: 'Bob' };
    expect(changedKeys(before, after)).toEqual(['member_name']);
  });

  it('compares map / array fields by deep equality', () => {
    const before = { manual_grants: { stake: [{ grant_id: 'g1' }] } };
    const after = { manual_grants: { stake: [{ grant_id: 'g1' }] } };
    expect(changedKeys(before, after)).toEqual([]);

    const after2 = { manual_grants: { stake: [{ grant_id: 'g2' }] } };
    expect(changedKeys(before, after2)).toEqual(['manual_grants']);
  });

  it('handles the create case (before is null/undefined)', () => {
    expect(changedKeys(null, { a: 1 })).toEqual(['a']);
    expect(changedKeys(undefined, { a: 1, lastActor: {} })).toEqual(['a']);
  });

  it('handles the delete case (after is null/undefined)', () => {
    expect(changedKeys({ a: 1 }, null)).toEqual(['a']);
  });
});

describe('changedKeys deep-equal contract', () => {
  it('treats top-level objects with same data but different key order as equal', () => {
    const before = { cfg: { a: 1, b: 2, c: 3 } };
    const after = { cfg: { c: 3, a: 1, b: 2 } };
    expect(changedKeys(before, after)).toEqual([]);
  });

  it('reports the field as changed when data differs', () => {
    const before = { cfg: { a: 1, b: 2 } };
    const after = { cfg: { a: 1, b: 3 } };
    expect(changedKeys(before, after)).toEqual(['cfg']);
  });

  it('treats nested objects with reordered keys at depth 2 as equal', () => {
    const before = { cfg: { inner: { x: 1, y: 2, z: 3 } } };
    const after = { cfg: { inner: { z: 3, y: 2, x: 1 } } };
    expect(changedKeys(before, after)).toEqual([]);
  });

  it('treats array of objects with reordered keys within each entry as equal', () => {
    const before = {
      list: [
        { id: 'a', name: 'Alice', role: 'mgr' },
        { id: 'b', name: 'Bob', role: 'user' },
      ],
    };
    const after = {
      list: [
        { role: 'mgr', id: 'a', name: 'Alice' },
        { name: 'Bob', role: 'user', id: 'b' },
      ],
    };
    expect(changedKeys(before, after)).toEqual([]);
  });

  it('reports change for array of objects with different data', () => {
    const before = { list: [{ id: 'a' }, { id: 'b' }] };
    const after = { list: [{ id: 'a' }, { id: 'c' }] };
    expect(changedKeys(before, after)).toEqual(['list']);
  });

  it('treats Firestore-Timestamp-shaped objects as equal regardless of key order', () => {
    const before = { ts: { seconds: 1234567890, nanoseconds: 500000000 } };
    const after = { ts: { nanoseconds: 500000000, seconds: 1234567890 } };
    expect(changedKeys(before, after)).toEqual([]);
  });

  it('reports the kindoo_config B-6 regression case as unchanged', () => {
    // Mirror of the prod 2026-05-13 case in BUGS.md: same four fields,
    // reordered. The diff should NOT flag the field as changed.
    const before = {
      kindoo_config: {
        configured_at: '2026-05-13 3:24 am',
        site_id: 27994,
        configured_by: 'tad.e.smith@gmail.com',
        site_name: 'Colorado Springs North Stake',
      },
    };
    const after = {
      kindoo_config: {
        site_name: 'Colorado Springs North Stake',
        configured_by: 'tad.e.smith@gmail.com',
        configured_at: '2026-05-13 3:24 am',
        site_id: 27994,
      },
    };
    expect(changedKeys(before, after)).toEqual([]);
  });

  it('distinguishes null from {}', () => {
    expect(changedKeys({ v: null }, { v: {} })).toEqual(['v']);
    expect(changedKeys({ v: {} }, { v: null })).toEqual(['v']);
  });

  it('treats undefined and a missing key as equal', () => {
    expect(changedKeys({ a: 1, b: undefined }, { a: 1 })).toEqual([]);
    expect(changedKeys({ a: 1 }, { a: 1, b: undefined })).toEqual([]);
  });

  it('distinguishes [] from {}', () => {
    expect(changedKeys({ v: [] }, { v: {} })).toEqual(['v']);
    expect(changedKeys({ v: {} }, { v: [] })).toEqual(['v']);
  });

  it('respects array order (positional comparison)', () => {
    expect(changedKeys({ list: [1, 2, 3] }, { list: [3, 2, 1] })).toEqual(['list']);
  });

  it('reports differences in array length', () => {
    expect(changedKeys({ list: [1, 2] }, { list: [1, 2, 3] })).toEqual(['list']);
  });
});

describe('isNoOpUpdate', () => {
  it('is true when only bookkeeping fields differ', () => {
    const before = { lastActor: { canonical: 'a' }, last_modified_at: 't1', value: 5 };
    const after = { lastActor: { canonical: 'b' }, last_modified_at: 't2', value: 5 };
    expect(isNoOpUpdate(before, after)).toBe(true);
  });

  it('is false when a non-bookkeeping field changed', () => {
    const before = { lastActor: { canonical: 'a' }, value: 5 };
    const after = { lastActor: { canonical: 'a' }, value: 6 };
    expect(isNoOpUpdate(before, after)).toBe(false);
  });

  it('is false on create (no before)', () => {
    expect(isNoOpUpdate(null, { a: 1 })).toBe(false);
  });

  it('is false on delete (no after)', () => {
    expect(isNoOpUpdate({ a: 1 }, null)).toBe(false);
  });
});
