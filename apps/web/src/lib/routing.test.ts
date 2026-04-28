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

  it('returns /stake/new for a stake-member principal', () => {
    expect(defaultLandingFor(principal({ stakeMemberStakes: [STAKE_ID] }))).toBe('/stake/new');
  });

  it('returns /bishopric/new for a bishopric principal', () => {
    expect(defaultLandingFor(principal({ bishopricWards: { [STAKE_ID]: ['CO'] } }))).toBe(
      '/bishopric/new',
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
      ),
    ).toBe('/manager/dashboard');
    expect(
      defaultLandingFor(
        principal({
          stakeMemberStakes: [STAKE_ID],
          bishopricWards: { [STAKE_ID]: ['CO'] },
        }),
      ),
    ).toBe('/stake/new');
  });

  it('prefers manager when the principal is a platform superadmin', () => {
    expect(defaultLandingFor(principal({ isPlatformSuperadmin: true }))).toBe('/manager/dashboard');
  });

  it('falls back to /hello when the principal has no role in this stake', () => {
    expect(defaultLandingFor(principal({ managerStakes: ['other-stake'] }))).toBe('/hello');
  });
});

describe('deepLinkPath', () => {
  it('returns null for an empty / undefined key', () => {
    expect(deepLinkPath(undefined)).toBeNull();
    expect(deepLinkPath('')).toBeNull();
  });

  it('resolves the hello key (Phase 4)', () => {
    expect(deepLinkPath('hello')).toBe('/hello');
  });

  it('returns null for unknown keys', () => {
    expect(deepLinkPath('some-future-page')).toBeNull();
  });
});
