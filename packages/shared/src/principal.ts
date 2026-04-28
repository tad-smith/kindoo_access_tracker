// `principalFromClaims` — derives the SPA-facing `Principal` shape
// from the auth token's `CustomClaims` and the Firebase Auth user
// object. Pure; no SDK calls. Lives here (not in `apps/web/`) so the
// claim-sync triggers' tests in `functions/` can reuse the same
// derivation when constructing fixture principals for assertions.
//
// Inputs:
//   - `claims`: the decoded custom-claims payload as written by the
//     sync triggers. May be `null` for an anonymous / signed-out
//     principal, or for a signed-in user whose claims haven't been
//     stamped yet (first sign-in race; the trigger writes claims
//     post-create, the SDK refreshes on the next call).
//   - `typedEmail`: the email string the Firebase Auth user object
//     carries. Claims hold the canonical form; the UI wants the typed
//     form for display. Pass the `email` field from the user record.
//
// Output:
//   A fully-populated `Principal` with `isAuthenticated` reflecting
//   whether the user has *any* role at all — a signed-in user who
//   resolves to no role lands on the NotAuthorized page.

import type { CustomClaims, Principal, StakeClaims } from './types/auth.js';

/**
 * Compute the {@link Principal} shape from a custom-claims payload + the
 * typed email of the signed-in Firebase Auth user.
 *
 * Returns an unauthenticated principal (all flags false / arrays empty)
 * when `claims` is null OR when the user has no claims at all (no
 * superadmin flag, no stake claims).
 */
export function principalFromClaims(
  claims: CustomClaims | null | undefined,
  typedEmail: string | null | undefined,
): Principal {
  const email = typedEmail ?? '';

  if (!claims || typeof claims.canonical !== 'string' || claims.canonical === '') {
    return emptyPrincipal(email);
  }

  const isPlatformSuperadmin = claims.isPlatformSuperadmin === true;

  const managerStakes: string[] = [];
  const stakeMemberStakes: string[] = [];
  const bishopricWards: Record<string, string[]> = {};

  if (claims.stakes) {
    for (const [stakeId, stake] of Object.entries(claims.stakes)) {
      const s = normaliseStakeClaims(stake);
      if (s.manager) managerStakes.push(stakeId);
      if (s.stake) stakeMemberStakes.push(stakeId);
      if (s.wards.length > 0) bishopricWards[stakeId] = [...s.wards];
    }
  }

  const hasAnyRole =
    isPlatformSuperadmin ||
    managerStakes.length > 0 ||
    stakeMemberStakes.length > 0 ||
    Object.keys(bishopricWards).length > 0;

  return {
    email,
    canonical: claims.canonical,
    isAuthenticated: hasAnyRole,
    isPlatformSuperadmin,
    managerStakes,
    stakeMemberStakes,
    bishopricWards,
  };
}

function emptyPrincipal(email: string): Principal {
  return {
    email,
    canonical: '',
    isAuthenticated: false,
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
  };
}

function normaliseStakeClaims(raw: unknown): StakeClaims {
  if (!raw || typeof raw !== 'object') {
    return { manager: false, stake: false, wards: [] };
  }
  const r = raw as Partial<StakeClaims>;
  return {
    manager: r.manager === true,
    stake: r.stake === true,
    wards: Array.isArray(r.wards) ? r.wards.filter((w): w is string => typeof w === 'string') : [],
  };
}
