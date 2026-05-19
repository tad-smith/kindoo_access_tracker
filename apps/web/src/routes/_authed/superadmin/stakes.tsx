// Superadmin Stake List route. Thin wrapper — the page component does
// the work. Gated strictly on `principal.isPlatformSuperadmin`; a
// manager who is not also a superadmin is redirected by
// `useRequireRole`.

import { createFileRoute } from '@tanstack/react-router';
import { SuperadminStakeListPage } from '../../../features/superadmin/StakeListPage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

export const Route = createFileRoute('/_authed/superadmin/stakes')({
  component: SuperadminStakesRoute,
});

function SuperadminStakesRoute() {
  const { ready, allowed } = useRequireRole('platformSuperadmin');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <SuperadminStakeListPage />;
}
