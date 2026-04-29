// Stake Ward Rosters route. Search params validate `?ward=<code>` so a
// deep-link pre-selects the ward.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { WardRostersPage } from '../../../features/stake/WardRostersPage';

const searchSchema = z.object({
  ward: z.string().optional(),
});

export const Route = createFileRoute('/_authed/stake/wards')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: WardRostersRoute,
});

function WardRostersRoute() {
  const { ward } = Route.useSearch();
  return <WardRostersPage {...(ward !== undefined ? { initialWard: ward } : {})} />;
}
