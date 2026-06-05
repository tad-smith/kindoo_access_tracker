// Single "New Request" route. Replaces `/bishopric/new` and
// `/stake/new`; the old paths redirect here so external links keep
// working.
//
// `?scope=<stake|wardCode>` pre-selects the scope dropdown. Roster
// pages link here with the scope they're showing; the form ignores the
// value unless it matches one of the principal's allowed scopes.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { NewRequestPage } from '../../features/requests/pages/NewRequestPage';

const searchSchema = z.object({
  scope: z.string().optional(),
});

export const Route = createFileRoute('/_authed/new')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: NewRequestRoute,
});

function NewRequestRoute() {
  const { scope } = Route.useSearch();
  return <NewRequestPage {...(scope !== undefined ? { initialScope: scope } : {})} />;
}
