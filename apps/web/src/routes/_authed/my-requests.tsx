// Cross-role MyRequests route. The bishopric / stake / manager nav
// links all point here; the page renders the signed-in user's
// requests with the in-page scope filter (per `spec.md` §5.1).

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { MyRequestsPage } from '../../features/myRequests/MyRequestsPage';

// `stake` is consumed by `useActiveStake` so multi-stake users land on
// the right stake from a deep link. Declared on the schema so TanStack
// Router preserves it through navigations instead of stripping unknowns.
const searchSchema = z.object({
  stake: z.string().optional(),
});

export const Route = createFileRoute('/_authed/my-requests')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: MyRequestsPage,
});
