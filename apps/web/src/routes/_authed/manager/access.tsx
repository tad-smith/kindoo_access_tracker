// Manager Access route. Phase 5 read-only; Phase 7 wires writes.

import { createFileRoute } from '@tanstack/react-router';
import { AccessPage } from '../../../features/manager/access/AccessPage';

export const Route = createFileRoute('/_authed/manager/access')({
  component: AccessPage,
});
