// Manager Requests Queue route. The `focus` search param carries a
// request_id from a tapped push notification's deep-link; the page
// scrolls + highlights that card on first render, then strips the
// param so back-forward and reloads do not re-trigger.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ManagerQueuePage } from '../../../features/manager/queue/QueuePage';

const searchSchema = z.object({
  focus: z.string().optional(),
});

export const Route = createFileRoute('/_authed/manager/queue')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: QueueRoute,
});

function QueueRoute() {
  const { focus } = Route.useSearch();
  return <ManagerQueuePage {...(focus !== undefined ? { focus } : {})} />;
}
