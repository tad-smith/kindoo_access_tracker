// Unit tests for the pure New-Request scope-authority helpers. Covers
// each row in the operator-stated spec table, including the Kindoo
// Manager branch (manager → every scope, no `access` row needed) and
// the platform-superadmin regression guard (superadmin alone grants
// nothing).

import { describe, expect, it } from 'vitest';
import { allowedScopesFor, canEditSeat, isScopeAllowed } from '../scopeOptions';
import type { Principal } from '../../../lib/principal';
import { makeSeat, makeWard } from '../../../../test/fixtures';

const STAKE_ID = 'csnorth';

// Wards catalogue for label resolution. Includes CO/BA/GR so the
// option labels render ward names; an unresolved code falls back to the
// raw code.
const WARDS = [
  makeWard({ ward_code: 'CO', ward_name: 'Cottonwood' }),
  makeWard({ ward_code: 'BA', ward_name: 'Bayside' }),
  makeWard({ ward_code: 'GR', ward_name: 'Greenfield' }),
];

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

describe('allowedScopesFor — scope filter', () => {
  it('stake-only: returns just the stake option', () => {
    const principal = makePrincipal({ stakeMemberStakes: [STAKE_ID] });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([
      { value: 'stake', label: 'Stake' },
    ]);
  });

  it('single ward (no stake): returns that ward labelled by name', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([
      { value: 'CO', label: 'Cottonwood' },
    ]);
  });

  it('multi ward (no stake): returns each ward labelled by name, sorted by code', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['GR', 'BA', 'CO'] } });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([
      { value: 'BA', label: 'Bayside' },
      { value: 'CO', label: 'Cottonwood' },
      { value: 'GR', label: 'Greenfield' },
    ]);
  });

  it('unresolved ward code: falls back to the raw code as the label', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['ZZ'] } });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([{ value: 'ZZ', label: 'ZZ' }]);
  });

  it('stake plus N wards: stake first, then those wards by name (no others)', () => {
    const principal = makePrincipal({
      stakeMemberStakes: [STAKE_ID],
      bishopricWards: { [STAKE_ID]: ['CO', 'BA'] },
    });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([
      { value: 'stake', label: 'Stake' },
      { value: 'BA', label: 'Bayside' },
      { value: 'CO', label: 'Cottonwood' },
    ]);
  });

  it('no role: returns an empty list', () => {
    const principal = makePrincipal({});
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([]);
  });

  it('manager-only (no stake / no ward claim): stake plus every ward in the catalogue', () => {
    const principal = makePrincipal({ managerStakes: [STAKE_ID] });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([
      { value: 'stake', label: 'Stake' },
      { value: 'BA', label: 'Bayside' },
      { value: 'CO', label: 'Cottonwood' },
      { value: 'GR', label: 'Greenfield' },
    ]);
  });

  it('manager of another stake: empty list — the manager claim is per-stake', () => {
    const principal = makePrincipal({ managerStakes: ['other'] });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([]);
  });

  it('manager + bishopric of a ward: that ward is listed once, not twice', () => {
    const principal = makePrincipal({
      managerStakes: [STAKE_ID],
      bishopricWards: { [STAKE_ID]: ['CO'] },
    });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([
      { value: 'stake', label: 'Stake' },
      { value: 'BA', label: 'Bayside' },
      { value: 'CO', label: 'Cottonwood' },
      { value: 'GR', label: 'Greenfield' },
    ]);
  });

  it('manager + stake + bishopric: stake is listed once and each ward once', () => {
    const principal = makePrincipal({
      managerStakes: [STAKE_ID],
      stakeMemberStakes: [STAKE_ID],
      bishopricWards: { [STAKE_ID]: ['CO', 'GR'] },
    });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([
      { value: 'stake', label: 'Stake' },
      { value: 'BA', label: 'Bayside' },
      { value: 'CO', label: 'Cottonwood' },
      { value: 'GR', label: 'Greenfield' },
    ]);
  });

  it('platform superadmin without manager / stake / ward claim: empty list — superadmin status does not grant scope options', () => {
    const principal = makePrincipal({ isPlatformSuperadmin: true });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([]);
  });

  it('different stake claim: ignores wards keyed under another stake', () => {
    const principal = makePrincipal({
      bishopricWards: { other: ['CO'], [STAKE_ID]: ['BA'] },
    });
    expect(allowedScopesFor(principal, STAKE_ID, WARDS)).toEqual([
      { value: 'BA', label: 'Bayside' },
    ]);
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

  it('manager-only (no stake / no ward claim): allowed for stake and for any ward', () => {
    const principal = makePrincipal({ managerStakes: [STAKE_ID] });
    expect(isScopeAllowed(principal, STAKE_ID, 'stake')).toBe(true);
    expect(isScopeAllowed(principal, STAKE_ID, 'CO')).toBe(true);
    // A ward the manager holds no bishopric claim for, and one absent
    // from the catalogue entirely.
    expect(isScopeAllowed(principal, STAKE_ID, 'GR')).toBe(true);
    expect(isScopeAllowed(principal, STAKE_ID, 'ZZ')).toBe(true);
  });

  it('manager + bishopric: allowed for a ward OUTSIDE the bishopric list — manager authority is blanket, not an intersection', () => {
    const principal = makePrincipal({
      managerStakes: [STAKE_ID],
      bishopricWards: { [STAKE_ID]: ['CO'] },
    });
    expect(isScopeAllowed(principal, STAKE_ID, 'CO')).toBe(true);
    expect(isScopeAllowed(principal, STAKE_ID, 'GR')).toBe(true);
    expect(isScopeAllowed(principal, STAKE_ID, 'stake')).toBe(true);
  });

  it('manager of another stake: never allowed here — the manager claim is per-stake', () => {
    const principal = makePrincipal({ managerStakes: ['other'] });
    expect(isScopeAllowed(principal, STAKE_ID, 'stake')).toBe(false);
    expect(isScopeAllowed(principal, STAKE_ID, 'CO')).toBe(false);
  });

  it('platform superadmin without a manager claim: never allowed — superadmin status alone grants nothing', () => {
    const principal = makePrincipal({ isPlatformSuperadmin: true });
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
  it('stake-scope auto seat: never editable, even for a stake user (Church-managed)', () => {
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

  it('manager-only (no stake / no ward claim): editable in any scope — symmetric with Remove', () => {
    const principal = makePrincipal({ managerStakes: [STAKE_ID] });
    expect(canEditSeat(principal, STAKE_ID, makeSeat({ type: 'auto', scope: 'CO' }))).toBe(true);
    expect(
      canEditSeat(principal, STAKE_ID, makeSeat({ type: 'manual', scope: 'CO', callings: [] })),
    ).toBe(true);
    expect(
      canEditSeat(principal, STAKE_ID, makeSeat({ type: 'manual', scope: 'stake', callings: [] })),
    ).toBe(true);
  });

  it('manager-only: stake-scope auto seat stays non-editable — Policy 1 outranks the manager branch', () => {
    const principal = makePrincipal({ managerStakes: [STAKE_ID] });
    expect(canEditSeat(principal, STAKE_ID, makeSeat({ type: 'auto', scope: 'stake' }))).toBe(
      false,
    );
  });

  it('platform superadmin without a manager claim: never editable', () => {
    const principal = makePrincipal({ isPlatformSuperadmin: true });
    expect(
      canEditSeat(principal, STAKE_ID, makeSeat({ type: 'manual', scope: 'CO', callings: [] })),
    ).toBe(false);
  });

  it('no role: never editable', () => {
    const principal = makePrincipal({});
    expect(canEditSeat(principal, STAKE_ID, makeSeat({ type: 'manual', scope: 'CO' }))).toBe(false);
  });
});
