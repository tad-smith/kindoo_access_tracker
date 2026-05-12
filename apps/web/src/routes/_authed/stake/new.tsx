// Legacy redirect. The "New Request" form lives at `/new`; this
// route stays alive so external bookmarks / audit-log links / email
// templates that reference `/stake/new` keep working.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authed/stake/new')({
  beforeLoad: () => {
    throw redirect({ to: '/new', replace: true });
  },
});
