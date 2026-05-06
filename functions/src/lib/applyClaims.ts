// Helpers for "stamp these new per-stake claims onto a uid, preserving
// the rest." Used by the three sync triggers — each fires on a single
// stake's role data, but multi-stake (Phase 12) means we must not
// clobber the user's claim block in *other* stakes.
//
// Also encapsulates the "did the claims actually change?" comparison
// so we only call `revokeRefreshTokens` when there's a real change —
// the Auth emulator + production both rate-limit / penalise excess
// revokes, and a no-op revoke wastes the rest of an active session.

import type { CustomClaims, StakeClaims } from '@kindoo/shared';
import { getAdminAuth } from './admin.js';

/**
 * Test-only short-circuit: when `KINDOO_SKIP_CLAIM_SYNC=true` is set on
 * the function runtime, the three claim-applier helpers below all
 * return without touching `setCustomUserClaims` or
 * `revokeRefreshTokens`. The E2E suite sets the env var so the
 * Auth-emulator's `setCustomAttributes` (called via `setCustomClaims`
 * REST in `e2e/fixtures/emulator.ts`) is the sole source of truth for
 * claims during a spec — without this, the claim-sync triggers race
 * the synthetic seed and the user's effective claims are nondeterministic.
 * Production never sets the env var; integration tests run in-process
 * and bypass triggers entirely; only the live Functions emulator path
 * exercised by Playwright opts in.
 */
function shouldSkip(): boolean {
  return process.env['KINDOO_SKIP_CLAIM_SYNC'] === 'true';
}

/**
 * Merge the (possibly empty) `newStakeClaims` for `stakeId` into the
 * user's existing claim block, write the result via
 * `setCustomUserClaims`, and revoke refresh tokens iff the result
 * differs from what was previously set.
 *
 * `newStakeClaims === null` means "remove this stake's claim block
 * entirely" — used when a delete happens and the resulting block
 * would be `{ manager: false, stake: false, wards: [] }`.
 */
export async function applyStakeClaims(
  uid: string,
  canonical: string,
  stakeId: string,
  newStakeClaims: StakeClaims | null,
): Promise<void> {
  if (shouldSkip()) return;
  const auth = getAdminAuth();
  const user = await auth.getUser(uid);
  const existing = (user.customClaims ?? null) as CustomClaims | null;

  const merged: CustomClaims = mergeStake(existing, canonical, stakeId, newStakeClaims);

  if (claimsEqual(existing, merged)) return;

  await auth.setCustomUserClaims(uid, merged as unknown as Record<string, unknown>);
  await auth.revokeRefreshTokens(uid);
}

/**
 * Set the platform-superadmin flag for `uid` to `flag`. Mirrors
 * {@link applyStakeClaims} for the top-level `isPlatformSuperadmin`
 * claim.
 */
export async function applySuperadminClaim(
  uid: string,
  canonical: string,
  flag: boolean,
): Promise<void> {
  if (shouldSkip()) return;
  const auth = getAdminAuth();
  const user = await auth.getUser(uid);
  const existing = (user.customClaims ?? null) as CustomClaims | null;
  const base = existing ?? { canonical };
  const merged: CustomClaims = { ...base, canonical };
  if (flag) merged.isPlatformSuperadmin = true;
  else delete merged.isPlatformSuperadmin;

  if (claimsEqual(existing, merged)) return;

  await auth.setCustomUserClaims(uid, merged as unknown as Record<string, unknown>);
  await auth.revokeRefreshTokens(uid);
}

/**
 * Replace the user's full claim block with `claims`, revoking refresh
 * tokens iff the result differs. Used by `onAuthUserCreate` after
 * `seedClaimsFromRoleData` has computed the from-scratch payload.
 */
export async function applyFullClaims(uid: string, claims: CustomClaims): Promise<void> {
  if (shouldSkip()) return;
  const auth = getAdminAuth();
  const user = await auth.getUser(uid);
  const existing = (user.customClaims ?? null) as CustomClaims | null;
  if (claimsEqual(existing, claims)) return;
  await auth.setCustomUserClaims(uid, claims as unknown as Record<string, unknown>);
  await auth.revokeRefreshTokens(uid);
}

function mergeStake(
  existing: CustomClaims | null,
  canonical: string,
  stakeId: string,
  newStakeClaims: StakeClaims | null,
): CustomClaims {
  const base: CustomClaims = existing
    ? { ...existing, canonical: existing.canonical || canonical }
    : { canonical };

  const stakes: Record<string, StakeClaims> = base.stakes ? { ...base.stakes } : {};
  if (newStakeClaims && isNonEmptyStakeClaims(newStakeClaims)) {
    stakes[stakeId] = newStakeClaims;
  } else {
    delete stakes[stakeId];
  }

  if (Object.keys(stakes).length > 0) base.stakes = stakes;
  else delete base.stakes;

  return base;
}

function isNonEmptyStakeClaims(s: StakeClaims): boolean {
  return s.manager || s.stake || s.wards.length > 0;
}

function claimsEqual(a: CustomClaims | null, b: CustomClaims | null): boolean {
  // Stable JSON compare is fine at this scale: claims are tiny
  // (canonical + a few flags + a small wards array per stake) and
  // ordering is deterministic because we only ever construct the
  // object via the helpers above.
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
