// Unit tests for the routing helpers. Exercises the per-role
// default-landing rule (priority manager > stake > bishopric), the
// zero-role-platform-superadmin landing, and the legacy `?p=` deep-link
// table.

import { describe, expect, it } from 'vitest';
import { defaultLandingFor, deepLinkPath } from './routing';
import type { Principal } from './principal';

const STAKE_ID = 'csnorth';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'a@b.c',
    canonical: 'a@b.c',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => true,
    wardsInStake: () => [],
    ...overrides,
  };
}

describe('defaultLandingFor', () => {
  it('returns the manager dashboard for a manager principal', () => {
    expect(defaultLandingFor(principal({ managerStakes: [STAKE_ID] }), STAKE_ID)).toBe(
      '/manager/dashboard',
    );
  });

  it('returns /stake/roster for a stake-member principal', () => {
    expect(defaultLandingFor(principal({ stakeMemberStakes: [STAKE_ID] }), STAKE_ID)).toBe(
      '/stake/roster',
    );
  });

  it('returns /bishopric/roster for a bishopric principal', () => {
    expect(defaultLandingFor(principal({ bishopricWards: { [STAKE_ID]: ['CO'] } }), STAKE_ID)).toBe(
      '/bishopric/roster',
    );
  });

  it('priorities manager > stake > bishopric for multi-role unions', () => {
    expect(
      defaultLandingFor(
        principal({
          managerStakes: [STAKE_ID],
          stakeMemberStakes: [STAKE_ID],
          bishopricWards: { [STAKE_ID]: ['CO'] },
        }),
        STAKE_ID,
      ),
    ).toBe('/manager/dashboard');
    expect(
      defaultLandingFor(
        principal({
          stakeMemberStakes: [STAKE_ID],
          bishopricWards: { [STAKE_ID]: ['CO'] },
        }),
        STAKE_ID,
      ),
    ).toBe('/stake/roster');
  });

  it('prefers manager when the principal is a platform superadmin in an accessible stake', () => {
    expect(defaultLandingFor(principal({ isPlatformSuperadmin: true }), STAKE_ID)).toBe(
      '/manager/dashboard',
    );
  });

  it('falls back to / when the principal has no role in this stake', () => {
    expect(defaultLandingFor(principal({ managerStakes: ['other-stake'] }), STAKE_ID)).toBe('/');
  });

  it('lands a zero-role platform superadmin on /superadmin/stakes when stakeId is null', () => {
    expect(defaultLandingFor(principal({ isPlatformSuperadmin: true }), null)).toBe(
      '/superadmin/stakes',
    );
  });

  it('falls back to / for a no-role non-superadmin when stakeId is null', () => {
    expect(defaultLandingFor(principal(), null)).toBe('/');
  });
});

describe('deepLinkPath', () => {
  it('returns null for an empty / undefined key', () => {
    expect(deepLinkPath(undefined)).toBeNull();
    expect(deepLinkPath('')).toBeNull();
  });

  it('resolves the bishopric roster key', () => {
    expect(deepLinkPath('bish/roster')).toBe('/bishopric/roster');
  });

  it('resolves the manager dashboard key', () => {
    expect(deepLinkPath('mgr/dashboard')).toBe('/manager/dashboard');
  });

  it('resolves the manager seats key', () => {
    expect(deepLinkPath('mgr/seats')).toBe('/manager/seats');
  });

  it('resolves the manager audit-log key', () => {
    expect(deepLinkPath('mgr/audit')).toBe('/manager/audit');
  });

  it('resolves the manager queue key', () => {
    expect(deepLinkPath('mgr/queue')).toBe('/manager/queue');
  });

  it('no longer maps the retired new-request keys (they fall through to the per-role default)', () => {
    // The standalone `/new` page was removed; New Request is created
    // from the roster-page modals. The old `?p=` keys resolve to null
    // and the caller falls back to the principal's default landing.
    expect(deepLinkPath('stake/new')).toBeNull();
    expect(deepLinkPath('bish/new')).toBeNull();
    expect(deepLinkPath('new')).toBeNull();
  });

  it('resolves both the legacy and new MyRequests keys to a shared route', () => {
    expect(deepLinkPath('myreq')).toBe('/my-requests');
    expect(deepLinkPath('my')).toBe('/my-requests');
  });

  it('returns null for unknown keys', () => {
    expect(deepLinkPath('some-future-page')).toBeNull();
  });

  it('returns null for the deprecated hello key', () => {
    // The legacy placeholder route is gone; the deep link resolves to
    // null and falls through to the per-role default.
    expect(deepLinkPath('hello')).toBeNull();
  });
});
