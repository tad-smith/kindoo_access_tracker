// Shared routing helpers. Two responsibilities:
//
//   - `defaultLandingFor(principal)` — picks the leftmost nav tab for
//     the principal's highest-priority role (manager > stake >
//     bishopric). Used by `routes/index.tsx`.
//
//   - `deepLinkPath(p)` — resolves the legacy `?p=<page-key>` query-
//     param deep-link form to the SPA route. Kept so external
//     bookmarks from the pre-cutover UI keep working.
//
// The leftmost nav tab for stake + bishopric is "New Kindoo Request"
// per spec §5; manager's leftmost is the Dashboard. Multi-role users
// resolve to the highest-priority role's leftmost tab.

import type { Principal } from './principal';
import { STAKE_ID } from './constants';

/**
 * Map of legacy `?p=` page keys to SPA routes. Lookups not present
 * return `null` and the caller falls back to the per-role default.
 * Kept so external bookmarks from the pre-cutover UI keep working.
 */
const DEEP_LINK_TABLE: Record<string, string> = {
  // Bishopric + stake pages. `/bishopric/new` and `/stake/new` are
  // both forwarded to the unified `/new` route; the old paths still
  // exist as redirects so direct-URL bookmarks resolve correctly.
  'bish/roster': '/bishopric/roster',
  'bish/new': '/new',
  'bish/myreq': '/my-requests',
  'stake/roster': '/stake/roster',
  'stake/wards': '/stake/wards',
  'stake/new': '/new',

  // Bare `new` — single shared NewRequest page, role-aware scope
  // dropdown.
  new: '/new',

  // Manager pages
  'mgr/dashboard': '/manager/dashboard',
  'mgr/queue': '/manager/queue',
  'mgr/seats': '/manager/seats',
  'mgr/audit': '/manager/audit',
  'mgr/access': '/manager/access',
  'mgr/configuration': '/manager/configuration',
  'mgr/import': '/manager/import',

  // Cross-role MyRequests
  myreq: '/my-requests',
  my: '/my-requests',
};

/** Resolve a legacy `?p=<key>` to a SPA route, or `null` if unknown. */
export function deepLinkPath(p: string | undefined): string | null {
  if (!p) return null;
  return DEEP_LINK_TABLE[p] ?? null;
}

/**
 * Per-principal default landing route:
 *   - manager → `/manager/dashboard` (leftmost tab is Dashboard)
 *   - stake   → `/new` (leftmost tab is New Request)
 *   - bishopric → `/new` (same)
 *   - multi-role → highest-priority role's leftmost tab (manager wins)
 *   - no role → null-equivalent ('/'); the route gate surfaces
 *               NotAuthorizedPage in that case.
 */
export function defaultLandingFor(principal: Principal): string {
  if (principal.managerStakes.includes(STAKE_ID) || principal.isPlatformSuperadmin) {
    return '/manager/dashboard';
  }
  if (principal.stakeMemberStakes.includes(STAKE_ID)) {
    return '/new';
  }
  const wards = principal.bishopricWards[STAKE_ID];
  if (Array.isArray(wards) && wards.length > 0) {
    return '/new';
  }
  // Authenticated principal with no role in this stake. Falls through
  // to the route-tree's auth gate which surfaces NotAuthorizedPage.
  return '/';
}
