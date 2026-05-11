// Manager Import route. Phase 7 wires the UI; Phase 8 wires the
// `runImportNow` callable.

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
