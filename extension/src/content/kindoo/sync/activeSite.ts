// Identify which Kindoo Site the operator's active Kindoo session is
// pointed at, given the SBA-side configuration. Used by the Sync
// detector to scope drift comparisons to just the wards / seats that
// live on the active site (Phase 4 — see `docs/spec.md` §15).
//
// Three outcomes:
//   - `home`            — active EID matches `stake.kindoo_config.site_id`.
//   - `foreign(siteId)` — active EID matches some `KindooSite.kindoo_eid`.
//   - `unknown`         — neither. Operator logged into a Kindoo site
//                         SBA doesn't know about; the detector returns
//                         an empty diff and the panel surfaces an
//                         empty-state recovery message.
//
// Pure function. The active EID comes from
// `localStorage.state.sites.ids[0]` via `content/kindoo/auth.ts`.

import type { KindooSite, Stake } from '@kindoo/shared';

export type ActiveSite =
  | { kind: 'home' }
  | { kind: 'foreign'; siteId: string }
  | { kind: 'unknown' };

/**
 * Resolve the active Kindoo site for the given Kindoo session.
 *
 * Home wins over a foreign-site match if both happen to share the same
 * EID — defensive, since the SBA configuration would be malformed in
 * that case, but worth being explicit about.
 */
export function identifyActiveSite(
  activeEid: number,
  stake: Stake,
  kindooSites: KindooSite[],
): ActiveSite {
  const homeEid = stake.kindoo_config?.site_id;
  if (typeof homeEid === 'number' && homeEid === activeEid) {
    return { kind: 'home' };
  }
  for (const site of kindooSites) {
    if (typeof site.kindoo_eid === 'number' && site.kindoo_eid === activeEid) {
      return { kind: 'foreign', siteId: site.id };
    }
  }
  return { kind: 'unknown' };
}
