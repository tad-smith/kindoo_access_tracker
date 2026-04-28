// Thin re-export of the canonical-email helpers from `@kindoo/shared`.
//
// The functions code base imports its email canonicalisation through
// this module rather than reaching directly into `@kindoo/shared` so
// the boundary is greppable: a single `from '../lib/canonicalEmail.js'`
// is what every trigger uses, and any future server-only refinement
// (e.g., logging, metrics, an Admin-SDK-only fallback for
// double-canonicalisation diagnostics) lives here without touching
// the shared package.

export { canonicalEmail, emailsEqual } from '@kindoo/shared';

import { canonicalEmail as sharedCanonical } from '@kindoo/shared';

/**
 * Server-only convenience alias. The export name `canonicalize`
 * reads better at trigger call-sites where the input is already a
 * known-string typed email. Equivalent to {@link canonicalEmail}.
 */
export function canonicalize(email: string): string {
  return sharedCanonical(email);
}
