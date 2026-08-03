import { describe, expect, it } from 'vitest';
import {
  addBlockedByExistingSeat,
  existingSeatFacts,
  seatHasStakeGrant,
} from './existingSeatGate.js';
import type { Seat } from './types/seat.js';

type SeatShape = Pick<Seat, 'scope' | 'duplicate_grants'>;

function seat(scope: string, duplicateScopes: string[] = []): SeatShape {
  return {
    scope,
    duplicate_grants: duplicateScopes.map((s) => ({
      scope: s,
      type: 'manual' as const,
      building_names: [],
      detected_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(0), toMillis: () => 0 },
    })),
  };
}

describe('seatHasStakeGrant', () => {
  it('is true for a stake-scope primary grant', () => {
    expect(seatHasStakeGrant(seat('stake'))).toBe(true);
  });

  it('is true when a duplicate grant is stake-scope', () => {
    expect(seatHasStakeGrant(seat('CO', ['stake']))).toBe(true);
  });

  it('is false for a ward seat with only ward duplicates', () => {
    expect(seatHasStakeGrant(seat('CO', ['GE']))).toBe(false);
  });

  it('treats a seat with no duplicate_grants array as having none', () => {
    expect(seatHasStakeGrant({ scope: 'CO' } as SeatShape)).toBe(false);
  });
});

describe('existingSeatFacts', () => {
  it('reports no seat for an absent or unresolved lookup', () => {
    expect(existingSeatFacts(undefined)).toEqual({ hasSeat: false, hasStakeGrant: false });
    expect(existingSeatFacts(null)).toEqual({ hasSeat: false, hasStakeGrant: false });
  });

  it('reports the seat and its stake grant when the doc is present', () => {
    expect(existingSeatFacts(seat('CO', ['stake']))).toEqual({
      hasSeat: true,
      hasStakeGrant: true,
    });
  });
});

describe('addBlockedByExistingSeat', () => {
  const noSeat = { hasSeat: false, hasStakeGrant: false };
  const wardSeat = { hasSeat: true, hasStakeGrant: false };
  const stakeSeat = { hasSeat: true, hasStakeGrant: true };

  it('does not block an add for a member with no seat', () => {
    expect(addBlockedByExistingSeat({ type: 'add_manual', scope: 'stake' }, noSeat)).toBe(false);
  });

  it('permits a stake-scope manual add onto a seat that holds no stake grant', () => {
    expect(addBlockedByExistingSeat({ type: 'add_manual', scope: 'stake' }, wardSeat)).toBe(false);
  });

  it('blocks a stake-scope manual add once the member already holds a stake grant', () => {
    expect(addBlockedByExistingSeat({ type: 'add_manual', scope: 'stake' }, stakeSeat)).toBe(true);
  });

  it('blocks a ward-scope manual add for a member who already has a seat', () => {
    expect(addBlockedByExistingSeat({ type: 'add_manual', scope: 'CO' }, wardSeat)).toBe(true);
  });

  it('blocks a stake-scope temp add — the carve-out is add_manual only', () => {
    expect(addBlockedByExistingSeat({ type: 'add_temp', scope: 'stake' }, wardSeat)).toBe(true);
  });

  it('never blocks an edit, whose completion expects an existing seat', () => {
    for (const type of ['edit_auto', 'edit_manual', 'edit_temp'] as const) {
      expect(addBlockedByExistingSeat({ type, scope: 'stake' }, stakeSeat)).toBe(false);
    }
  });

  it('never blocks a remove', () => {
    expect(addBlockedByExistingSeat({ type: 'remove', scope: 'CO' }, stakeSeat)).toBe(false);
  });
});
