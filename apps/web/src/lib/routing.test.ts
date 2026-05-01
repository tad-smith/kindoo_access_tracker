// Unit tests for the routing helpers. Exercises the per-role
// default-landing rule (priority manager > stake > bishopric, mirrors
// `Router_defaultPageFor_` in the Apps Script Router) and the legacy
// `?p=` deep-link table.

import { describe, expect, it } from 'vitest';
import { defaultLandingFor, deepLinkPath } from './routing';
import { STAKE_ID } from './constants';
import type { Principal } from './principal';

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
    expect(defaultLandingFor(principal({ managerStakes: [STAKE_ID] }))).toBe('/manager/dashboard');
  });

  it('returns /new for a stake-member principal', () => {
    expect(defaultLandingFor(principal({ stakeMemberStakes: [STAKE_ID] }))).toBe('/new');
  });

  it('returns /new for a bishopric principal', () => {
    expect(defaultLandingFor(principal({ bishopricWards: { [STAKE_ID]: ['CO'] } }))).toBe('/new');
  });

  it('priorities manager > stake > bishopric for multi-role unions', () => {
    expect(
      defaultLandingFor(
        principal({
          managerStakes: [STAKE_ID],
          stakeMemberStakes: [STAKE_ID],
          bishopricWards: { [STAKE_ID]: ['CO'] },
        }),
      ),
    ).toBe('/manager/dashboard');
    expect(
      defaultLandingFor(
        principal({
          stakeMemberStakes: [STAKE_ID],
          bishopricWards: { [STAKE_ID]: ['CO'] },
        }),
      ),
    ).toBe('/new');
  });

  it('prefers manager when the principal is a platform superadmin', () => {
    expect(defaultLandingFor(principal({ isPlatformSuperadmin: true }))).toBe('/manager/dashboard');
  });

  it('falls back to / when the principal has no role in this stake', () => {
    expect(defaultLandingFor(principal({ managerStakes: ['other-stake'] }))).toBe('/');
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

  it('resolves all new-request keys to the unified /new route', () => {
    // Phase 10.1 collapsed `/bishopric/new` and `/stake/new` into
    // `/new`; the legacy `?p=` keys resolve straight there.
    expect(deepLinkPath('stake/new')).toBe('/new');
    expect(deepLinkPath('bish/new')).toBe('/new');
    expect(deepLinkPath('new')).toBe('/new');
  });

  it('resolves both the legacy and new MyRequests keys to a shared route', () => {
    expect(deepLinkPath('myreq')).toBe('/my-requests');
    expect(deepLinkPath('my')).toBe('/my-requests');
  });

  it('returns null for unknown keys', () => {
    expect(deepLinkPath('some-future-page')).toBeNull();
  });

  it('returns null for the deprecated hello key', () => {
    // Phase 4's placeholder route is gone; the deep link resolves to null
    // and falls through to the per-role default.
    expect(deepLinkPath('hello')).toBeNull();
  });
});
