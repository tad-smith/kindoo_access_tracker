// Domain types barrel. Auth shapes (claims, principal, userIndex
// bridge), per-stake domain entities (Stake / Ward / Building /
// KindooManager / Access / Seat / Request / CallingTemplate /
// AuditLog / PlatformSuperadmin / PlatformAuditLog), plus the shared
// `ActorRef` carried on every doc's `lastActor` field.
export type { ActorRef } from './actor.js';
export type { Access, ManualGrant } from './access.js';
export type {
  AuditAction,
  AuditEntityType,
  AuditLog,
  PlatformAuditAction,
  PlatformAuditLog,
} from './audit.js';
export type { CustomClaims, Principal, StakeClaims } from './auth.js';
export type { Building, KindooBuildingRule } from './building.js';
export type {
  GetMyPendingRequestsInput,
  GetMyPendingRequestsOutput,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
} from './extensionCallables.js';
export type { ImportSummary } from './import.js';
export type {
  CallingTemplate,
  StakeCallingTemplate,
  WardCallingTemplate,
} from './callingTemplate.js';
export type { KindooManager } from './kindooManager.js';
export type { KindooSite } from './kindooSite.js';
export type { PlatformSuperadmin } from './platformSuperadmin.js';
export type {
  AccessRequest,
  CompletionStatus,
  RequestStatus,
  RequestType,
} from './request.js';
export type { DuplicateGrant, Seat, SeatType } from './seat.js';
export type { ImportDay, KindooConfig, OverCapEntry, Stake } from './stake.js';
export type {
  BuildingsMismatchPayload,
  ExtraKindooCallingPayload,
  KindooOnlyPayload,
  ScopeMismatchPayload,
  SyncApplyFixInput,
  SyncApplyFixResult,
  TypeMismatchPayload,
} from './syncApplyFix.js';
export type { TimestampLike, UserIndexEntry } from './userIndex.js';
export type { Ward } from './ward.js';
