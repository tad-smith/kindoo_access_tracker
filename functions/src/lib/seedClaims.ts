// `seedClaimsFromRoleData` — compute the full {@link CustomClaims}
// payload for a user by reading every role-data doc keyed off their
// canonical email across every stake. Used by `onAuthUserCreate` at
// first sign-in (when there are no claims yet) and by the sync
// triggers when the doc shape changes mid-session.
//
// The "right" answer for claims is always derivable from role data
// alone, so a sync trigger never needs to merge with prior claims —
// it can rebuild the per-stake block from scratch and drop it into
// place.
//
// Phase 2 reads a deliberately minimal access-doc shape: presence of
// `importer_callings` OR `manual_grants` with at least one non-empty
// scope. Phase 3 fills in those collections via the importer +
// manager UIs; the trigger code already supports the Phase-3 shape so
// no rewrite happens at the schema cut-over.

import type { CustomClaims, StakeClaims } from '@kindoo/shared';
import { getDb } from './admin.js';
import { getStakeIds } from './stakeIds.js';

/**
 * Build the {@link CustomClaims} object for `canonical` by reading
 * every role-data collection. The returned claims always carry
 * `canonical`; `stakes`/`isPlatformSuperadmin` are present iff the
 * user has any matching role data.
 *
 * Note: `uid` is required by callers but the function does not write
 * claims — it only computes them. The caller decides whether to call
 * `setCustomUserClaims` (always) plus `revokeRefreshTokens` (only if
 * claims actually changed; cheap to skip the no-op).
 */
export async function seedClaimsFromRoleData(
  _uid: string,
  canonical: string,
): Promise<CustomClaims> {
  const claims: CustomClaims = { canonical };

  const db = getDb();
  const stakeIds = await getStakeIds(db);
  const stakeClaims: Record<string, StakeClaims> = {};
  for (const stakeId of stakeIds) {
    const block = await computeStakeClaims(stakeId, canonical);
    if (isNonEmptyStakeClaims(block)) {
      stakeClaims[stakeId] = block;
    }
  }
  if (Object.keys(stakeClaims).length > 0) {
    claims.stakes = stakeClaims;
  }

  if (await isPlatformSuperadmin(canonical)) {
    claims.isPlatformSuperadmin = true;
  }

  return claims;
}

/**
 * Per-stake claim computation. Reads the kindooManagers + access docs
 * for `canonical` under `stakes/{stakeId}/` and folds them into a
 * {@link StakeClaims} block.
 */
export async function computeStakeClaims(stakeId: string, canonical: string): Promise<StakeClaims> {
  const db = getDb();

  const [managerSnap, accessSnap] = await Promise.all([
    db.doc(`stakes/${stakeId}/kindooManagers/${canonical}`).get(),
    db.doc(`stakes/${stakeId}/access/${canonical}`).get(),
  ]);

  const manager =
    managerSnap.exists && (managerSnap.data() as { active?: unknown } | undefined)?.active === true;

  const { hasStake, wards } = scopesFromAccessDoc(
    accessSnap.exists ? (accessSnap.data() as Record<string, unknown> | undefined) : undefined,
  );

  return { manager, stake: hasStake, wards };
}

/**
 * Walk an access doc's `importer_callings` + `manual_grants` maps and
 * compute (a) whether the user has any non-empty grant in scope
 * `'stake'`, and (b) the deduped sorted list of ward codes for which
 * the user has any non-empty grant in any other scope.
 *
 * Tolerant of missing fields, partial shapes, and arrays of mixed
 * truthiness — Phase 2 lands before the Phase 3 schema is fully
 * populated, so the trigger should never reject inputs that are merely
 * "not yet filled in."
 */
export function scopesFromAccessDoc(data: Record<string, unknown> | undefined): {
  hasStake: boolean;
  wards: string[];
} {
  if (!data) return { hasStake: false, wards: [] };

  const importer = isPlainObject(data['importer_callings']) ? data['importer_callings'] : {};
  const manual = isPlainObject(data['manual_grants']) ? data['manual_grants'] : {};

  const wardSet = new Set<string>();
  let hasStake = false;

  for (const [scope, value] of Object.entries(importer)) {
    if (!hasNonEmptyArray(value)) continue;
    if (scope === 'stake') hasStake = true;
    else wardSet.add(scope);
  }
  for (const [scope, value] of Object.entries(manual)) {
    if (!hasNonEmptyArray(value)) continue;
    if (scope === 'stake') hasStake = true;
    else wardSet.add(scope);
  }

  return { hasStake, wards: [...wardSet].sort() };
}

async function isPlatformSuperadmin(canonical: string): Promise<boolean> {
  // v1 has no superadmins (allow-list managed in Firestore console
  // per `firebase-schema.md` §3.2). The check still runs so the
  // trigger surface is identical between v1 and Phase B.
  const db = getDb();
  const snap = await db.doc(`platformSuperadmins/${canonical}`).get();
  return snap.exists;
}

function isNonEmptyStakeClaims(s: StakeClaims): boolean {
  return s.manager || s.stake || s.wards.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasNonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}
