// Kindoo Sites Phase 3 — orchestrator entry guard.
//
// Before any provision flow drives a write to Kindoo, validate that
// the active Kindoo session's EID matches the EID of the Kindoo site
// the request targets. Per spec §15 the operator can be a Kindoo
// Manager on multiple Kindoo sites; running a provision against the
// wrong session would grant access in the wrong physical buildings.
//
// Inputs the caller assembles:
//   - request           — the SBA AccessRequest about to be provisioned
//   - session           — readKindooSession() result (eid)
//   - envs              — KindooGetEnvironments output (so we can pull
//                         the active session's site Name)
//   - stake             — stake doc; carries home `kindoo_config.site_id`
//                         + `kindoo_expected_site_name` fallback
//   - wards             — ward docs; ward.kindoo_site_id resolves the
//                         expected foreign site for a ward-scope request
//   - kindooSites       — foreign KindooSite docs; carry expected
//                         site name + (when populated) kindoo_eid
//
// Expected EID resolution:
//   - request.scope === 'stake' → home (`stake.kindoo_config.site_id`).
//   - request.scope === <ward_code>:
//     - ward.kindoo_site_id null / absent → home
//     - ward.kindoo_site_id = <id> → foreign `kindooSites/<id>`
//
// Foreign-site auto-populate: if the matched foreign site has
// `kindoo_eid` null / absent, compare the active session's site name
// (from `envs.find(EID).Name`) against the foreign site's
// `kindoo_expected_site_name`. Name match → return a `populate`
// instruction so the caller persists the discovered EID and proceeds.
// Mismatch → refuse.
//
// Returns a discriminated result:
//   - { ok: true }                        proceed
//   - { ok: true, populate: { kindooSiteId, kindooEid } }
//                                         proceed; caller must persist
//                                         the EID first
//   - { ok: false, error }                refuse; caller surfaces the
//                                         error message verbatim
//
// All comparisons normalise via the same trim+lowercase used by the
// v2.1 site-name verification in ConfigurePanel — so trivial casing
// drift in Kindoo's site name doesn't trip the guard.

import type { AccessRequest, KindooSite, Stake, Ward } from '@kindoo/shared';
import type { KindooEnvironment } from './endpoints';
import type { KindooSession } from './auth';

export type SiteCheckResult =
  | { ok: true; populate?: { kindooSiteId: string; kindooEid: number } }
  | { ok: false; error: ProvisionSiteMismatchError };

/**
 * Active Kindoo session doesn't match the EID the request needs. The
 * caller renders `error.message` inline on the request card and stops
 * before any Kindoo write fires.
 */
export class ProvisionSiteMismatchError extends Error {
  readonly code = 'site-mismatch' as const;
  readonly expectedSiteName: string;
  constructor(expectedSiteName: string) {
    super(
      `This request needs to be provisioned on '${expectedSiteName}'. ` +
        `Switch Kindoo sites and try again.`,
    );
    this.name = 'ProvisionSiteMismatchError';
    this.expectedSiteName = expectedSiteName;
  }
}

/**
 * Home-site `kindoo_config.site_id` is missing on the stake doc. v2.1
 * configuration should have populated this; if we reach this state the
 * orchestrator can't tell home from foreign. Surface a distinct error
 * so the operator knows to re-run Configure.
 */
export class ProvisionHomeSiteNotConfiguredError extends Error {
  readonly code = 'home-site-not-configured' as const;
  constructor() {
    super(
      'Kindoo home site is not configured for this stake. ' +
        'Run "Configure Kindoo" and try again.',
    );
    this.name = 'ProvisionHomeSiteNotConfiguredError';
  }
}

/**
 * A ward-scope request references a foreign `kindoo_site_id` whose
 * `KindooSite` doc isn't in the loaded set. Either the configuration
 * wizard removed the foreign site without re-pointing the ward, or
 * the bundle is stale. Either way the orchestrator can't resolve the
 * target EID — surface a clean error pointing the operator at
 * Configure.
 */
export class ProvisionForeignSiteMissingError extends Error {
  readonly code = 'foreign-site-missing' as const;
  readonly kindooSiteId: string;
  constructor(kindooSiteId: string) {
    super(
      `Ward references Kindoo site '${kindooSiteId}' but that site is not configured. ` +
        `Run "Configure Kindoo" to add the site or re-point the ward.`,
    );
    this.name = 'ProvisionForeignSiteMissingError';
    this.kindooSiteId = kindooSiteId;
  }
}

export interface CheckRequestSiteArgs {
  request: AccessRequest;
  session: KindooSession;
  envs: KindooEnvironment[];
  stake: Stake;
  wards: Ward[];
  kindooSites: KindooSite[];
}

/** Normalise Kindoo site names the same way the v2.1 wizard does. */
function normaliseName(s: string): string {
  return s.trim().toLowerCase();
}

/** Read the active session's site Name from the envs list. Falls back
 * to an empty string when no env matches (the caller treats empty as
 * "unknown" and refuses on any mismatch). */
function activeSiteName(envs: KindooEnvironment[], session: KindooSession): string {
  const env = envs.find((e) => e.EID === session.eid);
  return env ? env.Name : '';
}

/** Resolve the foreign-site doc referenced by the ward; `null` for
 * home (ward absent / no `kindoo_site_id` / explicit null). Throws
 * `ProvisionForeignSiteMissingError` when the ward points at an id
 * that isn't in the loaded kindooSites set. */
function resolveWardSite(
  wardCode: string,
  wards: Ward[],
  kindooSites: KindooSite[],
): KindooSite | null {
  const ward = wards.find((w) => w.ward_code === wardCode);
  if (!ward) return null;
  const siteId = ward.kindoo_site_id;
  if (siteId === null || siteId === undefined) return null;
  const site = kindooSites.find((s) => s.id === siteId);
  if (!site) throw new ProvisionForeignSiteMissingError(siteId);
  return site;
}

/**
 * Verify the active Kindoo session's EID matches the request's target
 * Kindoo site. Returns `{ ok: true }` to proceed; `{ ok: true,
 * populate }` to proceed after the caller persists a freshly-discovered
 * foreign-site EID; `{ ok: false, error }` to refuse before any Kindoo
 * write.
 *
 * Caller contract:
 *   - On `populate`, call `writeKindooSiteEid(...)` BEFORE proceeding
 *     to the orchestrator. The orchestrator's own writes don't need the
 *     EID on the doc — but persisting it now means the next provision
 *     against this foreign site short-circuits to the no-populate path.
 *   - On `ok: false`, surface `error.message` verbatim — the wording is
 *     the operator-locked-in directive ("Switch Kindoo sites and try
 *     again").
 */
export function checkRequestSite(args: CheckRequestSiteArgs): SiteCheckResult {
  const { request, session, envs, stake, wards, kindooSites } = args;

  // ---- Resolve the expected site ----
  let expectedEid: number | null = null;
  let expectedSiteName: string;

  if (request.scope === 'stake') {
    if (!stake.kindoo_config) {
      throw new ProvisionHomeSiteNotConfiguredError();
    }
    expectedEid = stake.kindoo_config.site_id;
    expectedSiteName = stake.kindoo_expected_site_name?.trim() || stake.stake_name;
  } else {
    let wardSite: KindooSite | null;
    try {
      wardSite = resolveWardSite(request.scope, wards, kindooSites);
    } catch (err) {
      // Caller surfaces this as an error before any Kindoo write.
      return {
        ok: false,
        error:
          err instanceof ProvisionForeignSiteMissingError
            ? new ProvisionSiteMismatchError(err.kindooSiteId)
            : new ProvisionSiteMismatchError('unknown site'),
      };
    }
    if (!wardSite) {
      // Home-site ward — same logic as stake-scope.
      if (!stake.kindoo_config) {
        throw new ProvisionHomeSiteNotConfiguredError();
      }
      expectedEid = stake.kindoo_config.site_id;
      expectedSiteName = stake.kindoo_expected_site_name?.trim() || stake.stake_name;
    } else {
      // Foreign-site ward.
      expectedSiteName = wardSite.kindoo_expected_site_name;
      if (wardSite.kindoo_eid !== undefined && wardSite.kindoo_eid !== null) {
        expectedEid = wardSite.kindoo_eid;
      } else {
        // Auto-populate path: no EID on the foreign-site doc yet.
        // Compare the active session's site name; on match, the
        // caller persists `kindoo_eid = session.eid` and proceeds.
        const actual = activeSiteName(envs, session);
        if (actual.length > 0 && normaliseName(actual) === normaliseName(expectedSiteName)) {
          return {
            ok: true,
            populate: { kindooSiteId: wardSite.id, kindooEid: session.eid },
          };
        }
        return { ok: false, error: new ProvisionSiteMismatchError(expectedSiteName) };
      }
    }
  }

  // ---- Compare against the active session ----
  if (expectedEid === session.eid) {
    return { ok: true };
  }
  return { ok: false, error: new ProvisionSiteMismatchError(expectedSiteName) };
}
