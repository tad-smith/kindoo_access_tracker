// Cloud Functions entry point. Phase 1 shipped the `hello` callable
// (a Phase-2 deletion candidate, but kept until the SPA's smoketest
// is rewired to talk to a real callable). Phase 2 adds the four
// claim-sync triggers per `docs/firebase-schema.md` §7:
//
//   - onAuthUserCreate     (auth.user().onCreate; v1 — see trigger
//                           file for why v2 is not used here)
//   - syncAccessClaims     (firestore onDocumentWritten)
//   - syncManagersClaims   (firestore onDocumentWritten)
//   - syncSuperadminClaims (firestore onDocumentWritten; v1 skeleton —
//                           empty allow-list)
//
// Phase 1 left `hello` anonymously callable (no auth gate). That's
// still the case in Phase 2; Phase 3+ will retire `hello` once real
// auth-gated reads exist.

import { onCall } from 'firebase-functions/v2/https';
import { KINDOO_FUNCTIONS_VERSION } from './version.js';

// Captured once at module load so every invocation sees the same value
// for the lifetime of this Cloud Functions instance. The `version`
// field changes per-deploy (stamped via infra/scripts/stamp-version.js);
// `builtAt` changes per-cold-start, which is enough to distinguish
// instances if we ever need to.
const BUILT_AT = new Date().toISOString();

export const hello = onCall({}, () => ({
  version: KINDOO_FUNCTIONS_VERSION,
  builtAt: BUILT_AT,
  // FIREBASE_CONFIG is set automatically by the Functions runtime when
  // running in Cloud; the emulator does not set it, so an unset value
  // is a reliable "we are local" signal.
  env: process.env['FIREBASE_CONFIG'] ? 'cloud' : 'local',
}));

export { onAuthUserCreate } from './triggers/onAuthUserCreate.js';
export { syncAccessClaims } from './triggers/syncAccessClaims.js';
export { syncManagersClaims } from './triggers/syncManagersClaims.js';
export { syncSuperadminClaims } from './triggers/syncSuperadminClaims.js';
