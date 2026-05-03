// Schemas barrel. Each schema mirrors the like-named type in
// `../types/`. Schemas are used for:
//   - Round-trip validation in unit tests (Phase 3 onward).
//   - Form input validation in `apps/web/` (Phase 4+).
//   - Cloud Function callable input validation (Phase 8+).
export { actorRefSchema } from './actor.js';
export { accessSchema, manualGrantSchema } from './access.js';
export {
  auditActionSchema,
  auditEntityTypeSchema,
  auditLogSchema,
  platformAuditActionSchema,
  platformAuditLogSchema,
} from './audit.js';
export { buildingSchema } from './building.js';
export {
  callingTemplateSchema,
  stakeCallingTemplateSchema,
  wardCallingTemplateSchema,
} from './callingTemplate.js';
export { kindooManagerSchema } from './kindooManager.js';
export { platformSuperadminSchema } from './platformSuperadmin.js';
export { accessRequestSchema, requestStatusSchema, requestTypeSchema } from './request.js';
export { duplicateGrantSchema, seatSchema, seatTypeSchema } from './seat.js';
export { importDaySchema, overCapEntrySchema, stakeSchema } from './stake.js';
export { timestampLikeSchema } from './timestampLike.js';
export { notificationPrefsSchema, userIndexEntrySchema } from './userIndex.js';
export { wardSchema } from './ward.js';
