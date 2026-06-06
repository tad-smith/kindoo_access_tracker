// Cloud Functions entry point. Per `docs/firebase-schema.md` §7.

export { onAuthUserCreate } from './triggers/onAuthUserCreate.js';
export { syncAccessClaims } from './triggers/syncAccessClaims.js';
export { syncManagersClaims } from './triggers/syncManagersClaims.js';
export { syncSuperadminClaims } from './triggers/syncSuperadminClaims.js';
export { removeSeatOnRequestComplete } from './triggers/removeSeatOnRequestComplete.js';
export { pushOnRequestSubmit } from './triggers/pushOnRequestSubmit.js';
export { notifyOnRequestWrite } from './triggers/notifyOnRequestWrite.js';
export { notifyOnOverCap } from './triggers/notifyOnOverCap.js';

export {
  auditAccessWrites,
  auditBuildingWrites,
  auditKindooSiteWrites,
  auditManagerWrites,
  auditRequestWrites,
  auditSeatWrites,
  auditStakeWrites,
  auditWardWrites,
} from './triggers/auditTrigger.js';

export { reconcileAuditGaps } from './scheduled/reconcileAuditGaps.js';

export { installScheduledJobs } from './callable/installScheduledJobs.js';
export { getMyPendingRequests } from './callable/getMyPendingRequests.js';
export { markRequestComplete } from './callable/markRequestComplete.js';
export { syncApplyFix } from './callable/syncApplyFix.js';
export { createStake } from './callable/createStake.js';
export { backfillKindooSiteId } from './callable/backfillKindooSiteId.js';
