// Notifications route. Manager-only for-now; the page component is
// role-agnostic so future expansion (Phase 9 push for completed /
// rejected / cancelled requests visible to bishopric + stake users)
// only needs the gate below relaxed.
//
// The `useRequireRole` hook handles the loading-window race + redirect
// for every role-gated route in the app — see its module header for
// the load-bearing detail (claims-loading sentinel = signed-in but no
// derived role).

import { createFileRoute } from '@tanstack/react-router';
import { NotificationsPage } from '../../features/notifications/pages/NotificationsPage';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { useRequireRole } from '../../lib/useRequireRole';

export const Route = createFileRoute('/_authed/notifications')({
  component: NotificationsRoute,
});

function NotificationsRoute() {
  const { ready, allowed } = useRequireRole('manager');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <NotificationsPage />;
}
