// Notifications route. Manager-only for-now; the page component is
// role-agnostic so future expansion (Phase 9 push for completed /
// rejected / cancelled requests visible to bishopric + stake users)
// only needs the gate below relaxed.

import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { NotificationsPage } from '../../features/notifications/pages/NotificationsPage';
import { usePrincipal } from '../../lib/principal';
import { STAKE_ID } from '../../lib/constants';

export const Route = createFileRoute('/_authed/notifications')({
  component: NotificationsRoute,
});

function NotificationsRoute() {
  const principal = usePrincipal();
  const navigate = useNavigate();
  const isManager = principal.isPlatformSuperadmin || principal.managerStakes.includes(STAKE_ID);

  useEffect(() => {
    if (!isManager) {
      navigate({ to: '/', replace: true }).catch(() => {});
    }
  }, [isManager, navigate]);

  if (!isManager) return null;
  return <NotificationsPage />;
}
