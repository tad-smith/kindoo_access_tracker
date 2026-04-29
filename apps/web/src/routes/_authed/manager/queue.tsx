// Manager Requests Queue route. Thin wrapper.

import { createFileRoute } from '@tanstack/react-router';
import { ManagerQueuePage } from '../../../features/manager/queue/QueuePage';

export const Route = createFileRoute('/_authed/manager/queue')({
  component: ManagerQueuePage,
});
