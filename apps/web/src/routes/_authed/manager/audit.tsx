// Manager Audit Log route. Search params validate every filter so a
// deep-link (e.g. `?entity_id=alice@x.com`) lands with the filter
// pre-applied.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AuditLogPage } from '../../../features/manager/auditLog/AuditLogPage';

const searchSchema = z.object({
  action: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  actor_canonical: z.string().optional(),
  member_canonical: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

export const Route = createFileRoute('/_authed/manager/audit')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: AuditLogRoute,
});

function AuditLogRoute() {
  const search = Route.useSearch();
  const initialFilters = Object.fromEntries(
    Object.entries(search).filter(([, v]) => v !== undefined),
  );
  return <AuditLogPage initialFilters={initialFilters} />;
}
