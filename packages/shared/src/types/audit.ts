// `AuditLog` and `PlatformAuditLog` rows. Per
// `docs/firebase-schema.md` §4.10 and §3.3. The `auditTrigger` Cloud
// Function writes one row per audited write; the doc ID is
// `<ISO-timestamp>_<uuid-suffix>` (see `auditId.ts`) so reverse-lex
// order yields newest-first reads.

import type { TimestampLike } from './userIndex.js';

/** All audit-log actions, per-stake. */
export type AuditAction =
  // Seats
  | 'create_seat'
  | 'update_seat'
  | 'delete_seat'
  | 'auto_expire'
  // Access
  | 'create_access'
  | 'update_access'
  | 'delete_access'
  // Requests
  | 'create_request'
  | 'submit_request'
  | 'complete_request'
  | 'reject_request'
  | 'cancel_request'
  // Managers
  | 'create_manager'
  | 'update_manager'
  | 'delete_manager'
  // Stake parent
  | 'update_stake'
  | 'setup_complete'
  // System (importer / over-cap / email; no underlying entity write)
  | 'import_start'
  | 'import_end'
  | 'over_cap_warning'
  | 'email_send_failed';

/** Entity classes the audit log covers per stake. */
export type AuditEntityType = 'seat' | 'request' | 'access' | 'kindooManager' | 'stake' | 'system';

/** `stakes/{stakeId}/auditLog/{auditId}` row — see §4.10. */
export type AuditLog = {
  /** `= doc.id`. `<ISO-timestamp>_<uuid-suffix>`. */
  audit_id: string;
  timestamp: TimestampLike;
  /** `'Importer'`, `'ExpiryTrigger'`, or a typed user email. */
  actor_email: string;
  /** Canonical form of `actor_email`. Same string for the synthetic actors. */
  actor_canonical: string;

  action: AuditAction;
  entity_type: AuditEntityType;
  /** Canonical email for seat/access/manager; UUID for request; stake_id for stake. */
  entity_id: string;
  /** Denorm — the user this row's underlying doc is *about*. Absent for `entity_type='system'`. */
  member_canonical?: string;

  before: object | null;
  after: object | null;

  /** 365 days from write time. Firestore TTL deletes ~24h after this passes. */
  ttl: TimestampLike;
};

/** Cross-stake actions the platform-superadmin track records. */
export type PlatformAuditAction = 'create_stake' | 'add_superadmin' | 'remove_superadmin';

/** `platformAuditLog/{auditId}` row — see §3.3. */
export type PlatformAuditLog = {
  timestamp: TimestampLike;
  /** Typed display email of the superadmin actor. */
  actor_email: string;
  /** Canonical form of `actor_email`. */
  actor_canonical: string;
  action: PlatformAuditAction;
  entity_type: 'stake' | 'platformSuperadmin';
  entity_id: string;
  before: object | null;
  after: object | null;
  ttl: TimestampLike;
};
