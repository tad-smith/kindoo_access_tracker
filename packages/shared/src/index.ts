// Public surface of @kindoo/shared. Both apps/web/ and functions/ import
// from here. Domain types and zod schemas land in Phase 3 (per
// docs/firebase-migration.md); for Phase 1 we only ship the
// canonical-email helpers that need to be consistent across runtimes.
export { canonicalEmail, emailsEqual } from './canonicalEmail.js';
