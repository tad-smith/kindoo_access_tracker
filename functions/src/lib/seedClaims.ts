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
// Reads a deliberately minimal access-doc shape: presence of
// `importer_callings` OR `manual_grants` with at least one non-empty
// scope, plus each grant's STORED access tier (D25 limited access) —
// `importer_limited_callings[scope]` on the importer side,
// `manual_grants[scope][].level` on the manual side. Nothing here
// classifies a calling by name; the tier is whatever the writer stamped.

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

  const manager = managerSnap.exists && isActiveManagerDoc(managerSnap.data());

  const { hasStake, wards, limited } = scopesFromAccessDoc(
    accessSnap.exists ? (accessSnap.data() as Record<string, unknown> | undefined) : undefined,
  );

  // `limited` is written present-and-true or omitted entirely — never
  // `false`. `applyClaims`'s `claimsEqual` is a canonical-JSON compare,
  // so emitting `limited: false` for every full user would read as a
  // claim change on the next sync and revoke their refresh token for
  // nothing. An active Kindoo Manager is never limited: the manager row
  // is a full-trust role, and the rules' manager carve-outs assume it.
  const block: StakeClaims = { manager, stake: hasStake, wards };
  if (isLimitedTier({ limited, manager })) block.limited = true;
  return block;
}

/**
 * `kindooManagers/{canonical}` doc body → active-manager boolean.
 * Manager status comes from the doc plus `active === true`, never from
 * the claim (which can be ~1h stale on an idle session).
 */
export function isActiveManagerDoc(data: unknown): boolean {
  return isPlainObject(data) && data['active'] === true;
}

/**
 * D25 effective access tier. Limited iff every grant in the stake is
 * limited AND the person is not an active Kindoo Manager — the manager
 * row is a full-trust role and the rules' manager carve-outs assume it.
 *
 * The single definition of "limited", shared by the claim minter above
 * and the welcome email's copy branch (`notifyOnAccessGranted`). Both
 * must agree: a person told their access is limited is exactly a person
 * whose claim carries `limited`.
 */
export function isLimitedTier(opts: { limited: boolean; manager: boolean }): boolean {
  return opts.limited && !opts.manager;
}

/**
 * Walk an access doc's `importer_callings` + `manual_grants` maps and
 * compute (a) whether the user has any non-empty grant in scope
 * `'stake'`, (b) the deduped sorted list of ward codes for which the
 * user has any non-empty grant in any other scope, and (c) whether
 * every one of those grants is limited-tier (D25).
 *
 * `limited` is true iff the user holds >=1 grant AND *every* grant
 * across *all* scopes is limited — one full grant anywhere in the doc
 * makes the whole stake block full. A grant counts as limited only on
 * positive evidence STORED ON THE DOC: an importer calling named in
 * `importer_limited_callings[scope]`, or a manual grant object whose
 * `level === 'limited'`. Everything else — a missing `level`, `'full'`,
 * wrong casing, a null / string / array entry, an absent or malformed
 * `importer_limited_callings` — counts as FULL. Garbage data must never
 * be read as a restriction; the failure direction is toward more access,
 * not less.
 *
 * Nothing here classifies a calling by name. The writer decided the tier
 * when it wrote the record, which is why a doc written before the field
 * existed (no `importer_limited_callings`) reads exactly as it always
 * did: all-full, no migration.
 *
 * Tolerant of missing fields, partial shapes, and arrays of mixed
 * truthiness — the trigger should never reject inputs that are merely
 * "not yet filled in."
 */
export function scopesFromAccessDoc(data: Record<string, unknown> | undefined): {
  hasStake: boolean;
  wards: string[];
  limited: boolean;
} {
  if (!data) return { hasStake: false, wards: [], limited: false };

  const importer = isPlainObject(data['importer_callings']) ? data['importer_callings'] : {};
  const importerLimited = isPlainObject(data['importer_limited_callings'])
    ? data['importer_limited_callings']
    : {};
  const manual = isPlainObject(data['manual_grants']) ? data['manual_grants'] : {};

  const wardSet = new Set<string>();
  let hasStake = false;
  let sawGrant = false;
  let sawFullGrant = false;

  for (const [scope, value] of Object.entries(importer)) {
    if (!hasNonEmptyArray(value)) continue;
    if (scope === 'stake') hasStake = true;
    else wardSet.add(scope);
    // Names the writer stamped as limited for THIS scope. A non-array
    // (or absent) value yields an empty set ⇒ every calling here is
    // full. Entries naming a calling that isn't in `importer_callings`
    // simply never match.
    const limitedKeys = limitedKeysForScope(importerLimited[scope]);
    for (const calling of value) {
      sawGrant = true;
      if (typeof calling !== 'string' || !limitedKeys.has(normalizeCalling(calling))) {
        sawFullGrant = true;
      }
    }
  }
  for (const [scope, value] of Object.entries(manual)) {
    if (!hasNonEmptyArray(value)) continue;
    if (scope === 'stake') hasStake = true;
    else wardSet.add(scope);
    for (const grant of value) {
      sawGrant = true;
      if (!isPlainObject(grant) || grant['level'] !== 'limited') sawFullGrant = true;
    }
  }

  return { hasStake, wards: [...wardSet].sort(), limited: sawGrant && !sawFullGrant };
}

async function isPlatformSuperadmin(canonical: string): Promise<boolean> {
  // v1 has no superadmins (allow-list managed in Firestore console
  // per `firebase-schema.md` §3.2). The check still runs so the
  // trigger surface is identical between v1 and Phase B.
  const db = getDb();
  const snap = await db.doc(`platformSuperadmins/${canonical}`).get();
  return snap.exists;
}

// `limited` is deliberately not part of the emptiness test: it can only
// be true when at least one non-empty grant array exists, which already
// sets `stake` or a ward. A block that is empty by these three fields
// can never carry `limited`.
function isNonEmptyStakeClaims(s: StakeClaims): boolean {
  return s.manager || s.stake || s.wards.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Trim + lowercase — the key scheme `appAccessCallings.ts` matches on,
 * so a hand-edited stamp in different casing still lines up. */
function normalizeCalling(calling: string): string {
  return calling.trim().toLowerCase();
}

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * `importer_limited_callings[scope]` → the set of normalised calling
 * keys it marks limited. Anything that isn't an array of strings
 * contributes nothing, so malformed data degrades to "all full".
 */
function limitedKeysForScope(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return EMPTY_KEYS;
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string') keys.add(normalizeCalling(entry));
  }
  return keys;
}

function hasNonEmptyArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.length > 0;
}
