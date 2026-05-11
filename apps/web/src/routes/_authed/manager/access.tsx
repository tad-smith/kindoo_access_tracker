// Manager Access route. Phase 5 read-only; Phase 7 wires writes.

import { createFileRoute } from '@tanstack/react-router';
import { AccessPage } from '../../../features/manager/access/AccessPage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

export const Route = createFileRoute('/_authed/manager/access')({
  component: AccessRoute,
});

function AccessRoute() {
  const { ready, allowed } = useRequireRole('manager');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <AccessPage />;
}
