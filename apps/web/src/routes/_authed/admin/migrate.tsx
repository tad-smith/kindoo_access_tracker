// One-shot admin migration route. Manager-gated, direct-URL only — no
// nav link. See `features/manager/migrate/MigratePage.tsx`.

import { createFileRoute } from '@tanstack/react-router';
import { MigratePage } from '../../../features/manager/migrate/MigratePage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

export const Route = createFileRoute('/_authed/admin/migrate')({
  component: MigrateRoute,
});

function MigrateRoute() {
  const { ready, allowed } = useRequireRole('manager');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <MigratePage />;
}
