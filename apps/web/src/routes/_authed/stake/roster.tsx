// Stake Roster route. Thin wrapper.

import { createFileRoute } from '@tanstack/react-router';
import { StakeRosterPage } from '../../../features/stake/RosterPage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

export const Route = createFileRoute('/_authed/stake/roster')({
  component: StakeRosterRoute,
});

function StakeRosterRoute() {
  const { ready, allowed } = useRequireRole('stake');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <StakeRosterPage />;
}
