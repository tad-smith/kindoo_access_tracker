// Cross-role MyRequests route. The bishopric / stake / manager nav
// links all point here; the page renders the signed-in user's
// requests with the in-page scope filter (per `spec.md` §5.1).

import { createFileRoute } from '@tanstack/react-router';
import { MyRequestsPage } from '../../features/myRequests/MyRequestsPage';

export const Route = createFileRoute('/_authed/my-requests')({
  component: MyRequestsPage,
});
