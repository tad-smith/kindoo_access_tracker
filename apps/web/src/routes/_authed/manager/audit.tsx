// Manager Audit Log route. Search params validate every filter so a
// deep-link (e.g. `?entity_id=alice@x.com`) lands with the filter
// pre-applied.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AuditLogPage } from '../../../features/manager/auditLog/AuditLogPage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

const searchSchema = z.object({
  action: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  actor_canonical: z.string().optional(),
  member_canonical: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  stake: z.string().optional(),
});

export const Route = createFileRoute('/_authed/manager/audit')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: AuditLogRoute,
});

function AuditLogRoute() {
  const { ready, allowed } = useRequireRole('manager');
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <AuditLogContent />;
}

// Explicit allowlist of which search-schema fields are audit filters.
// `stake` (and any future cross-cutting param) lives on the schema for
// TanStack Router preservation but is NOT forwarded to AuditLogPage as
// a filter.
const AUDIT_FILTER_KEYS = [
  'action',
  'entity_type',
  'entity_id',
  'actor_canonical',
  'member_canonical',
  'date_from',
  'date_to',
] as const;

function AuditLogContent() {
  const search = Route.useSearch();
  const initialFilters = Object.fromEntries(
    AUDIT_FILTER_KEYS.flatMap((k) => {
      const v = search[k];
      return v !== undefined ? [[k, v]] : [];
    }),
  );
  return <AuditLogPage initialFilters={initialFilters} />;
}
