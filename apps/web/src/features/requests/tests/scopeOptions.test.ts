// Unit tests for the pure New-Request scope-authority helpers. Covers
// each row in the operator-stated spec table, including the Kindoo
// Manager branch (manager → every scope, no `access` row needed) and
// the platform-superadmin regression guard (superadmin alone grants
// nothing). Also covers the D25 limited-app-access gates layered on
// top of the Edit / Remove affordance predicates.

import { describe, expect, it } from 'vitest';
import type { Seat } from '@kindoo/shared';
import {
  allowedScopesFor,
  canEditSeat,
  canRemoveSeat,
  isLimitedInStake,
  isScopeAllowed,
} from '../scopeOptions';
import type { GrantView } from '../../../lib/grants';
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
    limitedStakes: [],
    bootstrapStakes: [],
    hasAnyRole: () => false,
    wardsInStake: () => [],
    ...overrides,
  };
}

/** Minimal `GrantView` — only the two fields `canRemoveSeat` reads. */
function makeGrant(scope: string, type: Seat['type']): Pick<GrantView, 'scope' | 'type'> {
  return { scope, type };
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

describe('isLimitedInStake — D25 narrowing flag', () => {
  it('reports true for a stake listed in limitedStakes', () => {
    const principal = makePrincipal({ limitedStakes: [STAKE_ID] });
    expect(isLimitedInStake(principal, STAKE_ID)).toBe(true);
  });

  it('reports false for a stake absent from limitedStakes', () => {
    const principal = makePrincipal({ limitedStakes: ['other'] });
    expect(isLimitedInStake(principal, STAKE_ID)).toBe(false);
  });

  it('reports false when the principal holds no limited claim at all', () => {
    expect(isLimitedInStake(makePrincipal({}), STAKE_ID)).toBe(false);
  });

  it('is per-stake: limited in one stake does not narrow another', () => {
    const principal = makePrincipal({ limitedStakes: ['other'] });
    expect(isLimitedInStake(principal, 'other')).toBe(true);
    expect(isLimitedInStake(principal, STAKE_ID)).toBe(false);
  });
});

describe('canEditSeat — D25 limited access narrows Edit to temp seats', () => {
  const tempSeat = (scope: string) =>
    makeSeat({
      type: 'temp',
      scope,
      callings: [],
      start_date: '2026-05-01',
      end_date: '2026-06-01',
    });

  it('limited bishopric: ward-scope temp seat stays editable', () => {
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: [STAKE_ID],
    });
    expect(canEditSeat(principal, STAKE_ID, tempSeat('CO'))).toBe(true);
  });

  it('limited bishopric: ward-scope AUTO seat is not editable', () => {
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: [STAKE_ID],
    });
    expect(canEditSeat(principal, STAKE_ID, makeSeat({ type: 'auto', scope: 'CO' }))).toBe(false);
  });

  it('limited bishopric: ward-scope MANUAL seat is not editable', () => {
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: [STAKE_ID],
    });
    expect(
      canEditSeat(principal, STAKE_ID, makeSeat({ type: 'manual', scope: 'CO', callings: [] })),
    ).toBe(false);
  });

  it('limited stake user: stake-scope temp seat stays editable', () => {
    const principal = makePrincipal({
      stakeMemberStakes: [STAKE_ID],
      limitedStakes: [STAKE_ID],
    });
    expect(canEditSeat(principal, STAKE_ID, tempSeat('stake'))).toBe(true);
  });

  it('limited stake user: stake-scope manual seat is not editable', () => {
    const principal = makePrincipal({
      stakeMemberStakes: [STAKE_ID],
      limitedStakes: [STAKE_ID],
    });
    expect(
      canEditSeat(principal, STAKE_ID, makeSeat({ type: 'manual', scope: 'stake', callings: [] })),
    ).toBe(false);
  });

  it('limited: a temp seat in a scope the principal has no authority over stays denied', () => {
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: [STAKE_ID],
    });
    expect(canEditSeat(principal, STAKE_ID, tempSeat('GE'))).toBe(false);
  });

  it('limited in ANOTHER stake only: full editing authority here (manual seat editable)', () => {
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: ['other'],
    });
    expect(
      canEditSeat(principal, STAKE_ID, makeSeat({ type: 'manual', scope: 'CO', callings: [] })),
    ).toBe(true);
  });

  it('limited: Policy 1 still wins — a stake-scope auto seat is never editable', () => {
    const principal = makePrincipal({
      stakeMemberStakes: [STAKE_ID],
      limitedStakes: [STAKE_ID],
    });
    expect(canEditSeat(principal, STAKE_ID, makeSeat({ type: 'auto', scope: 'stake' }))).toBe(
      false,
    );
  });
});

describe('canRemoveSeat — per-row Remove affordance gate', () => {
  const manualSeat = (scope: string) => makeSeat({ type: 'manual', scope, callings: [] });
  const tempSeat = (scope: string) =>
    makeSeat({
      type: 'temp',
      scope,
      callings: [],
      start_date: '2026-05-01',
      end_date: '2026-06-01',
    });

  it('non-limited bishopric: manual grant in their ward is removable', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    expect(canRemoveSeat(principal, STAKE_ID, manualSeat('CO'), makeGrant('CO', 'manual'))).toBe(
      true,
    );
  });

  it('non-limited stake user: stake-scope manual grant is removable', () => {
    const principal = makePrincipal({ stakeMemberStakes: [STAKE_ID] });
    expect(
      canRemoveSeat(principal, STAKE_ID, manualSeat('stake'), makeGrant('stake', 'manual')),
    ).toBe(true);
  });

  it('scope mismatch: a grant outside the principal’s authority is never removable', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    expect(canRemoveSeat(principal, STAKE_ID, manualSeat('GE'), makeGrant('GE', 'manual'))).toBe(
      false,
    );
  });

  it('gates on the GRANT scope, not the seat scope: a duplicate grant in the viewer’s ward is removable', () => {
    const principal = makePrincipal({ bishopricWards: { [STAKE_ID]: ['CO'] } });
    // Seat's primary lives at stake scope; the row being rendered is the
    // CO duplicate grant, which this bishopric does control.
    expect(canRemoveSeat(principal, STAKE_ID, manualSeat('stake'), makeGrant('CO', 'manual'))).toBe(
      true,
    );
  });

  it('manager-only (no stake / no ward claim): removable in any scope — symmetric with Edit', () => {
    const principal = makePrincipal({ managerStakes: [STAKE_ID] });
    expect(canRemoveSeat(principal, STAKE_ID, manualSeat('CO'), makeGrant('CO', 'manual'))).toBe(
      true,
    );
  });

  // A manager is never minted `limited` (an active kindooManagers row
  // short-circuits the claim), so the D25 temp-only narrowing must not
  // reach them even if a limited grant sits alongside the manager row.
  it('manager who also carries a limited stake: still removable on a manual seat', () => {
    const principal = makePrincipal({
      managerStakes: [STAKE_ID],
      limitedStakes: [],
      bootstrapStakes: [],
    });
    expect(canRemoveSeat(principal, STAKE_ID, manualSeat('CO'), makeGrant('CO', 'manual'))).toBe(
      true,
    );
  });

  it('limited: a temp seat whose grant row is also temp is removable', () => {
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: [STAKE_ID],
    });
    expect(canRemoveSeat(principal, STAKE_ID, tempSeat('CO'), makeGrant('CO', 'temp'))).toBe(true);
  });

  it('limited: a MANUAL seat is not removable even on a temp-typed grant row', () => {
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: [STAKE_ID],
    });
    expect(canRemoveSeat(principal, STAKE_ID, manualSeat('CO'), makeGrant('CO', 'temp'))).toBe(
      false,
    );
  });

  it('limited: a temp seat’s MANUAL duplicate-grant row is not removable (stricter than the rules)', () => {
    // The rules only inspect the seat's primary `type`, so this submit
    // would pass server-side; the UI withholds the button anyway so the
    // limited user is never offered a manual removal.
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: [STAKE_ID],
    });
    expect(canRemoveSeat(principal, STAKE_ID, tempSeat('CO'), makeGrant('CO', 'manual'))).toBe(
      false,
    );
  });

  it('limited: an AUTO seat is not removable', () => {
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: [STAKE_ID],
    });
    expect(
      canRemoveSeat(
        principal,
        STAKE_ID,
        makeSeat({ type: 'auto', scope: 'CO' }),
        makeGrant('CO', 'auto'),
      ),
    ).toBe(false);
  });

  it('limited: scope mismatch still denies, even on a temp/temp pair', () => {
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: [STAKE_ID],
    });
    expect(canRemoveSeat(principal, STAKE_ID, tempSeat('GE'), makeGrant('GE', 'temp'))).toBe(false);
  });

  it('limited in ANOTHER stake only: manual removal here is unaffected', () => {
    const principal = makePrincipal({
      bishopricWards: { [STAKE_ID]: ['CO'] },
      limitedStakes: ['other'],
    });
    expect(canRemoveSeat(principal, STAKE_ID, manualSeat('CO'), makeGrant('CO', 'manual'))).toBe(
      true,
    );
  });
});
