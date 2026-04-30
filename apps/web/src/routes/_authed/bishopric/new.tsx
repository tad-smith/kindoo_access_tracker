// Bishopric "New Kindoo Request" route. Thin wrapper.

import { createFileRoute } from '@tanstack/react-router';
import { NewRequestPage } from '../../../features/requests/pages/NewRequestPage';

export const Route = createFileRoute('/_authed/bishopric/new')({
  component: () => <NewRequestPage role="bishopric" />,
});
