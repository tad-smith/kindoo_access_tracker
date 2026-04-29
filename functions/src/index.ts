// Cloud Functions entry point. Per `docs/firebase-schema.md` §7:
//
//   - Claim-sync triggers:
//       onAuthUserCreate     (auth.user().onCreate; v1 — see trigger
//                             file for why v2 is not used here)
//       syncAccessClaims     (firestore onDocumentWritten)
//       syncManagersClaims   (firestore onDocumentWritten)
//       syncSuperadminClaims (firestore onDocumentWritten; v1 skeleton —
//                             empty allow-list)
//
//   - Audit triggers (parameterised; one registration per audited path):
//       audit{Stake,Ward,Building,Manager,Access,Seat,Request,
//             WardCallingTemplate,StakeCallingTemplate}Writes

export { onAuthUserCreate } from './triggers/onAuthUserCreate.js';
export { syncAccessClaims } from './triggers/syncAccessClaims.js';
export { syncManagersClaims } from './triggers/syncManagersClaims.js';
export { syncSuperadminClaims } from './triggers/syncSuperadminClaims.js';

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
