// `PlatformSuperadmin` — `platformSuperadmins/{canonicalEmail}` doc
// per `docs/firebase-schema.md` §3.2. Empty in single-stake v1; the
// allow-list is managed via Firestore console (chicken-and-egg —
// there's no in-app management surface for the role that controls
// in-app management surfaces).

import type { TimestampLike } from './userIndex.js';

export type PlatformSuperadmin = {
  /** Typed display email. */
  email: string;
  addedAt: TimestampLike;
  /** Canonical email of the superadmin who added this entry. */
  addedBy: string;
  /** Free-text — optional context for why this entry exists. */
  notes?: string;
};
