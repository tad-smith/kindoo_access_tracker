// Manager Dashboard route. Thin wrapper.

import { createFileRoute } from '@tanstack/react-router';
import { ManagerDashboardPage } from '../../../features/manager/dashboard/DashboardPage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

export const Route = createFileRoute('/_authed/manager/dashboard')({
  component: DashboardRoute,
});

function DashboardRoute() {
  const { ready, allowed } = useRequireRole('manager');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <ManagerDashboardPage />;
}
