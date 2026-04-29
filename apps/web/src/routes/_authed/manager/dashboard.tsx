// Manager Dashboard route. Thin wrapper.

import { createFileRoute } from '@tanstack/react-router';
import { ManagerDashboardPage } from '../../../features/manager/dashboard/DashboardPage';

export const Route = createFileRoute('/_authed/manager/dashboard')({
  component: ManagerDashboardPage,
});
