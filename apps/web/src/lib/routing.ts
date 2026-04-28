// Shared routing helpers. Two responsibilities:
//
//   - `defaultLandingFor(principal)` — the SPA-side equivalent of
//     `Router_defaultPageFor_` in the Apps Script Router. Picks the
//     leftmost nav tab for the principal's highest-priority role
//     (manager > stake > bishopric). Used by `routes/index.tsx`.
//
//   - `deepLinkPath(p)` — resolves the legacy `?p=<page-key>` deep-link
//     form to the new SPA route. Page keys mirror the Apps Script
//     `Router.html` page-key vocabulary so existing bookmarks and
//     external links keep working.
//
// Phase 4 only resolves `?p=hello`. Phases 5–7 grow the table as the
// real routes ship; lookup by key keeps the resolver shape stable.

import type { Principal } from './principal';
import { STAKE_ID } from './constants';

/**
 * Map of legacy Apps Script `?p=` page keys to SPA routes. Lookups not
 * present return `null` and the caller falls back to the per-role
 * default. Phase 4 only ships `hello`; the table grows as Phase 5–7
 * routes land.
 */
const DEEP_LINK_TABLE: Record<string, string> = {
  hello: '/hello',
};

/** Resolve a legacy `?p=<key>` to a SPA route, or `null` if unknown. */
export function deepLinkPath(p: string | undefined): string | null {
  if (!p) return null;
  return DEEP_LINK_TABLE[p] ?? null;
}

/**
 * Per-principal default landing route. Mirrors `Router_defaultPageFor_`
 * in `src/web/Router.html` of the Apps Script app:
 *   - manager → manager dashboard (`/manager/dashboard`)
 *   - stake   → New Kindoo Request (`/stake/new`)
 *   - bishopric → New Kindoo Request (`/bishopric/new`)
 *   - multi-role → highest-priority role's leftmost tab (manager wins)
 *   - no role → '/hello' (Phase 4 only; pre-deletion of hello in Phase 5
 *     this falls back to the route's auth-gate which surfaces NotAuthorized).
 */
export function defaultLandingFor(principal: Principal): string {
  if (principal.managerStakes.includes(STAKE_ID) || principal.isPlatformSuperadmin) {
    return '/manager/dashboard';
  }
  if (principal.stakeMemberStakes.includes(STAKE_ID)) {
    return '/stake/new';
  }
  const wards = principal.bishopricWards[STAKE_ID];
  if (Array.isArray(wards) && wards.length > 0) {
    return '/bishopric/new';
  }
  // Authenticated principal with no role in this stake. Phase 4 ships
  // only `/hello`; gate components above this fall through to the
  // NotAuthorizedPage when no role applies.
  return '/hello';
}
