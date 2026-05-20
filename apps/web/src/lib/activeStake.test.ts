// Unit tests for the pure active-stake resolution chain.
//
// Covers every tier (URL → session → local → principal), every
// invalidated-tier case, alphabetical principal-derived sort, and the
// zero-accessible-stakes → null branch.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from './principal';
import {
  ACTIVE_STAKE_LOCAL_KEY,
  ACTIVE_STAKE_SESSION_KEY,
  accessibleStakes,
  persistActiveStakeChoice,
  readLocalStake,
  readSessionStake,
  resolveActiveStake,
} from './activeStake';

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'a@b.c',
    canonical: 'a@b.c',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => false,
    wardsInStake: () => [],
    ...overrides,
  };
}

beforeEach(() => {
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.clear();
      window.localStorage.clear();
    } catch {
      // ignore
    }
  }
});

describe('accessibleStakes', () => {
  it('returns the deduped union of managerStakes ∪ stakeMemberStakes ∪ Object.keys(bishopricWards)', () => {
    const p = makePrincipal({
      managerStakes: ['alpha', 'beta'],
      stakeMemberStakes: ['beta', 'gamma'],
      bishopricWards: { delta: ['CO'], gamma: ['BA'] },
    });
    expect(accessibleStakes(p)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('skips empty bishopric ward arrays (no ward → no access on that stake)', () => {
    const p = makePrincipal({
      bishopricWards: { stale: [] },
    });
    expect(accessibleStakes(p)).toEqual([]);
  });

  it('sorts alphabetically by doc id', () => {
    const p = makePrincipal({
      managerStakes: ['zulu', 'alpha', 'mike'],
    });
    expect(accessibleStakes(p)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('returns [] for a zero-role platform superadmin', () => {
    const p = makePrincipal({ isPlatformSuperadmin: true });
    // Per spec §2.1: superadmins can read every stake's parent doc but
    // per-stake data is still role-gated. A zero-role superadmin
    // returns [] here.
    expect(accessibleStakes(p)).toEqual([]);
  });
});

describe('resolveActiveStake', () => {
  const principal = makePrincipal({
    managerStakes: ['csnorth'],
    stakeMemberStakes: ['ridgeline'],
  });

  it('tier 1: valid URL ?stake=X resolves with source=url', () => {
    const result = resolveActiveStake(principal, 'csnorth', null, null);
    expect(result).toEqual({ stakeId: 'csnorth', source: 'url', invalidatedTier: null });
  });

  it('tier 1 invalid: URL stake not in accessible set falls through to session, flags url', () => {
    const result = resolveActiveStake(principal, 'foreign', 'ridgeline', null);
    expect(result.stakeId).toBe('ridgeline');
    expect(result.source).toBe('session');
    expect(result.invalidatedTier).toBe('url');
  });

  it('tier 1 invalid: URL falls through all the way to principal when storage is also invalid', () => {
    const result = resolveActiveStake(principal, 'foreign', null, null);
    expect(result.stakeId).toBe('csnorth'); // alphabetically-first accessible
    expect(result.source).toBe('principal');
    expect(result.invalidatedTier).toBe('url');
  });

  it('tier 2: sessionStorage value resolves with source=session', () => {
    const result = resolveActiveStake(principal, null, 'ridgeline', null);
    expect(result).toEqual({ stakeId: 'ridgeline', source: 'session', invalidatedTier: null });
  });

  it('tier 2 invalid: stale session value falls through to local, flags session', () => {
    const result = resolveActiveStake(principal, null, 'foreign', 'ridgeline');
    expect(result.stakeId).toBe('ridgeline');
    expect(result.source).toBe('local');
    expect(result.invalidatedTier).toBe('session');
  });

  it('tier 3: localStorage value resolves with source=local', () => {
    const result = resolveActiveStake(principal, null, null, 'csnorth');
    expect(result).toEqual({ stakeId: 'csnorth', source: 'local', invalidatedTier: null });
  });

  it('tier 3 invalid: stale local value falls through to principal, flags local', () => {
    const result = resolveActiveStake(principal, null, null, 'foreign');
    expect(result.stakeId).toBe('csnorth');
    expect(result.source).toBe('principal');
    expect(result.invalidatedTier).toBe('local');
  });

  it('tier 4: no URL/session/local — picks alphabetically-first accessible stake', () => {
    const result = resolveActiveStake(principal, null, null, null);
    expect(result).toEqual({ stakeId: 'csnorth', source: 'principal', invalidatedTier: null });
  });

  it('tier 4: zero accessible stakes returns null', () => {
    const zero = makePrincipal({ isPlatformSuperadmin: true });
    const result = resolveActiveStake(zero, null, null, null);
    expect(result).toEqual({ stakeId: null, source: 'none', invalidatedTier: null });
  });

  it('zero accessible stakes with stale local still falls through to null + invalidated local', () => {
    const zero = makePrincipal({ isPlatformSuperadmin: true });
    const result = resolveActiveStake(zero, null, null, 'foreign');
    expect(result.stakeId).toBeNull();
    expect(result.source).toBe('none');
    expect(result.invalidatedTier).toBe('local');
  });

  it('URL value is preferred over session and local even when all three differ', () => {
    const p = makePrincipal({ managerStakes: ['a', 'b', 'c'] });
    const result = resolveActiveStake(p, 'a', 'b', 'c');
    expect(result.stakeId).toBe('a');
    expect(result.source).toBe('url');
  });
});

describe('persistActiveStakeChoice', () => {
  it('writes to both sessionStorage AND localStorage', () => {
    persistActiveStakeChoice('newstake');
    expect(readSessionStake()).toBe('newstake');
    expect(readLocalStake()).toBe('newstake');
    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('newstake');
    expect(window.localStorage.getItem(ACTIVE_STAKE_LOCAL_KEY)).toBe('newstake');
  });
});
