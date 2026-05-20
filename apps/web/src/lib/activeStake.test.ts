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

  it('platform superadmin with zero accessible stakes accepts a local-tier hint deep-link target', () => {
    // Per spec §5.4 / F19, a platform superadmin can read every stake's
    // parent doc and the Stake List deep-links route through `?stake=X`
    // which then persists into storage. The resolver must not invalidate
    // the value — they have access to the navigation surface for every
    // stake. Per-stake data reads are still rule-gated downstream.
    const sa = makePrincipal({ isPlatformSuperadmin: true });
    const result = resolveActiveStake(sa, null, null, 'foreign');
    expect(result.stakeId).toBe('foreign');
    expect(result.source).toBe('local');
    expect(result.invalidatedTier).toBeNull();
  });

  it('URL value is preferred over session and local even when all three differ', () => {
    const p = makePrincipal({ managerStakes: ['a', 'b', 'c'] });
    const result = resolveActiveStake(p, 'a', 'b', 'c');
    expect(result.stakeId).toBe('a');
    expect(result.source).toBe('url');
  });

  describe('platform superadmin deep-link carve-out (item 3)', () => {
    it('accepts any stake id from the URL tier without invalidation', () => {
      const sa = makePrincipal({ isPlatformSuperadmin: true });
      const result = resolveActiveStake(sa, 'foreignstake', null, null);
      expect(result.stakeId).toBe('foreignstake');
      expect(result.source).toBe('url');
      expect(result.invalidatedTier).toBeNull();
    });

    it('accepts any stake id from the sessionStorage tier without invalidation', () => {
      const sa = makePrincipal({ isPlatformSuperadmin: true });
      const result = resolveActiveStake(sa, null, 'foreignstake', null);
      expect(result.stakeId).toBe('foreignstake');
      expect(result.source).toBe('session');
      expect(result.invalidatedTier).toBeNull();
    });

    it('still resolves null when nothing is set (superadmin with empty hint chain)', () => {
      const sa = makePrincipal({ isPlatformSuperadmin: true });
      const result = resolveActiveStake(sa, null, null, null);
      expect(result.stakeId).toBeNull();
      expect(result.source).toBe('none');
      expect(result.invalidatedTier).toBeNull();
    });

    it('does not toast/invalidate for a superadmin who also has per-stake roles but deep-links to a foreign stake', () => {
      // A superadmin with `managerStakes=['csnorth']` clicking a row for
      // `ridgeline` in the Stake List page. Permissive path admits the
      // URL value regardless of per-stake role.
      const sa = makePrincipal({
        isPlatformSuperadmin: true,
        managerStakes: ['csnorth'],
      });
      const result = resolveActiveStake(sa, 'ridgeline', null, null);
      expect(result.stakeId).toBe('ridgeline');
      expect(result.source).toBe('url');
      expect(result.invalidatedTier).toBeNull();
    });
  });

  describe('bootstrap-admin carve-out narrowing (item 5)', () => {
    it('authenticated principal with zero accessible stakes accepts a URL hint', () => {
      // The pre-claim / bootstrap-admin window: signed in to Firebase
      // Auth, but `onAuthUserCreate` hasn't stamped role claims yet.
      const p = makePrincipal({ firebaseAuthSignedIn: true, isAuthenticated: false });
      const result = resolveActiveStake(p, 'newstake', null, null);
      expect(result.stakeId).toBe('newstake');
      expect(result.source).toBe('url');
      expect(result.invalidatedTier).toBeNull();
    });

    it('UNAUTHENTICATED principal with a URL hint does NOT resolve to it', () => {
      // An unauth visitor landing on a `?stake=X` deep-link must NOT be
      // treated as a bootstrap candidate. The resolver falls through to
      // null (the sign-in page is what the route gate ultimately
      // renders); the URL hint is ignored.
      const p = makePrincipal({ firebaseAuthSignedIn: false, isAuthenticated: false });
      const result = resolveActiveStake(p, 'newstake', null, null);
      expect(result.stakeId).toBeNull();
      expect(result.source).toBe('none');
    });

    it('UNAUTHENTICATED principal with a sessionStorage hint does NOT resolve to it', () => {
      const p = makePrincipal({ firebaseAuthSignedIn: false, isAuthenticated: false });
      const result = resolveActiveStake(p, null, 'leftover', null);
      expect(result.stakeId).toBeNull();
      expect(result.source).toBe('none');
    });
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
