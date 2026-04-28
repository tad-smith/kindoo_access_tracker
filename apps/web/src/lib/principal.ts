// `usePrincipal()` — the only sanctioned way to read the signed-in
// user's identity + role claims inside React components.
//
// Decodes Firebase Auth custom claims (set by Cloud Function triggers
// on role-data writes; see `docs/firebase-schema.md` §2) into a typed
// `Principal` shape that mirrors the spec's role union model
// (`docs/spec.md` §4 lineage):
//   - Kindoo Manager: `stakes[sid].manager === true`
//   - Stake member: `stakes[sid].stake === true`
//   - Bishopric (per-ward): `stakes[sid].wards: string[]`
//   - Platform superadmin: top-level `isPlatformSuperadmin === true`
//
// A user can hold any combination; the hook returns each axis
// separately so callers can compose role-gated UI per the spec.
//
// Type contract + pure derivation come from `@kindoo/shared` so the
// claim-sync triggers in `functions/` use exactly the same shape and
// the same derivation logic. The web wrapper adds:
//   - `firebaseAuthSignedIn`: distinguishes "signed in to Firebase Auth
//     but has no roles" (→ NotAuthorizedPage) from "not signed in at
//     all" (→ SignInPage). The shared `isAuthenticated` flag folds
//     "has any role" into "is authenticated" because the trigger
//     authoritatively gates app access on roles; the SPA needs the
//     finer distinction to choose between the two failure pages.
//   - `hasAnyRole(stakeId)` / `wardsInStake(stakeId)`: route-guard
//     conveniences so callers don't repeat the per-stake walk.
//
// The pure derivation `principalFromClaims` lives alongside in
// `principal-derive.ts` so unit tests can exercise it without pulling
// the Firebase SDK init module into the import graph.
//
// Phase 3.5 (D11): replaced reactfire's `useUser()` with a direct
// `onAuthStateChanged` subscription against the `auth` SDK singleton.
// Same data, no provider stack required.

import { onAuthStateChanged, type User } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { useTokenRefresh } from '../features/auth/useTokenRefresh';
import { auth } from './firebase';
import type { CustomClaims, Principal } from './principal-derive';
import { principalFromClaims } from './principal-derive';

export type { CustomClaims, Principal };
export { principalFromClaims };

/**
 * `usePrincipal()` — read the current user's role union from custom
 * claims. Re-renders on token rotation (sign-in, sign-out, hourly
 * refresh, server-side claim updates).
 */
export function usePrincipal(): Principal {
  // Mirror the `auth.currentUser` SDK signal. `auth.currentUser` is
  // synchronous-readable but not reactive; `onAuthStateChanged` is
  // the change feed. We seed initial state from `auth.currentUser` so
  // a mount during a steady-signed-in session doesn't flicker through
  // a transient signed-out frame.
  const [user, setUser] = useState<User | null>(auth.currentUser);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (next) => {
      setUser(next);
    });
    return unsubscribe;
  }, []);

  // Bump on token rotation so the effect below re-fires and pulls fresh claims.
  const tick = useTokenRefresh();
  const [claims, setClaims] = useState<CustomClaims | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setClaims(null);
      return () => {
        cancelled = true;
      };
    }
    // `getIdTokenResult()` decodes claims from the *current* (cached)
    // token; we manage it directly so the `useTokenRefresh` tick can
    // force a re-read after a server-side claim update.
    user
      .getIdTokenResult()
      .then((result) => {
        if (cancelled) return;
        setClaims(result.claims as unknown as CustomClaims);
      })
      .catch(() => {
        if (cancelled) return;
        setClaims(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user, tick]);

  return principalFromClaims(user, claims);
}
