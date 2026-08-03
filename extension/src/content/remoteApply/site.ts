// Which SBA-side Kindoo site is this tab sitting in?
//
// Remote-apply presence is per site, not per manager: a tab can only
// provision for the Kindoo site it is currently inside, so its liveness
// doc is keyed by that site and its job claims are filtered by it. Both
// need an SBA-side identifier, and all the tab has is a Kindoo EID.
//
// The EID → site mapping already exists — `resolveActiveKindooSite` is
// what the configure wizard uses to decide which site it is configuring,
// and it carries hard-won guards against a home session trapping HOME_EID
// onto a foreign doc. This module is a thin adapter over it, deliberately
// not a second matcher.
//
// What it adds is the site KEY: the doc-id form of a Kindoo site, which
// is `remoteApplySiteKey`'s job because the home site has no `kindooSites`
// document to borrow an id from (it lives on `stake.kindoo_config`) and a
// Firestore doc id cannot be null.

import { remoteApplySiteKey } from '@kindoo/shared';
import type { StakeConfigBundle } from '../../lib/extensionApi';
import type { KindooSession } from '../kindoo/auth';
import type { KindooEnvironment } from '../kindoo/endpoints';
import { resolveActiveKindooSite } from '../kindoo/siteCheck';

export interface ResolvedTabSite {
  /**
   * Document id under `remoteApply/{canonical}/desktops/`, and the value
   * compared against a job's `target_site_key`. Both surfaces derive it
   * through `remoteApplySiteKey`, so they cannot drift.
   */
  siteKey: string;
  /** Foreign `kindooSites` doc id, or `null` for the home site. Published
   * alongside the key for legibility, mirroring how wards and buildings
   * already spell "home". */
  kindooSiteId: string | null;
  /**
   * EID this resolution was computed for. The loop re-resolves when the
   * live session's EID no longer matches: Kindoo is an SPA, so the
   * operator can switch sites with no page load and no remount.
   */
  kindooEid: number;
}

export interface ResolveTabSiteArgs {
  session: KindooSession;
  /** `getEnvironments(session)` output — the site-name lookup table. */
  envs: KindooEnvironment[];
  bundle: StakeConfigBundle;
}

/**
 * The SBA-side site this tab can act for, or `null` when its EID maps to
 * nothing this stake has configured.
 *
 * `null` is a publish-nothing signal, not an error. A tab inside an
 * unconfigured Kindoo site cannot name the site to the phone and could
 * not provision for it either, so the honest thing is to stay invisible —
 * absence of a heartbeat is exactly how the phone learns a desktop is
 * unusable.
 */
export function resolveTabSite({
  session,
  envs,
  bundle,
}: ResolveTabSiteArgs): ResolvedTabSite | null {
  const resolution = resolveActiveKindooSite({
    session,
    envs,
    stake: bundle.stake,
    kindooSites: bundle.kindooSites,
  });
  if (resolution.kind === 'unknown') return null;
  const kindooSiteId = resolution.kind === 'foreign' ? resolution.siteId : null;
  return {
    siteKey: remoteApplySiteKey(kindooSiteId),
    kindooSiteId,
    kindooEid: session.eid,
  };
}

/** The Kindoo-side display name for the active session's site, or `null`
 * when the envs list doesn't carry it. Published verbatim as
 * `kindoo_site_name` so the phone names the site the manager would see on
 * their desktop, not SBA's own label for it. */
export function activeKindooSiteName(
  envs: KindooEnvironment[],
  session: KindooSession,
): string | null {
  return envs.find((e) => e.EID === session.eid)?.Name ?? null;
}
