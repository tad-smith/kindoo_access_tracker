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
// Home-collision guard: refuse to auto-populate when the active
// session's EID is the home `kindoo_config.site_id`, even if the
// active site name matches the foreign doc's
// `kindoo_expected_site_name`. Otherwise a misconfigured foreign doc
// (typo / blank-then-copy / Kindoo-side rename that ends up matching
// the home name) would let a home session persist HOME_EID onto the
// foreign doc, and every subsequent foreign-ward provision on a home
// session would silently target home — exactly the failure mode
// Phase 3 was built to prevent.
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
  | { ok: false; error: ProvisionSiteMismatchError | ProvisionForeignSiteMissingError };

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
      // Ward references a `kindoo_site_id` whose KindooSite doc isn't
      // in the loaded set. Surface the dedicated error class so the
      // operator-facing message can direct them to Configure (NOT to
      // switch sites, which won't help).
      if (err instanceof ProvisionForeignSiteMissingError) {
        return { ok: false, error: err };
      }
      throw err;
    }
    if (!wardSite) {
      // Home-site ward — same logic as stake-scope.
      if (!stake.kindoo_config) {
        throw new ProvisionHomeSiteNotConfiguredError();
      }
      expectedEid = stake.kindoo_config.site_id;
      expectedSiteName = stake.kindoo_expected_site_name?.trim() || stake.stake_name;
    } else {
      // Foreign-site ward. Mismatch error wording uses `display_name`
      // (operator-facing label) — the `kindoo_expected_site_name` is an
      // internal config knob used for name-based matching only.
      expectedSiteName = wardSite.display_name;
      if (wardSite.kindoo_eid !== undefined && wardSite.kindoo_eid !== null) {
        expectedEid = wardSite.kindoo_eid;
      } else {
        // Auto-populate path: no EID on the foreign-site doc yet.
        // Compare the active session's site name (matched against the
        // internal `kindoo_expected_site_name`); on match, the caller
        // persists `kindoo_eid = session.eid` and proceeds.
        //
        // Home-collision guard: if the active session's EID is the
        // home `kindoo_config.site_id`, refuse — even on a name match
        // — so a foreign doc whose `kindoo_expected_site_name` collides
        // with the home name can never trap HOME_EID onto the foreign
        // doc. The Phase 5 resolver applies the equivalent ordering;
        // this is the orchestrator-entry equivalent.
        const actual = activeSiteName(envs, session);
        const nameMatches =
          actual.length > 0 &&
          normaliseName(actual) === normaliseName(wardSite.kindoo_expected_site_name);
        const sessionIsHome = stake.kindoo_config?.site_id === session.eid;
        // Cross-foreign-EID collision guard (defense-in-depth from PR #124
        // review). If `session.eid` is already recorded as ANOTHER foreign
        // site's `kindoo_eid`, refuse — even on a name match. Would
        // require two foreign `KindooSite` docs colliding on EID (legacy
        // bad data) to trip, but the guard keeps a buggy populate from
        // silently re-routing access between foreign sites.
        const sessionEidCollidesOtherForeign = kindooSites.some(
          (s) => s.id !== wardSite.id && s.kindoo_eid === session.eid,
        );
        if (nameMatches && !sessionIsHome && !sessionEidCollidesOtherForeign) {
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

// ---------------------------------------------------------------------------
// Active Kindoo site resolver — used by the Phase 5 configure wizard to scope
// building→rule mapping to the operator's current Kindoo session. The
// orchestrator-entry guard above resolves an EXPECTED site from a request; this
// resolves the ACTUAL site the operator is currently authenticated against.
// ---------------------------------------------------------------------------

/**
 * Active Kindoo session classified against the stake's configured sites.
 *
 *  - `'home'`     — session points at the home site (matched by EID when the
 *                   stake has a `kindoo_config.site_id`, else by name against
 *                   `kindoo_expected_site_name || stake_name` for first-run
 *                   home configuration).
 *  - `'foreign'`  — session matches a foreign `KindooSite` doc (by `kindoo_eid`
 *                   when set, else by name against `kindoo_expected_site_name`).
 *                   `populateEid` is set when the foreign site doc has no
 *                   `kindoo_eid` yet — caller must persist `session.eid` onto
 *                   the doc before / alongside its rule-mapping writes.
 *  - `'unknown'`  — session site name is empty or matches nothing the stake
 *                   knows about. Wizard refuses in this state.
 *
 * `displayName` is what the wizard renders in its header
 * (`"Configuring: <displayName>"`). For home this is the stake's
 * `kindoo_expected_site_name || stake_name`; for foreign it's
 * `KindooSite.display_name`.
 */
export type ActiveSiteResolution =
  | { kind: 'home'; displayName: string }
  | {
      kind: 'foreign';
      siteId: string;
      displayName: string;
      /** When the foreign site doc has no `kindoo_eid` yet, the wizard must
       * persist `session.eid` onto the doc on save. */
      populateEid?: number;
    }
  | { kind: 'unknown'; activeSiteName: string };

export interface ResolveActiveKindooSiteArgs {
  session: KindooSession;
  envs: KindooEnvironment[];
  stake: Stake;
  kindooSites: KindooSite[];
}

/**
 * Classify the active Kindoo session against the stake's configured sites.
 * Pure — no network. Caller supplies `envs` from `getEnvironments(session)`.
 *
 * Resolution order:
 *   1. Home by EID — `stake.kindoo_config.site_id === session.eid`.
 *   2. Foreign by EID — `kindooSites.some(s => s.kindoo_eid === session.eid)`.
 *   3. Home by name — active session's site name matches
 *      `stake.kindoo_expected_site_name || stake.stake_name`. Covers first-run
 *      configuration when `kindoo_config` isn't set yet.
 *   4. Foreign by name — active session's site name matches some
 *      `KindooSite.kindoo_expected_site_name`. The result carries
 *      `populateEid: session.eid` so the caller can backfill `kindoo_eid`.
 *   5. Otherwise unknown.
 */
export function resolveActiveKindooSite(args: ResolveActiveKindooSiteArgs): ActiveSiteResolution {
  const { session, envs, stake, kindooSites } = args;
  const activeName = activeSiteName(envs, session);
  const normalisedActive = activeName.length > 0 ? normaliseName(activeName) : '';

  const homeExpectedName = stake.kindoo_expected_site_name?.trim() || stake.stake_name;

  // 1. Home by EID.
  if (stake.kindoo_config && stake.kindoo_config.site_id === session.eid) {
    return { kind: 'home', displayName: homeExpectedName };
  }

  // 2. Foreign by EID.
  const foreignByEid = kindooSites.find(
    (s) => s.kindoo_eid !== undefined && s.kindoo_eid !== null && s.kindoo_eid === session.eid,
  );
  if (foreignByEid) {
    return {
      kind: 'foreign',
      siteId: foreignByEid.id,
      displayName: foreignByEid.display_name,
    };
  }

  // 3. Home by name (first-run / config-not-yet-set fallback).
  //
  // Symmetric home-collision guard: refuse the home classification when
  // either the active session's EID is also a known foreign `kindoo_eid`
  // (defense-in-depth: step 2 should already have classified this as
  // foreign, but a stale / duplicate record must never fall through to
  // home), or the active name is ambiguous — i.e. ALSO matches some
  // foreign `kindoo_expected_site_name`. Without this guard a foreign
  // KindooSite whose expected name accidentally collides with the home
  // name (typo, blank-then-copy, Kindoo-side rename) would let a
  // foreign session resolve as `home` and the wizard's home-save path
  // would overwrite `stake.kindoo_config.site_id` with FOREIGN_EID,
  // permanently misconfiguring home.
  if (normalisedActive.length > 0 && normalisedActive === normaliseName(homeExpectedName)) {
    const sessionEidCollidesForeign = kindooSites.some(
      (s) => s.kindoo_eid !== undefined && s.kindoo_eid !== null && s.kindoo_eid === session.eid,
    );
    const nameCollidesForeign = kindooSites.some(
      (s) => normaliseName(s.kindoo_expected_site_name) === normalisedActive,
    );
    if (!sessionEidCollidesForeign && !nameCollidesForeign) {
      return { kind: 'home', displayName: homeExpectedName };
    }
  }

  // 4. Foreign by name (auto-populate EID on save).
  if (normalisedActive.length > 0) {
    const foreignByName = kindooSites.find(
      (s) => normaliseName(s.kindoo_expected_site_name) === normalisedActive,
    );
    if (foreignByName) {
      return {
        kind: 'foreign',
        siteId: foreignByName.id,
        displayName: foreignByName.display_name,
        populateEid: session.eid,
      };
    }
  }

  // 5. Nothing matched.
  return { kind: 'unknown', activeSiteName: activeName };
}
