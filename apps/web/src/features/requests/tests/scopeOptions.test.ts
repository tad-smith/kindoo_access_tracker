// Unit tests for `allowedScopesFor` — the pure New-Request scope-filter
// helper. Covers each row in the operator-stated spec table for B-3.

import { describe, expect, it } from 'vitest';
import { allowedScopesFor, canEditSeat, isScopeAllowed } from '../scopeOptions';
import type { Principal } from '../../../lib/principal';
import { makeSeat } from '../../../../test/fixtures';

const STAKE_ID = 'csnorth';

function makePrincipal(overrides: Partial<Principal>): Principal {
  return {
    email: 'a@b.c',
    canonical: 'a@b.c',
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => false,
    wardsInStake: () => [],
    ...overrides,
  };
}

describe('allowedScopesFor — B-3 scope filter', () => {
  it('stake-only: returns just the stake option', () => {
    const principal = makePrincipal({ stakeMemberStakes: [STAKE_ID] });
    expect(allowedScopesFor(principal, STAKE_ID)).toEqual([{ value: 'stake', label: 'Stake' }]);
  });

  it('single ward (no stake): returns just that ward', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    expect(allowedScopesFor(principal, STAKE_ID)).toEqual([{ value: 'CO', label: 'Ward CO' }]);
  });

  it('multi ward (no stake): returns each ward, sorted', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['GR', 'BA', 'CO'] } });
    expect(allowedScopesFor(principal, STAKE_ID)).toEqual([
      { value: 'BA', label: 'Ward BA' },
      { value: 'CO', label: 'Ward CO' },
      { value: 'GR', label: 'Ward GR' },
    ]);
  });

  it('stake plus N wards: stake first, then those wards (no others)', () => {
    const principal = makePrincipal({
      stakeMemberStakes: [STAKE_ID],
      bishopricWards: { [STAKE_ID]: ['CO', 'BA'] },
    });
    expect(allowedScopesFor(principal, STAKE_ID)).toEqual([
      { value: 'stake', label: 'Stake' },
      { value: 'BA', label: 'Ward BA' },
      { value: 'CO', label: 'Ward CO' },
    ]);
  });

  it('no role: returns an empty list', () => {
    const principal = makePrincipal({});
    expect(allowedScopesFor(principal, STAKE_ID)).toEqual([]);
  });

  it('manager-only (no stake / no ward claim): empty list — manager status does not grant scope options', () => {
    const principal = makePrincipal({ managerStakes: [STAKE_ID] });
    expect(allowedScopesFor(principal, STAKE_ID)).toEqual([]);
  });

  it('platform superadmin without stake / ward claim: empty list — superadmin status does not grant scope options', () => {
    const principal = makePrincipal({ isPlatformSuperadmin: true });
    expect(allowedScopesFor(principal, STAKE_ID)).toEqual([]);
  });

  it('manager + stake claim: stake option only (manager adds nothing on top)', () => {
    const principal = makePrincipal({
      managerStakes: [STAKE_ID],
      stakeMemberStakes: [STAKE_ID],
    });
    expect(allowedScopesFor(principal, STAKE_ID)).toEqual([{ value: 'stake', label: 'Stake' }]);
  });

  it('different stake claim: ignores wards keyed under another stake', () => {
    const principal = makePrincipal({
      bishopricWards: { other: ['CO'], [STAKE_ID]: ['BA'] },
    });
    expect(allowedScopesFor(principal, STAKE_ID)).toEqual([{ value: 'BA', label: 'Ward BA' }]);
  });
});

describe('isScopeAllowed — symmetric authority gate for the per-row Remove button', () => {
  it('stake user → stake scope allowed', () => {
    const principal = makePrincipal({ stakeMemberStakes: [STAKE_ID] });
    expect(isScopeAllowed(principal, STAKE_ID, 'stake')).toBe(true);
  });

  it('stake user → ward scope NOT allowed', () => {
    const principal = makePrincipal({ stakeMemberStakes: [STAKE_ID] });
    expect(isScopeAllowed(principal, STAKE_ID, 'CO')).toBe(false);
  });

  it('bishopric of CO → CO scope allowed', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    expect(isScopeAllowed(principal, STAKE_ID, 'CO')).toBe(true);
  });

  it('bishopric of CO → other ward NOT allowed', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    expect(isScopeAllowed(principal, STAKE_ID, 'GE')).toBe(false);
  });

  it('bishopric of CO → stake scope NOT allowed', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    expect(isScopeAllowed(principal, STAKE_ID, 'stake')).toBe(false);
  });

  it('stake + multi-ward bishopric → all of those scopes allowed', () => {
    const principal = makePrincipal({
      stakeMemberStakes: [STAKE_ID],
      bishopricWards: { [STAKE_ID]: ['CO', 'GE'] },
    });
    expect(isScopeAllowed(principal, STAKE_ID, 'stake')).toBe(true);
    expect(isScopeAllowed(principal, STAKE_ID, 'CO')).toBe(true);
    expect(isScopeAllowed(principal, STAKE_ID, 'GE')).toBe(true);
    expect(isScopeAllowed(principal, STAKE_ID, 'BA')).toBe(false);
  });

  it('no role: never allowed', () => {
    const principal = makePrincipal({});
    expect(isScopeAllowed(principal, STAKE_ID, 'stake')).toBe(false);
    expect(isScopeAllowed(principal, STAKE_ID, 'CO')).toBe(false);
  });

  it('manager-only (no stake / no ward claim): never allowed — manager status alone does not grant authority', () => {
    const principal = makePrincipal({ managerStakes: [STAKE_ID] });
    expect(isScopeAllowed(principal, STAKE_ID, 'stake')).toBe(false);
    expect(isScopeAllowed(principal, STAKE_ID, 'CO')).toBe(false);
  });

  it('different stake claim: ignores wards keyed under another stake', () => {
    const principal = makePrincipal({
      bishopricWards: { other: ['CO'], [STAKE_ID]: ['BA'] },
    });
    expect(isScopeAllowed(principal, STAKE_ID, 'BA')).toBe(true);
    expect(isScopeAllowed(principal, STAKE_ID, 'CO')).toBe(false);
  });
});

describe('canEditSeat — per-row Edit affordance gate', () => {
  it('stake-scope auto seat: never editable, even for a stake user (Policy 1)', () => {
    const principal = makePrincipal({ stakeMemberStakes: [STAKE_ID] });
    const seat = makeSeat({ type: 'auto', scope: 'stake' });
    expect(canEditSeat(principal, STAKE_ID, seat)).toBe(false);
  });

  it('ward-scope auto seat: editable by the bishopric of that ward', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    const seat = makeSeat({ type: 'auto', scope: 'CO' });
    expect(canEditSeat(principal, STAKE_ID, seat)).toBe(true);
  });

  it('ward-scope auto seat: NOT editable by an unrelated bishopric', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['GE'] } });
    const seat = makeSeat({ type: 'auto', scope: 'CO' });
    expect(canEditSeat(principal, STAKE_ID, seat)).toBe(false);
  });

  it('manual seat (ward scope): editable by the bishopric of that ward', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    const seat = makeSeat({ type: 'manual', scope: 'CO', callings: [] });
    expect(canEditSeat(principal, STAKE_ID, seat)).toBe(true);
  });

  it('manual seat (stake scope): editable by a stake user', () => {
    const principal = makePrincipal({ stakeMemberStakes: [STAKE_ID] });
    const seat = makeSeat({ type: 'manual', scope: 'stake', callings: [] });
    expect(canEditSeat(principal, STAKE_ID, seat)).toBe(true);
  });

  it('temp seat (ward scope): editable by the bishopric of that ward', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      start_date: '2026-05-01',
      end_date: '2026-12-31',
    });
    expect(canEditSeat(principal, STAKE_ID, seat)).toBe(true);
  });

  it('manager-only (no stake / no ward claim): never editable — symmetric with Remove', () => {
    const principal = makePrincipal({ managerStakes: [STAKE_ID] });
    expect(canEditSeat(principal, STAKE_ID, makeSeat({ type: 'auto', scope: 'CO' }))).toBe(false);
    expect(
      canEditSeat(principal, STAKE_ID, makeSeat({ type: 'manual', scope: 'CO', callings: [] })),
    ).toBe(false);
  });

  it('no role: never editable', () => {
    const principal = makePrincipal({});
    expect(canEditSeat(principal, STAKE_ID, makeSeat({ type: 'manual', scope: 'CO' }))).toBe(false);
  });
});
