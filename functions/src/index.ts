// Cloud Functions entry point. Per `docs/firebase-schema.md` §7.

export { onAuthUserCreate } from './triggers/onAuthUserCreate.js';
export { syncAccessClaims } from './triggers/syncAccessClaims.js';
export { syncManagersClaims } from './triggers/syncManagersClaims.js';
export { syncSuperadminClaims } from './triggers/syncSuperadminClaims.js';
export { removeSeatOnRequestComplete } from './triggers/removeSeatOnRequestComplete.js';
export { pushOnRequestSubmit } from './triggers/pushOnRequestSubmit.js';

export {
  auditAccessWrites,
  auditBuildingWrites,
  auditManagerWrites,
  auditRequestWrites,
  auditSeatWrites,
  auditStakeCallingTemplateWrites,
  auditStakeWrites,
  auditWardCallingTemplateWrites,
  auditWardWrites,
} from './triggers/auditTrigger.js';

export { runImporter } from './scheduled/runImporter.js';
export { runExpiry } from './scheduled/runExpiry.js';
export { reconcileAuditGaps } from './scheduled/reconcileAuditGaps.js';

export { runImportNow } from './callable/runImportNow.js';
export { installScheduledJobs } from './callable/installScheduledJobs.js';
