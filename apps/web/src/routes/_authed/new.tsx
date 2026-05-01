// Single "New Request" route. Replaces `/bishopric/new` and
// `/stake/new`; the old paths redirect here so external links keep
// working.

import { createFileRoute } from '@tanstack/react-router';
import { NewRequestPage } from '../../features/requests/pages/NewRequestPage';

export const Route = createFileRoute('/_authed/new')({
  component: NewRequestPage,
});
