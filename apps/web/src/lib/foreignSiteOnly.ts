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
 * The grant that should carry the "Already has stake access" note, or
 * `null` when the seat shouldn't carry one.
 *
 * Answers the narrow question: *would this seat qualify for the "Give
 * Access To Stake Buildings" button if the stake grant weren't already
 * there?* So every NON-stake grant must resolve to a foreign site — a
 * member with a home-site ward grant is disqualified from the button
 * independently, and telling them the stake grant is the reason would be
 * false.
 *
 * Returns the FIRST foreign-site grant, which is the row the button would
 * have appeared on. Placing the note per-seat instead put it on the
 * primary — and in the shape this exists for (B-23: stake primary +
 * foreign ward duplicate) the primary IS the stake row, so the note landed
 * next to a Scope chip already reading "Stake" while the foreign ward row,
 * the one whose neighbours all carry the button, said nothing. Under a
 * scope filter for that ward it vanished entirely.
 */
export function stakeAccessNoteGrant(
  seat: Seat,
  wards: readonly Ward[],
  buildings: readonly Building[],
): GrantView | null {
  // The precondition lives here, not in the caller: without it this
  // returns a grant for a seat with NO stake grant — the foreign-site-only
  // member who should get the BUTTON — so a second caller forgetting the
  // check would tell them they already have access they don't have.
  if (!hasStakeScopeGrant(seat)) return null;
  const nonStake = grantsForDisplay(seat).filter((g) => g.scope !== 'stake');
  if (nonStake.length === 0) return null;
  if (!nonStake.every((g) => grantSiteId(g, wards, buildings) !== null)) return null;
  return nonStake[0] ?? null;
}

/**
 * `true` when the seat already holds a stake-scope grant (primary or
 * any duplicate). Drives the hide/disable of the "Give Access" button —
 * a member who already has home-site stake access has nothing to grant.
 */
export function hasStakeScopeGrant(seat: Seat): boolean {
  return grantsForDisplay(seat).some((g) => g.scope === 'stake');
}
