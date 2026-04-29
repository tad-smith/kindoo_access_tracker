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
// Phase 5 wires the read-side pages: bishopric/stake roster, ward
// rosters, manager dashboard / all-seats / audit log / access, plus the
// cross-role MyRequests page. Phase 6 will add `New Kindoo Request` for
// bishopric + stake; the Nav meanwhile renders that link as a disabled
// placeholder so the visual structure is right and the leftmost tab for
// stake/bishopric in Phase 5 is Roster (per the spec's "leftmost nav
// tab" default-landing rule applied to the Phase-5 nav set).

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
  // Bishopric + stake read-only pages
  'bish/roster': '/bishopric/roster',
  'bish/myreq': '/my-requests',
  'stake/roster': '/stake/roster',
  'stake/wards': '/stake/wards',

  // Manager pages
  'mgr/dashboard': '/manager/dashboard',
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
 *   - stake   → `/stake/roster` (Phase-5 leftmost; Phase 6 will
 *               re-front-load `/stake/new` per the live-spec rule)
 *   - bishopric → `/bishopric/roster` (same Phase-5 leftmost rule)
 *   - multi-role → highest-priority role's leftmost tab (manager wins)
 *   - no role → null-equivalent ('/'); the route gate surfaces
 *               NotAuthorizedPage in that case.
 */
export function defaultLandingFor(principal: Principal): string {
  if (principal.managerStakes.includes(STAKE_ID) || principal.isPlatformSuperadmin) {
    return '/manager/dashboard';
  }
  if (principal.stakeMemberStakes.includes(STAKE_ID)) {
    return '/stake/roster';
  }
  const wards = principal.bishopricWards[STAKE_ID];
  if (Array.isArray(wards) && wards.length > 0) {
    return '/bishopric/roster';
  }
  // Authenticated principal with no role in this stake. Falls through
  // to the route-tree's auth gate which surfaces NotAuthorizedPage.
  return '/';
}
