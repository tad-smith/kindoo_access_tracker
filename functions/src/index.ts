// Cloud Functions entry point. Re-exports the four claim-sync triggers
// per `docs/firebase-schema.md` §7:
//
//   - onAuthUserCreate     (auth.user().onCreate; v1 — see trigger
//                           file for why v2 is not used here)
//   - syncAccessClaims     (firestore onDocumentWritten)
//   - syncManagersClaims   (firestore onDocumentWritten)
//   - syncSuperadminClaims (firestore onDocumentWritten; v1 skeleton —
//                           empty allow-list)

export { onAuthUserCreate } from './triggers/onAuthUserCreate.js';
export { syncAccessClaims } from './triggers/syncAccessClaims.js';
export { syncManagersClaims } from './triggers/syncManagersClaims.js';
export { syncSuperadminClaims } from './triggers/syncSuperadminClaims.js';
