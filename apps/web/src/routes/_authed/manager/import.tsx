// Manager Import route.

import { createFileRoute } from '@tanstack/react-router';
import { ImportPage } from '../../../features/manager/import/ImportPage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

export const Route = createFileRoute('/_authed/manager/import')({
  component: ImportRoute,
});

function ImportRoute() {
  const { ready, allowed } = useRequireRole('manager');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <ImportPage />;
}
