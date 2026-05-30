// Shared routing helpers. Two responsibilities:
//
//   - `defaultLandingFor(principal, stakeId)` — picks the post-login
//     default for the principal's highest-priority role in the active
//     stake (manager > stake > bishopric). For a zero-role platform
//     superadmin (no accessible stake) returns `/superadmin/stakes`
//     per spec §2.1. Used by `routes/index.tsx`.
//
//   - `deepLinkPath(p)` — resolves the legacy `?p=<page-key>` query-
//     param deep-link form to the SPA route. Kept so external
//     bookmarks from the pre-cutover UI keep working.
//
// Defaults per spec §5:
//   - manager   → `/manager/dashboard`
//   - stake     → `/stake/roster`
//   - bishopric → `/bishopric/roster`
// Multi-role principals resolve to the highest-priority role's default.
// Non-Kindoo-Manager roles intentionally land on the Roster rather
// than the leftmost-nav `/new` so the first thing those users see is
// the current ward (or stake) seat list; a "New Request" button in
// the Roster header surfaces the previously-default `/new` form.

import type { Principal } from './principal';

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
 * Per-principal default landing route. Resolved against the active
 * stake (or null for a zero-role platform superadmin):
 *   - zero-role superadmin (stakeId === null) → `/superadmin/stakes`
 *   - manager in stakeId  → `/manager/dashboard`
 *   - stake in stakeId    → `/stake/roster`
 *   - bishopric in stakeId → `/bishopric/roster`
 *   - multi-role → highest-priority role wins (manager > stake > bishopric)
 *   - no role in stakeId → `/`; the route gate surfaces NotAuthorizedPage.
 */
export function defaultLandingFor(principal: Principal, stakeId: string | null): string {
  // Zero-role platform superadmin lands on the Stake List per spec §2.1.
  if (stakeId === null) {
    if (principal.isPlatformSuperadmin) return '/superadmin/stakes';
    return '/';
  }
  if (principal.managerStakes.includes(stakeId) || principal.isPlatformSuperadmin) {
    return '/manager/dashboard';
  }
  if (principal.stakeMemberStakes.includes(stakeId)) {
    return '/stake/roster';
  }
  const wards = principal.bishopricWards[stakeId];
  if (Array.isArray(wards) && wards.length > 0) {
    return '/bishopric/roster';
  }
  // Authenticated principal with no role in this stake. Falls through
  // to the route-tree's auth gate which surfaces NotAuthorizedPage.
  return '/';
}
