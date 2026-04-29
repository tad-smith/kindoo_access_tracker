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
