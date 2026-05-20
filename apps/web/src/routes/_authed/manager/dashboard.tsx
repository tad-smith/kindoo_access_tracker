// Manager Dashboard route. Thin wrapper.
//
// `?stake=X` deep-link param: read once by `useActiveStake()` on first
// render (via the global router-state subscription), persisted to
// session + local storage, then stripped via `history.replaceState`.
// The Stake List page links here with the param to enter a target
// stake.

import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { ManagerDashboardPage } from '../../../features/manager/dashboard/DashboardPage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

const dashboardSearchSchema = z.object({
  stake: z.string().optional(),
});

type DashboardSearch = z.infer<typeof dashboardSearchSchema>;

export const Route = createFileRoute('/_authed/manager/dashboard')({
  validateSearch: (raw): DashboardSearch => dashboardSearchSchema.parse(raw),
  component: DashboardRoute,
});

function DashboardRoute() {
  const { ready, allowed } = useRequireRole('manager');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <ManagerDashboardPage />;
}
