// `AuditLog` and `PlatformAuditLog` rows. Per
// `docs/firebase-schema.md` §4.10 and §3.3. The `auditTrigger` Cloud
// Function writes one row per audited write; the doc ID is
// `<ISO-timestamp>_<uuid-suffix>` (see `auditId.ts`) so reverse-lex
// order yields newest-first reads.

import type { TimestampLike } from './userIndex.js';

/**
 * Retention window stamped onto every `auditLog` row's `ttl`: 5 years.
 * The only definition — the audit trigger, the `email_send_failed`
 * writer, and the `backfillAuditTtl` callable all read it from here.
 * Firestore's TTL policy on the `ttl` field does the deleting.
 *
 * Leap days are ignored: day-level precision is irrelevant to a
 * retention window.
 *
 * `platformAuditLog` deliberately stamps no `ttl` at all — see
 * {@link PlatformAuditLog}.
 */
export const AUDIT_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** All audit-log actions, per-stake. */
export type AuditAction =
  // Seats
  | 'create_seat'
  | 'update_seat'
  | 'delete_seat'
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
  | 'create_stake'
  | 'update_stake'
  | 'setup_complete'
  // System (email failure; no underlying entity write).
  // `import_start`, `import_end`, and `over_cap_warning` are legacy:
  // pre-T-45 audit rows still carry them. The renderer keeps the
  // literals in its filter palette for historical lookup; no fresh
  // writes produce them.
  | 'import_start'
  | 'import_end'
  | 'over_cap_warning'
  | 'email_send_failed'
  // One-shot migration (T-42)
  | 'migration_backfill_kindoo_site_id';

/** Entity classes the audit log covers per stake. */
export type AuditEntityType = 'seat' | 'request' | 'access' | 'kindooManager' | 'stake' | 'system';

/** `stakes/{stakeId}/auditLog/{auditId}` row — see §4.10. */
export type AuditLog = {
  /** `= doc.id`. `<ISO-timestamp>_<uuid-suffix>`. */
  audit_id: string;
  timestamp: TimestampLike;
  /** `'RemoveTrigger'`, `'OutOfBand'`, `'Migration'`, a
   * `'SyncActor:<code>'` stamp, or a typed user email. Legacy
   * `'Importer'` survives on pre-T-45 rows. */
  actor_email: string;
  /** Canonical form of `actor_email`. Same string for the synthetic actors. */
  actor_canonical: string;

  action: AuditAction;
  entity_type: AuditEntityType;
  /** Canonical email for seat/access/manager; UUID for request; slug (doc id) for stake. */
  entity_id: string;
  /** Denorm — the user this row's underlying doc is *about*. Absent for `entity_type='system'`. */
  member_canonical?: string;

  before: object | null;
  after: object | null;

  /** `AUDIT_TTL_MS` (5 years) from write time. Firestore TTL deletes ~24h after this passes. */
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
  /**
   * Absent on every row written since T-101 — this collection is
   * deliberately non-expiring, so a later `--enable-ttl` on the
   * `platformAuditLog` collection group cannot silently delete the
   * platform trail. Rows written before T-101 keep a stamped
   * 365-day value; no TTL policy has ever enforced it.
   */
  ttl?: TimestampLike;
};
