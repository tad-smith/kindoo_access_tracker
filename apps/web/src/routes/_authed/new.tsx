// Single "New Request" route. Replaces `/bishopric/new` and
// `/stake/new`; the old paths redirect here so external links keep
// working.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { NewRequestPage } from '../../features/requests/pages/NewRequestPage';

// `stake` is consumed by `useActiveStake` so multi-stake users land on
// the right stake from a deep link. Declared on the schema so TanStack
// Router preserves it through navigations instead of stripping unknowns.
const searchSchema = z.object({
  stake: z.string().optional(),
});

export const Route = createFileRoute('/_authed/new')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: NewRequestPage,
});
