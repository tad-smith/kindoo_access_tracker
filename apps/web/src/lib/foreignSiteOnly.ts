// Detection for the "Give Access To Stake Buildings" manager affordance.
//
// A member is *foreign-site-only* when their seat exists, holds ≥1
// grant, and EVERY grant resolves to a foreign (non-home) Kindoo site
// — with NO `scope === 'stake'` grant and no grant resolving to the
// home site. Such members can badge in as foreign-site holders but have
// no access to this stake's home-site buildings; the manager affordance
// lets a Kindoo Manager grant them a stake-scope seat (home-site
// buildings) without round-tripping through a request the member
// submits themselves.
//
// Site resolution mirrors `siteLabelForGrant` (kindooSites.ts): a
// grant's own `kindoo_site_id` wins; on legacy / un-migrated grants
// (null id) we fall back to resolving the grant's scope through its
// ward's building. Stake-scope grants always resolve to home (null) per
// the Phase 1 policy baked into the shared resolvers — so any stake
// grant short-circuits the predicate to `false`.

import { resolveWardSite } from '@kindoo/shared';
import type { Building, Seat, Ward } from '@kindoo/shared';
import { grantsForDisplay, type GrantView } from './grants';

/**
 * Resolve a grant's effective Kindoo site id: `null` (home) or a
 * foreign site id string. Stake-scope resolves to home. Mirrors the
 * resolution `siteLabelForGrant` performs (id-first, ward-building
 * fallback) but returns the raw id rather than a display label so the
 * caller can reason about home-vs-foreign.
 */
function grantSiteId(
  grant: Pick<GrantView, 'scope' | 'kindoo_site_id'>,
  wards: readonly Ward[],
  buildings: readonly Building[],
): string | null {
  if (!grant.scope || grant.scope === 'stake') return null;
  if (grant.kindoo_site_id) return grant.kindoo_site_id;
  // Legacy / un-migrated fallback: resolve through the ward's building.
  const ward = wards.find((w) => w.ward_code === grant.scope);
  if (!ward) return null;
  return resolveWardSite(ward, buildings);
}

/**
 * `true` when the seat is foreign-site-only: at least one grant, no
 * stake-scope grant, no grant resolving to the home site, and every
 * grant resolving to a foreign Kindoo site.
 *
 * Returns `false` for a seat with no grants (defensive — a real seat
 * always has its primary), for any seat carrying a stake-scope grant,
 * and for any seat with at least one home-site grant.
 */
export function isForeignSiteOnly(
  seat: Seat,
  wards: readonly Ward[],
  buildings: readonly Building[],
): boolean {
  const grants = grantsForDisplay(seat);
  if (grants.length === 0) return false;
  for (const grant of grants) {
    if (grant.scope === 'stake') return false;
    if (grantSiteId(grant, wards, buildings) === null) return false;
  }
  return true;
}

/**
 * `true` when the seat already holds a stake-scope grant (primary or
 * any duplicate). Drives the hide/disable of the "Give Access" button —
 * a member who already has home-site stake access has nothing to grant.
 */
export function hasStakeScopeGrant(seat: Seat): boolean {
  return grantsForDisplay(seat).some((g) => g.scope === 'stake');
}
