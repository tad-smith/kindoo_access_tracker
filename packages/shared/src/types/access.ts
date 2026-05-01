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
  /** Free-text — the equivalent of the `calling` column on Apps Script's manual rows. */
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
   * Importer-managed. Keys = scope (`'stake'` or a ward_code). Values =
   * list of callings whose template row had `give_app_access=true`. The
   * Importer wholesale-replaces this map per scope on each import run;
   * never mutates `manual_grants`.
   */
  importer_callings: Record<string, string[]>;

  /**
   * Manager-managed. Keys = scope. Values = explicit manual grants. The
   * client cannot mutate `importer_callings` on a write — rules enforce.
   */
  manual_grants: Record<string, ManualGrant[]>;

  /**
   * Doc-level sort priority. MIN across every `importer_callings`
   * calling's matched template `sheet_order`. Importer-populated;
   * `null` when `importer_callings` is empty (manual-only access docs).
   * Web-side sort treats `null` / missing as "after all numbered."
   */
  sort_order?: number | null;

  created_at: TimestampLike;
  last_modified_at: TimestampLike;
  last_modified_by: ActorRef;
  lastActor: ActorRef;
};
