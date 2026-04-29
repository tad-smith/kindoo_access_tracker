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
// The leftmost nav tab for stake + bishopric is "New Kindoo Request"
// per spec §5; manager's leftmost is the Dashboard. Multi-role users
// resolve to the highest-priority role's leftmost tab.

import type { Principal } from './principal';
import { STAKE_ID } from './constants';

/**
 * Map of legacy Apps Script `?p=` page keys to SPA routes. Lookups not
 * present return `null` and the caller falls back to the per-role
 * default. Page keys mirror the Apps Script `Router.html` vocabulary so
 * existing bookmarks (forwarded by Cloud Functions during cutover or
 * pasted from the live app) keep working.
 *
 * Pages not yet shipped (Phase 6+ write paths) deliberately have no
 * mapping here — falling back to the role default gets the user a
 * working page rather than a 404 placeholder.
 */
const DEEP_LINK_TABLE: Record<string, string> = {
  // Bishopric + stake pages
  'bish/roster': '/bishopric/roster',
  'bish/new': '/bishopric/new',
  'bish/myreq': '/my-requests',
  'stake/roster': '/stake/roster',
  'stake/wards': '/stake/wards',
  'stake/new': '/stake/new',

  // Apps Script's bare `new` key — the live shared NewRequest page
  // dispatches by principal role. Bishopric + stake users land on
  // their own per-role new-request page; multi-role users with
  // bishopric coverage prefer that route (matches `defaultLandingFor`
  // priority).
  new: '/bishopric/new',

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
 * Per-principal default landing route. Mirrors `Router_defaultPageFor_`
 * in `src/web/Router.html` of the Apps Script app:
 *   - manager → `/manager/dashboard` (leftmost tab is Dashboard)
 *   - stake   → `/stake/new` (leftmost tab is New Kindoo Request)
 *   - bishopric → `/bishopric/new` (same)
 *   - multi-role → highest-priority role's leftmost tab (manager wins)
 *   - no role → null-equivalent ('/'); the route gate surfaces
 *               NotAuthorizedPage in that case.
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
  // Authenticated principal with no role in this stake. Falls through
  // to the route-tree's auth gate which surfaces NotAuthorizedPage.
  return '/';
}
