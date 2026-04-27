// Cloud Functions entry point. Phase 1 ships exactly one callable —
// `hello` — which the smoketest in apps/web invokes to prove the SPA →
// Functions → Firestore wiring works end-to-end.
//
// Phase 1 leaves `hello` anonymously callable (no auth gate). Phase 2
// adds Firebase Auth verification once Identity Platform is wired.
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
