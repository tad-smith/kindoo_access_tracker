// `Access` — `stakes/{stakeId}/access/{canonicalEmail}` doc per
// `docs/firebase-schema.md` §4.5. The split between
// `importer_callings` (Importer-owned) and `manual_grants`
// (manager-owned) is the field-level split-ownership boundary that the
// Firestore rules enforce; importer never mutates `manual_grants` and
// rules never let a client mutate `importer_callings`.

import type { ActorRef } from './actor.js';
import type { TimestampLike } from './userIndex.js';

/**
 * One manual grant entry inside `manual_grants[scope]`. Each carries a
 * UUID so a manager can unambiguously delete a specific entry without
 * relying on `(scope, reason)` uniqueness — there's no schema-level
 * uniqueness constraint on those.
 */
export type ManualGrant = {
  /** UUID; unique inside this `(canonical, scope)` array. */
  grant_id: string;
  /** Free-text justification (e.g., "Bishop", "ward clerk training"). */
  reason: string;
  granted_by: ActorRef;
  granted_at: TimestampLike;
};

export type Access = {
  /** `= doc.id`. Canonical email. */
  member_canonical: string;
  /** Typed display email. */
  member_email: string;
  /** Display name. */
  member_name: string;

  /**
   * Sync-managed (field name is historical — predates the T-45 importer
   * removal; the extension's Sync feature now owns it). Keys = scope
   * (`'stake'` or a ward_code). Values = list of callings that grant app
   * access for that scope (the hard-coded churchwide app-access set —
   * `filterAppAccessCallings`). Sync wholesale-replaces this map per
   * scope; never mutates `manual_grants`.
   */
  importer_callings: Record<string, string[]>;

  /**
   * Manager-managed. Keys = scope. Values = explicit manual grants. The
   * client cannot mutate `importer_callings` on a write — rules enforce.
   */
  manual_grants: Record<string, ManualGrant[]>;

  /**
   * Doc-level sort priority. MIN canonical `seatCallingOrder` across the
   * `importer_callings` callings. Sync-populated; `null` when
   * `importer_callings` is empty (manual-only access docs). Web-side sort
   * treats `null` / missing as "after all numbered."
   */
  sort_order?: number | null;

  created_at: TimestampLike;
  last_modified_at: TimestampLike;
  last_modified_by: ActorRef;
  lastActor: ActorRef;
};
