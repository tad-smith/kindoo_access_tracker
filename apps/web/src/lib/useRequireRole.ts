// `useRequireRole(role, options?)` — shared per-route role gate.
//
// Every role-gated route inside the `_authed` group calls this hook to
// guard its render: callers receive `{ ready, allowed }` and decide
// whether to render the page, a loading spinner, or nothing (while a
// redirect lands).
//
// Three states it disambiguates, in order:
//
//   1. Principal still loading. `usePrincipal()` is component-scoped
//      state; on a fresh mount inside an `_authed` child route, claims
//      start `null` and the derived `Principal` looks identical to a
//      no-role user (`isAuthenticated === false`). Past the upstream
//      `_authed` gate, the combination `firebaseAuthSignedIn &&
//      !isAuthenticated` is the unambiguous "claims still loading"
//      sentinel — a real no-role user would have hit
//      `NotAuthorizedPage` upstream. Returns `{ ready: false,
//      allowed: false }`; caller renders a loading spinner. We do NOT
//      redirect during this window, because doing so kicks managers
//      off the page just as they land.
//
//   2. Principal loaded and holds at least one of the required roles.
//      Returns `{ ready: true, allowed: true }`; caller renders the
//      page.
//
//   3. Principal loaded and lacks every required role. Calls
//      `navigate({ to: redirectTo, replace: true })` once and returns
//      `{ ready: true, allowed: false }`. `replace: true` keeps the
//      not-allowed URL out of history. Caller renders `null` while the
//      navigation lands.
//
// Roles are evaluated against `STAKE_ID` (the v1 single-stake constant
// from `lib/constants.ts`); `'platformSuperadmin'` is the only role
// that doesn't take a stake parameter. Pass an array for either-of
// semantics: `useRequireRole(['manager', 'platformSuperadmin'])`
// allows users who hold either role.
//
// The setup-complete gate in `routes/_authed.tsx` runs first; this
// hook only fires inside an already-authed Outlet. A stake mid-setup
// renders `SetupInProgressPage` upstream and this hook never gets a
// chance to redirect.

import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { usePrincipal, type Principal } from './principal';
import { STAKE_ID } from './constants';

/**
 * Role identifiers accepted by {@link useRequireRole}. `'manager'`,
 * `'bishopric'`, `'stake'` are evaluated against `STAKE_ID`;
 * `'platformSuperadmin'` is the global flag.
 */
export type RequiredRole = 'manager' | 'bishopric' | 'stake' | 'platformSuperadmin';

export interface RequireRoleOptions {
  /**
   * Where to redirect a principal that lacks every required role.
   * Defaults to `/`, which routes through the index page's role-default
   * landing logic (`defaultLandingFor`).
   */
  redirectTo?: string;
}

export interface RequireRoleResult {
  /**
   * `false` while `usePrincipal()` is still resolving claims; `true`
   * once the principal is settled (regardless of whether it has the
   * required role). Callers render a loading affordance while
   * `ready === false`.
   */
  ready: boolean;
  /**
   * `true` iff `ready === true` AND the principal holds at least one of
   * the required roles. When `false` and `ready === true`, the hook has
   * already triggered a redirect — caller renders `null` while it lands.
   */
  allowed: boolean;
}

/**
 * Guard a role-gated route. See module header for the full state
 * machine. Apply at the top of every role-gated page component; the
 * shape is always:
 *
 * ```tsx
 * const { ready, allowed } = useRequireRole('manager');
 * if (!ready) return <LoadingSpinner />;
 * if (!allowed) return null;
 * // ... rest of the page
 * ```
 */
export function useRequireRole(
  role: RequiredRole | RequiredRole[],
  options?: RequireRoleOptions,
): RequireRoleResult {
  const principal = usePrincipal();
  const navigate = useNavigate();

  const claimsLoading = principal.firebaseAuthSignedIn && !principal.isAuthenticated;
  const required = Array.isArray(role) ? role : [role];
  const allowed = !claimsLoading && holdsAnyRole(principal, required);
  const redirectTo = options?.redirectTo ?? '/';

  useEffect(() => {
    if (claimsLoading) return;
    if (allowed) return;
    navigate({ to: redirectTo, replace: true }).catch(() => {});
  }, [claimsLoading, allowed, navigate, redirectTo]);

  if (claimsLoading) {
    return { ready: false, allowed: false };
  }
  return { ready: true, allowed };
}

/**
 * Pure predicate: does the principal hold at least one of the named
 * roles in `STAKE_ID`? `platformSuperadmin` is the only stake-agnostic
 * axis.
 *
 * Exported for unit testing — components use {@link useRequireRole}.
 */
export function holdsAnyRole(principal: Principal, roles: RequiredRole[]): boolean {
  if (principal.isPlatformSuperadmin) return true;
  for (const r of roles) {
    if (r === 'platformSuperadmin') {
      // Already handled above; falsy unless `isPlatformSuperadmin`.
      continue;
    }
    if (r === 'manager' && principal.managerStakes.includes(STAKE_ID)) return true;
    if (r === 'stake' && principal.stakeMemberStakes.includes(STAKE_ID)) return true;
    if (r === 'bishopric') {
      const wards = principal.bishopricWards[STAKE_ID];
      if (Array.isArray(wards) && wards.length > 0) return true;
    }
  }
  return false;
}
