// Unit tests for the web-side `principalFromClaims` wrapper around the
// shared derivation. We test the wrapper directly rather than mounting
// reactfire — the wrapper is responsible for adding `firebaseAuthSignedIn`
// + the `hasAnyRole` / `wardsInStake` helpers on top of `@kindoo/shared`'s
// pure `principalFromClaims`.
//
// We import from `./principal-derive` rather than `./principal` so the
// test module graph doesn't pull in the Firebase SDK init (which would
// call `getAuth()` against a fake API key and error under the Node
// platform path that vitest uses).

import { describe, expect, it } from 'vitest';
import { principalFromClaims, type CustomClaims } from './principal-derive';

const stubUser = { email: 'alice@example.com' };

describe('principalFromClaims (web wrapper)', () => {
  it('returns an unauthenticated principal when the user is null', () => {
    const p = principalFromClaims(null, null);
    expect(p.firebaseAuthSignedIn).toBe(false);
    expect(p.isAuthenticated).toBe(false);
    expect(p.email).toBe('');
    expect(p.canonical).toBe('');
    expect(p.isPlatformSuperadmin).toBe(false);
    expect(p.managerStakes).toEqual([]);
    expect(p.stakeMemberStakes).toEqual([]);
    expect(p.bishopricWards).toEqual({});
    expect(p.hasAnyRole('csnorth')).toBe(false);
    expect(p.wardsInStake('csnorth')).toEqual([]);
  });

  it('flags an authenticated user with no claims as signed-in-but-unauthorised', () => {
    const p = principalFromClaims(stubUser, {} as CustomClaims);
    expect(p.firebaseAuthSignedIn).toBe(true);
    // Shared isAuthenticated is false until role claims arrive.
    expect(p.isAuthenticated).toBe(false);
    expect(p.email).toBe('alice@example.com');
    expect(p.managerStakes).toEqual([]);
    expect(p.stakeMemberStakes).toEqual([]);
    expect(p.bishopricWards).toEqual({});
    expect(p.hasAnyRole('csnorth')).toBe(false);
  });

  it('derives managerStakes from manager-only claims', () => {
    const claims: CustomClaims = {
      canonical: 'alice@example.com',
      stakes: {
        csnorth: { manager: true, stake: false, wards: [] },
      },
    };
    const p = principalFromClaims(stubUser, claims);
    expect(p.firebaseAuthSignedIn).toBe(true);
    expect(p.isAuthenticated).toBe(true);
    expect(p.managerStakes).toEqual(['csnorth']);
    expect(p.stakeMemberStakes).toEqual([]);
    expect(p.bishopricWards).toEqual({});
    expect(p.hasAnyRole('csnorth')).toBe(true);
    expect(p.hasAnyRole('other')).toBe(false);
    expect(p.canonical).toBe('alice@example.com');
  });

  it('derives stakeMemberStakes from stake-only claims', () => {
    const claims: CustomClaims = {
      canonical: 'alice@example.com',
      stakes: {
        csnorth: { manager: false, stake: true, wards: [] },
      },
    };
    const p = principalFromClaims(stubUser, claims);
    expect(p.managerStakes).toEqual([]);
    expect(p.stakeMemberStakes).toEqual(['csnorth']);
    expect(p.bishopricWards).toEqual({});
    expect(p.hasAnyRole('csnorth')).toBe(true);
  });

  it('derives bishopricWards from multi-ward bishopric claims', () => {
    const claims: CustomClaims = {
      canonical: 'alice@example.com',
      stakes: {
        csnorth: { manager: false, stake: false, wards: ['CO', 'GE'] },
      },
    };
    const p = principalFromClaims(stubUser, claims);
    expect(p.managerStakes).toEqual([]);
    expect(p.stakeMemberStakes).toEqual([]);
    expect(p.bishopricWards).toEqual({ csnorth: ['CO', 'GE'] });
    expect(p.hasAnyRole('csnorth')).toBe(true);
    expect(p.wardsInStake('csnorth')).toEqual(['CO', 'GE']);
    expect(p.wardsInStake('other')).toEqual([]);
  });

  it('populates all three axes for a multi-role union (manager + stake + bishopric)', () => {
    const claims: CustomClaims = {
      canonical: 'alice@example.com',
      stakes: {
        csnorth: { manager: true, stake: true, wards: ['CO', 'GE'] },
      },
    };
    const p = principalFromClaims(stubUser, claims);
    expect(p.managerStakes).toEqual(['csnorth']);
    expect(p.stakeMemberStakes).toEqual(['csnorth']);
    expect(p.bishopricWards).toEqual({ csnorth: ['CO', 'GE'] });
    expect(p.hasAnyRole('csnorth')).toBe(true);
  });

  it('flags platform superadmin from the top-level claim', () => {
    const claims: CustomClaims = {
      canonical: 'super@example.com',
      isPlatformSuperadmin: true,
    };
    const p = principalFromClaims(stubUser, claims);
    expect(p.isPlatformSuperadmin).toBe(true);
    expect(p.isAuthenticated).toBe(true);
    expect(p.hasAnyRole('csnorth')).toBe(true); // superadmin counts as a role for the gate
    expect(p.managerStakes).toEqual([]);
  });

  it('omits empty-ward bishopric entries from bishopricWards', () => {
    const claims: CustomClaims = {
      canonical: 'alice@example.com',
      stakes: {
        csnorth: { manager: true, stake: false, wards: [] },
      },
    };
    const p = principalFromClaims(stubUser, claims);
    expect(p.bishopricWards).toEqual({});
  });

  it('handles multi-stake claims separately', () => {
    const claims: CustomClaims = {
      canonical: 'alice@example.com',
      stakes: {
        csnorth: { manager: true, stake: false, wards: [] },
        cssouth: { manager: false, stake: false, wards: ['BO'] },
      },
    };
    const p = principalFromClaims(stubUser, claims);
    expect(p.managerStakes).toEqual(['csnorth']);
    expect(p.bishopricWards).toEqual({ cssouth: ['BO'] });
    expect(p.hasAnyRole('csnorth')).toBe(true);
    expect(p.hasAnyRole('cssouth')).toBe(true);
    expect(p.hasAnyRole('csother')).toBe(false);
  });
});
