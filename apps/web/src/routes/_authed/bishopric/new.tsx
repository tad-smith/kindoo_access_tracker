// Legacy redirect. The "New Request" form moved to `/new` in
// Phase 10.1; this route stays alive so external bookmarks /
// audit-log links / future email templates that reference
// `/bishopric/new` keep working.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authed/bishopric/new')({
  beforeLoad: () => {
    throw redirect({ to: '/new', replace: true });
  },
});
