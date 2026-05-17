// `auditLogSchema` and `platformAuditLogSchema` mirror `types/audit.ts`.

import { z } from 'zod';
import { timestampLikeSchema } from './timestampLike.js';

export const auditActionSchema = z.enum([
  'create_seat',
  'update_seat',
  'delete_seat',
  'auto_expire',
  'create_access',
  'update_access',
  'delete_access',
  'create_request',
  'submit_request',
  'complete_request',
  'reject_request',
  'cancel_request',
  'create_manager',
  'update_manager',
  'delete_manager',
  'update_stake',
  'setup_complete',
  'import_start',
  'import_end',
  'over_cap_warning',
  'migration_backfill_kindoo_site_id',
]);

export const auditEntityTypeSchema = z.enum([
  'seat',
  'request',
  'access',
  'kindooManager',
  'stake',
  'system',
]);

const beforeAfterSchema = z.union([z.record(z.string(), z.unknown()), z.null()]);

export const auditLogSchema = z.object({
  audit_id: z.string(),
  timestamp: timestampLikeSchema,
  actor_email: z.string(),
  actor_canonical: z.string(),

  action: auditActionSchema,
  entity_type: auditEntityTypeSchema,
  entity_id: z.string(),
  member_canonical: z.string().optional(),

  before: beforeAfterSchema,
  after: beforeAfterSchema,

  ttl: timestampLikeSchema,
});

export const platformAuditActionSchema = z.enum([
  'create_stake',
  'add_superadmin',
  'remove_superadmin',
]);

export const platformAuditLogSchema = z.object({
  timestamp: timestampLikeSchema,
  actor_email: z.string(),
  actor_canonical: z.string(),
  action: platformAuditActionSchema,
  entity_type: z.enum(['stake', 'platformSuperadmin']),
  entity_id: z.string(),
  before: beforeAfterSchema,
  after: beforeAfterSchema,
  ttl: timestampLikeSchema,
});
