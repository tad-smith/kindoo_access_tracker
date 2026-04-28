// Pure derivation behind `usePrincipal()`. Lives in its own module so
// unit tests can import it without triggering the Firebase SDK
// initialisation module (`./firebase.ts`) — `getAuth()` rejects the
// fake API key under the Node platform path, which fires at vitest
// module-load time and blows up the test.
//
// The web-side `Principal` is the shared `Principal` from
// `@kindoo/shared` plus a `firebaseAuthSignedIn` flag and route-guard
// helpers (`hasAnyRole`, `wardsInStake`). See `principal.ts` for the
// full rationale.

import type {
  CustomClaims as SharedCustomClaims,
  Principal as SharedPrincipal,
} from '@kindoo/shared';
import { principalFromClaims as sharedPrincipalFromClaims } from '@kindoo/shared';

export type CustomClaims = SharedCustomClaims;

export type Principal = SharedPrincipal & {
  /**
   * True iff there is a Firebase Auth user (regardless of role claims).
   * Use this to distinguish unauthenticated visitors from authenticated
   * users who happen to have no roles — those land on different pages.
   */
  firebaseAuthSignedIn: boolean;
  /** True if the principal holds any role in the given stake. */
  hasAnyRole: (stakeId: string) => boolean;
  /** Bishopric wards in the given stake; empty array when none. */
  wardsInStake: (stakeId: string) => string[];
};

/**
 * Pure helper: derive a {@link Principal} from a Firebase Auth user-like
 * object plus decoded claims. Exported for unit testing — components
 * should use `usePrincipal()` from `./principal` instead.
 */
export function principalFromClaims(
  user: { email: string | null } | null,
  claims: CustomClaims | null,
): Principal {
  const shared = sharedPrincipalFromClaims(claims, user?.email ?? null);
  return decorate(shared, user !== null);
}

function decorate(shared: SharedPrincipal, firebaseAuthSignedIn: boolean): Principal {
  return {
    ...shared,
    firebaseAuthSignedIn,
    hasAnyRole: (stakeId: string) => {
      if (shared.isPlatformSuperadmin) return true;
      if (shared.managerStakes.includes(stakeId)) return true;
      if (shared.stakeMemberStakes.includes(stakeId)) return true;
      const wards = shared.bishopricWards[stakeId];
      return Array.isArray(wards) && wards.length > 0;
    },
    wardsInStake: (stakeId: string) => {
      const wards = shared.bishopricWards[stakeId];
      return Array.isArray(wards) ? [...wards] : [];
    },
  };
}
