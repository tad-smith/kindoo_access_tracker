// Tests for `principalFromClaims`. Mirrors the cases the migration plan
// calls out (no claims → unauthenticated; manager-only; stake-only;
// multi-ward bishopric; superadmin; mixed).
import { describe, expect, it } from 'vitest';
import { principalFromClaims } from './principal.js';
import type { CustomClaims } from './types/auth.js';

describe('principalFromClaims', () => {
  it('returns an unauthenticated principal for null claims', () => {
    const p = principalFromClaims(null, 'someone@example.com');
    expect(p.isAuthenticated).toBe(false);
    expect(p.canonical).toBe('');
    expect(p.email).toBe('someone@example.com');
    expect(p.managerStakes).toEqual([]);
    expect(p.stakeMemberStakes).toEqual([]);
    expect(p.bishopricWards).toEqual({});
    expect(p.isPlatformSuperadmin).toBe(false);
  });

  it('returns an unauthenticated principal for undefined claims', () => {
    const p = principalFromClaims(undefined, undefined);
    expect(p.isAuthenticated).toBe(false);
    expect(p.email).toBe('');
  });

  it('returns an unauthenticated principal when canonical is missing', () => {
    // A claims object can be present (e.g., from a partially-stamped
    // token mid-refresh) but lack the canonical field. Treat as no
    // identity rather than authenticating with an empty canonical.
    const p = principalFromClaims({ canonical: '' } as CustomClaims, 'a@b.com');
    expect(p.isAuthenticated).toBe(false);
    expect(p.canonical).toBe('');
  });

  it('treats canonical-only claims (no roles) as not authenticated', () => {
    // A canonical alone confers no role — the user lands on
    // NotAuthorized rather than on a role-gated landing page.
    const p = principalFromClaims({ canonical: 'alice@gmail.com' }, 'Alice@gmail.com');
    expect(p.isAuthenticated).toBe(false);
    expect(p.canonical).toBe('alice@gmail.com');
    expect(p.email).toBe('Alice@gmail.com');
  });

  it('flags a manager-only principal correctly', () => {
    const claims: CustomClaims = {
      canonical: 'mgr@gmail.com',
      stakes: { csnorth: { manager: true, stake: false, wards: [] } },
    };
    const p = principalFromClaims(claims, 'Mgr@gmail.com');
    expect(p.isAuthenticated).toBe(true);
    expect(p.managerStakes).toEqual(['csnorth']);
    expect(p.stakeMemberStakes).toEqual([]);
    expect(p.bishopricWards).toEqual({});
    expect(p.isPlatformSuperadmin).toBe(false);
  });

  it('flags a stake-member-only principal correctly', () => {
    const claims: CustomClaims = {
      canonical: 'stake@gmail.com',
      stakes: { csnorth: { manager: false, stake: true, wards: [] } },
    };
    const p = principalFromClaims(claims, 'stake@gmail.com');
    expect(p.isAuthenticated).toBe(true);
    expect(p.managerStakes).toEqual([]);
    expect(p.stakeMemberStakes).toEqual(['csnorth']);
    expect(p.bishopricWards).toEqual({});
  });

  it('flags multi-ward bishopric membership keyed by stakeId', () => {
    const claims: CustomClaims = {
      canonical: 'bish@gmail.com',
      stakes: { csnorth: { manager: false, stake: false, wards: ['CO', 'GE'] } },
    };
    const p = principalFromClaims(claims, 'bish@gmail.com');
    expect(p.isAuthenticated).toBe(true);
    expect(p.bishopricWards).toEqual({ csnorth: ['CO', 'GE'] });
    // Empty stake-member / manager arrays preserved.
    expect(p.managerStakes).toEqual([]);
    expect(p.stakeMemberStakes).toEqual([]);
  });

  it('combines roles when a user is manager, stake-member, and bishopric', () => {
    const claims: CustomClaims = {
      canonical: 'all@gmail.com',
      stakes: { csnorth: { manager: true, stake: true, wards: ['CO'] } },
    };
    const p = principalFromClaims(claims, 'all@gmail.com');
    expect(p.isAuthenticated).toBe(true);
    expect(p.managerStakes).toEqual(['csnorth']);
    expect(p.stakeMemberStakes).toEqual(['csnorth']);
    expect(p.bishopricWards).toEqual({ csnorth: ['CO'] });
  });

  it('flags a platform superadmin even without stake claims', () => {
    const claims: CustomClaims = {
      canonical: 'super@gmail.com',
      isPlatformSuperadmin: true,
    };
    const p = principalFromClaims(claims, 'super@gmail.com');
    expect(p.isAuthenticated).toBe(true);
    expect(p.isPlatformSuperadmin).toBe(true);
    expect(p.managerStakes).toEqual([]);
  });

  it('omits stakes whose ward array is empty from bishopricWards', () => {
    // A stake with manager=true but no ward grants shouldn't pollute
    // bishopricWards with `{stakeId: []}`. Empty entries stay omitted.
    const claims: CustomClaims = {
      canonical: 'mgr@gmail.com',
      stakes: { csnorth: { manager: true, stake: false, wards: [] } },
    };
    const p = principalFromClaims(claims, 'mgr@gmail.com');
    expect(p.bishopricWards).toEqual({});
  });

  it('preserves multi-stake structure', () => {
    const claims: CustomClaims = {
      canonical: 'multi@gmail.com',
      stakes: {
        csnorth: { manager: true, stake: false, wards: [] },
        someother: { manager: false, stake: false, wards: ['LK'] },
      },
    };
    const p = principalFromClaims(claims, 'multi@gmail.com');
    expect(p.managerStakes).toEqual(['csnorth']);
    expect(p.bishopricWards).toEqual({ someother: ['LK'] });
  });

  it('survives malformed stake-claim entries by treating them as no-role', () => {
    // Defense-in-depth: claims come from a network token; a wrong shape
    // shouldn't crash the SPA. Coerce to all-false/empty.
    const claims = {
      canonical: 'broken@gmail.com',
      stakes: {
        csnorth: 'not an object' as unknown,
      },
    } as unknown as CustomClaims;
    const p = principalFromClaims(claims, 'broken@gmail.com');
    expect(p.isAuthenticated).toBe(false);
    expect(p.managerStakes).toEqual([]);
  });
});
