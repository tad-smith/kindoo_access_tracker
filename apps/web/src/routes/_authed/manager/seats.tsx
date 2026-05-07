// Manager All Seats route. Search params validate `?ward=&building=&type=`.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AllSeatsPage } from '../../../features/manager/allSeats/AllSeatsPage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

const searchSchema = z.object({
  ward: z.string().optional(),
  building: z.string().optional(),
  type: z.enum(['auto', 'manual', 'temp']).optional(),
});

export const Route = createFileRoute('/_authed/manager/seats')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: AllSeatsRoute,
});

function AllSeatsRoute() {
  const { ready, allowed } = useRequireRole('manager');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <AllSeatsContent />;
}

function AllSeatsContent() {
  const { ward, building, type } = Route.useSearch();
  return (
    <AllSeatsPage
      {...(ward !== undefined ? { initialWard: ward } : {})}
      {...(building !== undefined ? { initialBuilding: building } : {})}
      {...(type !== undefined ? { initialType: type } : {})}
    />
  );
}
