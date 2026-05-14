// Public surface of @kindoo/shared. Both apps/web/ and functions/ import
// from here. Exports: canonical-email helpers, the auth surface
// (claims, principal, userIndex bridge), per-stake domain types + zod
// schemas, and the `auditId` / `buildingSlug` helpers.

// ---- Pure helpers -----------------------------------------------------
export { auditId } from './auditId.js';
export { BOOKKEEPING_FIELDS } from './auditBookkeepingFields.js';
export { buildingSlug } from './buildingSlug.js';
export { canonicalEmail, emailsEqual } from './canonicalEmail.js';
export { principalFromClaims } from './principal.js';
export {
  AUTOMATED_ACTOR_NAMES,
  SYNC_ACTOR_PREFIX,
  SYNC_DISCREPANCY_CODES,
  isAutomatedActor,
  parseSyncActorCode,
  syncActorName,
  type AutomatedActorName,
  type SyncDiscrepancyCode,
} from './systemActors.js';

// ---- Domain types -----------------------------------------------------
export type {
  Access,
  AccessRequest,
  ActorRef,
  AuditAction,
  AuditEntityType,
  AuditLog,
  Building,
  BuildingsMismatchPayload,
  CallingTemplate,
  CustomClaims,
  DuplicateGrant,
  ExtraKindooCallingPayload,
  GetMyPendingRequestsInput,
  GetMyPendingRequestsOutput,
  ImportDay,
  ImportSummary,
  KindooManager,
  KindooOnlyPayload,
  ManualGrant,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
  OverCapEntry,
  PlatformAuditAction,
  PlatformAuditLog,
  PlatformSuperadmin,
  Principal,
  RequestStatus,
  RequestType,
  ScopeMismatchPayload,
  Seat,
  SeatType,
  Stake,
  StakeCallingTemplate,
  StakeClaims,
  SyncApplyFixInput,
  SyncApplyFixResult,
  TimestampLike,
  TypeMismatchPayload,
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
