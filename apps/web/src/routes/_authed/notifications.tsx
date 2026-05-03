// Notifications route. Manager-only for-now; the page component is
// role-agnostic so future expansion (Phase 9 push for completed /
// rejected / cancelled requests visible to bishopric + stake users)
// only needs the gate below relaxed.
//
// Loading-window guard: `usePrincipal()` is component-scoped state.
// On a fresh mount inside an `_authed` child route, claims start
// `null` and the derived `Principal` looks identical to a no-role
// user (`isAuthenticated === false`, `managerStakes === []`,
// `canonical === ''`). Claims arrive ~one render later when the
// hook's `useEffect` resolves `getIdTokenResult()`. Redirecting
// during that window kicks managers off the page just as they land.
//
// We're already past the `_authed` gate, which only renders this
// Outlet when `principal.isAuthenticated === true`. So inside this
// route, the combination `firebaseAuthSignedIn && !isAuthenticated`
// is the unambiguous "claims still loading" sentinel — a real
// no-role user would have hit `NotAuthorizedPage` upstream.

import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { NotificationsPage } from '../../features/notifications/pages/NotificationsPage';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { usePrincipal } from '../../lib/principal';
import { STAKE_ID } from '../../lib/constants';

export const Route = createFileRoute('/_authed/notifications')({
  component: NotificationsRoute,
});

function NotificationsRoute() {
  const principal = usePrincipal();
  const navigate = useNavigate();

  const claimsLoading = principal.firebaseAuthSignedIn && !principal.isAuthenticated;
  const isManager = principal.isPlatformSuperadmin || principal.managerStakes.includes(STAKE_ID);

  useEffect(() => {
    if (claimsLoading) return;
    if (!isManager) {
      navigate({ to: '/', replace: true }).catch(() => {});
    }
  }, [claimsLoading, isManager, navigate]);

  if (claimsLoading) return <LoadingSpinner />;
  if (!isManager) return null;
  return <NotificationsPage />;
}
