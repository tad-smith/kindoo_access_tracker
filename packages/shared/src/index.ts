// Public surface of @kindoo/shared. Both apps/web/ and functions/ import
// from here. Exports: canonical-email helpers, the auth surface
// (claims, principal, userIndex bridge), per-stake domain types + zod
// schemas, and the `auditId` / `buildingSlug` helpers.

// ---- Pure helpers -----------------------------------------------------
export {
  BRANCH_APP_ACCESS_CALLINGS,
  EQ_PRESIDENT_CALLING,
  LIMITED_TIER_CALLINGS,
  STAKE_APP_ACCESS_CALLINGS,
  WARD_APP_ACCESS_CALLINGS,
  appAccessCallingsForScope,
  filterAppAccessCallings,
  filterLimitedTierCallings,
  type AppAccessOptions,
} from './appAccessCallings.js';
export { auditId } from './auditId.js';
// Lives beside the `ttl` field it stamps, in `types/audit.ts`, so the
// value and its documentation can't drift apart again.
export { AUDIT_TTL_MS } from './types/audit.js';
export { BOOKKEEPING_FIELDS } from './auditBookkeepingFields.js';
export { buildingSlug } from './buildingSlug.js';
export {
  CALLING_ORDER,
  STAKE_CALLING_ORDER,
  UNIT_CALLING_ORDER,
  callingSortOrder,
  seatCallingOrder,
} from './callingSortOrder.js';
export { canonicalEmail, emailsEqual, isGmailAddress } from './canonicalEmail.js';
export {
  addBlockedByExistingSeat,
  existingSeatFacts,
  seatHasStakeGrant,
  type ExistingSeatFacts,
} from './existingSeatGate.js';
export {
  collidesWithOwnWard,
  matchesIgnoredWard,
  normaliseIgnoredWard,
} from './kindooIgnoredWards.js';
export { REQUESTER_GUIDE_PATH } from './links.js';
export { principalFromClaims } from './principal.js';
export {
  REMOTE_APPLY_HEARTBEAT_MS,
  REMOTE_APPLY_HOME_SITE_KEY,
  REMOTE_APPLY_PICKUP_TIMEOUT_MS,
  REMOTE_APPLY_POLL_HIDDEN_MS,
  REMOTE_APPLY_POLL_VISIBLE_MS,
  REMOTE_APPLY_STALE_MS,
  REMOTE_APPLY_TERMINAL_STATUSES,
  canClaimRemoteApplyJob,
  freshRemoteApplyDesktops,
  isRemoteApplyEnabled,
  isRemoteApplyTerminal,
  remoteApplyDesktopForRequest,
  remoteApplySiteKey,
  remoteApplyTargetSiteKey,
} from './remoteApply.js';
export {
  deriveRequesterDisplay,
  formatRequesterLabel,
  type RequesterDisplay,
} from './requesterDisplay.js';
export { buildingNameById, resolveWardBuilding, resolveWardSite } from './resolveWardSite.js';
export {
  MAX_SCHEDULE_ADVANCES,
  SYNC_REMINDER_JOB,
  advanceTriggerTime,
  isKnownSchedule,
  isTaskDue,
  nextTriggerTime,
  type ScheduledTask,
  type StakeSchedule,
  type TaskSchedule,
} from './scheduledTasks.js';
export { scopeLabel } from './scopeLabel.js';
export { sanitizeSlugInput } from './slugInput.js';
export {
  endOfDayInStakeTz,
  formatDateInStakeTz,
  formatDateTimeInStakeTz,
  previousIsoDate,
  startOfDayInStakeTz,
} from './stakeTime.js';
export {
  isExpiredTempGrant,
  syncWillClearSeat,
  todayInStakeTz,
  type ExpirableGrant,
} from './tempExpiry.js';
export {
  comparisonDateMs,
  outstandingCutoffMs,
  partitionPendingRequests,
  type QueueSections,
} from './queueSections.js';
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
export {
  MAX_LIMITED_TEMP_WINDOW_DAYS,
  exceedsLimitedTempWindow,
  isoDateSpanDays,
} from './tempWindow.js';
export { kindooScopeName, kindooScopeNameVariants, unitType, type UnitType } from './unitName.js';
export {
  findUnitNameCollision,
  unitNameCollisionMessage,
  type UnitNameCollision,
} from './unitNameCollision.js';

// ---- Domain types -----------------------------------------------------
export type {
  Access,
  AccessRequest,
  ActorRef,
  AuditAction,
  AuditEntityType,
  AuditLog,
  BackfillEqPresidentAccessInput,
  BackfillEqPresidentAccessOutput,
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
  MintExtensionTokenOutput,
  Organization,
  OverCapEntry,
  PlatformAuditAction,
  PlatformAuditLog,
  PlatformSuperadmin,
  Principal,
  RemoteApplyDesktop,
  RemoteApplyDesktopWithId,
  RemoteApplyJob,
  RemoteApplyJobStatus,
  RemoteApplyOutcome,
  RemoteApplyOutcomeCode,
  RemoteApplyPresence,
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
  organizationSchema,
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
