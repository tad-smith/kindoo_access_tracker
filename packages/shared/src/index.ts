// Public surface of @kindoo/shared. Both apps/web/ and functions/ import
// from here. Phase 1 shipped canonical-email helpers; Phase 2 added the
// auth surface (claims, principal, userIndex bridge); Phase 3 adds the
// per-stake domain types + zod schemas, plus the `auditId` and
// `buildingSlug` helpers.

// ---- Pure helpers -----------------------------------------------------
export { auditId } from './auditId.js';
export { BOOKKEEPING_FIELDS } from './auditBookkeepingFields.js';
export { buildingSlug } from './buildingSlug.js';
export { canonicalEmail, emailsEqual } from './canonicalEmail.js';
export { principalFromClaims } from './principal.js';

// ---- Domain types -----------------------------------------------------
export type {
  Access,
  AccessRequest,
  ActorRef,
  AuditAction,
  AuditEntityType,
  AuditLog,
  Building,
  CallingTemplate,
  CustomClaims,
  DuplicateGrant,
  ImportDay,
  ImportSummary,
  KindooManager,
  ManualGrant,
  OverCapEntry,
  PlatformAuditAction,
  PlatformAuditLog,
  PlatformSuperadmin,
  Principal,
  RequestStatus,
  RequestType,
  Seat,
  SeatType,
  Stake,
  StakeCallingTemplate,
  StakeClaims,
  TimestampLike,
  UserIndexEntry,
  Ward,
  WardCallingTemplate,
} from './types/index.js';

// ---- Zod schemas ------------------------------------------------------
export {
  accessRequestSchema,
  accessSchema,
  actorRefSchema,
  auditActionSchema,
  auditEntityTypeSchema,
  auditLogSchema,
  buildingSchema,
  callingTemplateSchema,
  duplicateGrantSchema,
  importDaySchema,
  kindooManagerSchema,
  manualGrantSchema,
  overCapEntrySchema,
  platformAuditActionSchema,
  platformAuditLogSchema,
  platformSuperadminSchema,
  requestStatusSchema,
  requestTypeSchema,
  seatSchema,
  seatTypeSchema,
  stakeCallingTemplateSchema,
  stakeSchema,
  timestampLikeSchema,
  userIndexEntrySchema,
  wardCallingTemplateSchema,
  wardSchema,
} from './schemas/index.js';
