// Public surface of @kindoo/shared. Both apps/web/ and functions/ import
// from here. Exports: canonical-email helpers, the auth surface
// (claims, principal, userIndex bridge), per-stake domain types + zod
// schemas, and the `auditId` / `buildingSlug` helpers.

// ---- Pure helpers -----------------------------------------------------
export {
  STAKE_APP_ACCESS_CALLINGS,
  WARD_APP_ACCESS_CALLINGS,
  appAccessCallingsForScope,
  filterAppAccessCallings,
} from './appAccessCallings.js';
export { auditId } from './auditId.js';
export { BOOKKEEPING_FIELDS } from './auditBookkeepingFields.js';
export { buildingSlug } from './buildingSlug.js';
export { callingSortOrder, seatCallingOrder } from './callingSortOrder.js';
export { canonicalEmail, emailsEqual } from './canonicalEmail.js';
export { principalFromClaims } from './principal.js';
export { resolveWardSite } from './resolveWardSite.js';
export {
  AUTOMATED_ACTOR_NAMES,
  HISTORICAL_SYNC_DISCREPANCY_CODES,
  LEGACY_IMPORTER_ACTOR_NAME,
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
  CallingsMismatchPayload,
  CompletionStatus,
  CreateStakeError,
  CreateStakeInput,
  CreateStakeResult,
  CustomClaims,
  DuplicateGrant,
  GetMyPendingRequestsInput,
  GetMyPendingRequestsOutput,
  KindooManager,
  KindooOnlyPayload,
  KindooSite,
  KindooUnparseablePayload,
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
  SbaOnlyRemovePayload,
  ScopeMismatchPayload,
  Seat,
  SeatType,
  Stake,
  StakeClaims,
  SyncApplyFixInput,
  SyncApplyFixResult,
  TimestampLike,
  TypeMismatchPayload,
  UserIndexEntry,
  Ward,
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
  duplicateGrantSchema,
  kindooManagerSchema,
  kindooSiteSchema,
  manualGrantSchema,
  overCapEntrySchema,
  platformAuditActionSchema,
  platformAuditLogSchema,
  platformSuperadminSchema,
  requestStatusSchema,
  requestTypeSchema,
  seatSchema,
  seatTypeSchema,
  stakeSchema,
  timestampLikeSchema,
  userIndexEntrySchema,
  wardSchema,
} from './schemas/index.js';
