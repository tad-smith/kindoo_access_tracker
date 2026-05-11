// Bishopric Roster route. Thin wrapper — search-param parsing lives
// here; behaviour lives in `features/bishopric/RosterPage.tsx`.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { BishopricRosterPage } from '../../../features/bishopric/RosterPage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

const searchSchema = z.object({
  ward: z.string().optional(),
});

export const Route = createFileRoute('/_authed/bishopric/roster')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: BishopricRosterRoute,
});

function BishopricRosterRoute() {
  const { ready, allowed } = useRequireRole('bishopric');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <BishopricRosterContent />;
}

function BishopricRosterContent() {
  const { ward } = Route.useSearch();
  return <BishopricRosterPage {...(ward !== undefined ? { initialWard: ward } : {})} />;
}
