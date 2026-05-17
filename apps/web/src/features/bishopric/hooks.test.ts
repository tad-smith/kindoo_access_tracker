// Unit tests for the KS-10 two-query union helper.
//
// `mergeSeatsByCanonical` merges the two subscriptions of the
// broadened-inclusion roster hook (primary-scope match + duplicate-
// scope match) into a single seat list, deduped by
// `member_canonical`. Central to Phase B — every broadened roster
// page routes its reads through it.

import { describe, expect, it } from 'vitest';
import type { Seat } from '@kindoo/shared';
import { makeSeat } from '../../../test/fixtures';
import { mergeSeatsByCanonical, type RosterResult } from './hooks';

function liveOk(data: Seat[]): RosterResult {
  return { data, isLoading: false };
}

function liveLoading(): RosterResult {
  return { data: undefined, isLoading: true };
}

describe('mergeSeatsByCanonical', () => {
  it('returns an empty list when both subscriptions are empty', () => {
    const merged = mergeSeatsByCanonical(liveOk([]), liveOk([]));
    expect(merged.data).toEqual([]);
    expect(merged.isLoading).toBe(false);
  });

  it('passes through the primary subscription when the duplicate subscription is empty', () => {
    const a = makeSeat({ member_canonical: 'a@x.com', scope: 'CO' });
    const merged = mergeSeatsByCanonical(liveOk([a]), liveOk([]));
    expect(merged.data?.map((s) => s.member_canonical)).toEqual(['a@x.com']);
  });

  it('passes through the duplicate subscription when the primary subscription is empty', () => {
    const b = makeSeat({ member_canonical: 'b@x.com', scope: 'stake' });
    const merged = mergeSeatsByCanonical(liveOk([]), liveOk([b]));
    expect(merged.data?.map((s) => s.member_canonical)).toEqual(['b@x.com']);
  });

  it('dedupes seats that appear in both subscriptions (primary subscription wins)', () => {
    // A seat whose primary scope matches AND whose duplicate_scopes
    // also includes the page's scope (same-scope within-site dup)
    // appears in both subscriptions. The merged list contains the
    // seat exactly once.
    const seat = makeSeat({ member_canonical: 'shared@x.com', scope: 'CO' });
    const merged = mergeSeatsByCanonical(liveOk([seat]), liveOk([seat]));
    expect(merged.data?.map((s) => s.member_canonical)).toEqual(['shared@x.com']);
  });

  it("preserves the primary subscription's instance when a seat appears in both (no double-merge of fields)", () => {
    // Primary and duplicate subscriptions return the same seat doc;
    // both snapshots are semantically identical. The merge picks one
    // (first-write wins) so downstream consumers don't see a stale
    // reference from the slower subscription.
    const primaryCopy = makeSeat({
      member_canonical: 'c@x.com',
      scope: 'CO',
      member_name: 'Primary Copy',
    });
    const dupeCopy = makeSeat({
      member_canonical: 'c@x.com',
      scope: 'CO',
      member_name: 'Dupe Copy',
    });
    const merged = mergeSeatsByCanonical(liveOk([primaryCopy]), liveOk([dupeCopy]));
    expect(merged.data).toHaveLength(1);
    expect(merged.data?.[0]?.member_name).toBe('Primary Copy');
  });

  it('returns the union of two disjoint subscriptions', () => {
    const a = makeSeat({ member_canonical: 'a@x.com', scope: 'CO' });
    const b = makeSeat({ member_canonical: 'b@x.com', scope: 'stake' });
    const merged = mergeSeatsByCanonical(liveOk([a]), liveOk([b]));
    expect(merged.data?.map((s) => s.member_canonical).sort()).toEqual(['a@x.com', 'b@x.com']);
  });

  it('surfaces data=undefined while either subscription is hydrating (page renders its skeleton)', () => {
    const a = makeSeat({ member_canonical: 'a@x.com' });
    expect(mergeSeatsByCanonical(liveOk([a]), liveLoading()).data).toBeUndefined();
    expect(mergeSeatsByCanonical(liveLoading(), liveOk([a])).data).toBeUndefined();
    expect(mergeSeatsByCanonical(liveLoading(), liveLoading()).data).toBeUndefined();
  });

  it('propagates isLoading=true if either subscription is loading', () => {
    expect(mergeSeatsByCanonical(liveOk([]), liveLoading()).isLoading).toBe(true);
    expect(mergeSeatsByCanonical(liveLoading(), liveOk([])).isLoading).toBe(true);
  });
});
