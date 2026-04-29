// Stake "New Kindoo Request" route. Thin wrapper.

import { createFileRoute } from '@tanstack/react-router';
import { NewRequestPage } from '../../../features/requests/pages/NewRequestPage';

export const Route = createFileRoute('/_authed/stake/new')({
  component: () => <NewRequestPage role="stake" />,
});
