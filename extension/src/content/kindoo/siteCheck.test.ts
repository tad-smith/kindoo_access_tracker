// Tests for the Kindoo Sites Phase 3 orchestrator-entry guard.
// Exercises the truth table from `siteCheck.ts`:
//
//   - stake-scope + active EID == home          → proceed
//   - ward-scope (home ward) + active == home    → proceed
//   - ward-scope (foreign, kindoo_eid set) +
//     active matches foreign EID                 → proceed
//   - ward-scope (foreign, kindoo_eid null) +
//     active session name matches expected name  → proceed with populate
//   - any of the above with active != expected   → refuse
//   - foreign-site doc referenced by ward but
//     not present in the loaded set              → refuse
//   - stake-scope with no kindoo_config on stake → throws
//
// All paths are tested without any Kindoo network mocks — the check
// only reads from envs / stake / wards / kindooSites passed in by the
// caller.

import { describe, expect, it } from 'vitest';
import type { AccessRequest, KindooSite, Stake, Ward } from '@kindoo/shared';
import {
  checkRequestSite,
  ProvisionForeignSiteMissingError,
  ProvisionHomeSiteNotConfiguredError,
  ProvisionSiteMismatchError,
  resolveActiveKindooSite,
} from './siteCheck';
import type { KindooEnvironment } from './endpoints';

const HOME_EID = 27994;
const FOREIGN_EID = 4321;

const STAKE: Stake = {
  stake_id: 'csnorth',
  stake_name: 'Colorado Springs North Stake',
  kindoo_config: {
    site_id: HOME_EID,
    site_name: 'Colorado Springs North Stake',
  },
} as unknown as Stake;

const HOME_WARD: Ward = {
  ward_code: 'CO',
  ward_name: 'Cordera Ward',
  building_name: 'Cordera Building',
  // kindoo_site_id absent → home
} as unknown as Ward;

const FOREIGN_WARD: Ward = {
  ward_code: 'FN',
  ward_name: 'Foreign Ward',
  building_name: 'Foothills Building',
  kindoo_site_id: 'east-stake',
} as unknown as Ward;

const FOREIGN_SITE_WITH_EID: KindooSite = {
  id: 'east-stake',
  display_name: 'East Stake (Foothills Building)',
  kindoo_expected_site_name: 'East Stake',
  kindoo_eid: FOREIGN_EID,
} as unknown as KindooSite;

const FOREIGN_SITE_NO_EID: KindooSite = {
  id: 'east-stake',
  display_name: 'East Stake (Foothills Building)',
  kindoo_expected_site_name: 'East Stake',
  // kindoo_eid absent — Phase 3 auto-populate path
} as unknown as KindooSite;

function homeEnvs(name = 'Colorado Springs North Stake'): KindooEnvironment[] {
  return [{ EID: HOME_EID, Name: name } as unknown as KindooEnvironment];
}

function foreignEnvs(name = 'East Stake'): KindooEnvironment[] {
  return [{ EID: FOREIGN_EID, Name: name } as unknown as KindooEnvironment];
}

function stakeRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'r1',
    type: 'add_manual',
    scope: 'stake',
    member_email: 'tad.e.smith@gmail.com',
    member_canonical: 'tad.e.smith@gmail.com',
    building_names: ['Cordera Building'],
    ...overrides,
  } as unknown as AccessRequest;
}

function wardRequest(wardCode: string, overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    ...stakeRequest(),
    scope: wardCode,
    ...overrides,
  } as AccessRequest;
}

describe('checkRequestSite — stake-scope', () => {
  it('proceeds when the active session points at the home EID', () => {
    const result = checkRequestSite({
      request: stakeRequest(),
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(),
      stake: STAKE,
      wards: [HOME_WARD],
      kindooSites: [],
    });
    expect(result).toEqual({ ok: true });
  });

  it('refuses with the home site name when the active session points elsewhere', () => {
    const result = checkRequestSite({
      request: stakeRequest(),
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: foreignEnvs(),
      stake: STAKE,
      wards: [HOME_WARD],
      kindooSites: [FOREIGN_SITE_WITH_EID],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return; // narrowing
    expect(result.error).toBeInstanceOf(ProvisionSiteMismatchError);
    if (!(result.error instanceof ProvisionSiteMismatchError)) return;
    expect(result.error.expectedSiteName).toBe('Colorado Springs North Stake');
    expect(result.error.message).toContain('Switch Kindoo sites and try again');
  });

  it('honours kindoo_expected_site_name on the stake doc for the error wording', () => {
    const stake: Stake = {
      ...STAKE,
      kindoo_expected_site_name: 'CSN Stake',
    } as unknown as Stake;
    const result = checkRequestSite({
      request: stakeRequest(),
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: foreignEnvs(),
      stake,
      wards: [HOME_WARD],
      kindooSites: [FOREIGN_SITE_WITH_EID],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ProvisionSiteMismatchError);
    if (!(result.error instanceof ProvisionSiteMismatchError)) return;
    expect(result.error.expectedSiteName).toBe('CSN Stake');
  });

  it('throws when the stake doc has no kindoo_config', () => {
    const stake: Stake = {
      stake_id: 'csnorth',
      stake_name: 'Colorado Springs North Stake',
    } as unknown as Stake;
    expect(() =>
      checkRequestSite({
        request: stakeRequest(),
        session: { token: 'tok', eid: HOME_EID },
        envs: homeEnvs(),
        stake,
        wards: [HOME_WARD],
        kindooSites: [],
      }),
    ).toThrow(ProvisionHomeSiteNotConfiguredError);
  });
});

describe('checkRequestSite — ward-scope, home ward', () => {
  it('proceeds when ward has no kindoo_site_id and active points at home', () => {
    const result = checkRequestSite({
      request: wardRequest('CO'),
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(),
      stake: STAKE,
      wards: [HOME_WARD],
      kindooSites: [],
    });
    expect(result).toEqual({ ok: true });
  });

  it('proceeds when ward kindoo_site_id is explicitly null', () => {
    const ward: Ward = { ...HOME_WARD, kindoo_site_id: null } as unknown as Ward;
    const result = checkRequestSite({
      request: wardRequest('CO'),
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(),
      stake: STAKE,
      wards: [ward],
      kindooSites: [],
    });
    expect(result).toEqual({ ok: true });
  });

  it('refuses when ward is home-site but active session is foreign', () => {
    const result = checkRequestSite({
      request: wardRequest('CO'),
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: foreignEnvs(),
      stake: STAKE,
      wards: [HOME_WARD],
      kindooSites: [FOREIGN_SITE_WITH_EID],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ProvisionSiteMismatchError);
    if (!(result.error instanceof ProvisionSiteMismatchError)) return;
    expect(result.error.expectedSiteName).toBe('Colorado Springs North Stake');
  });
});

describe('checkRequestSite — ward-scope, foreign site', () => {
  it('proceeds when foreign site kindoo_eid matches the active session', () => {
    const result = checkRequestSite({
      request: wardRequest('FN'),
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: foreignEnvs(),
      stake: STAKE,
      wards: [FOREIGN_WARD],
      kindooSites: [FOREIGN_SITE_WITH_EID],
    });
    expect(result).toEqual({ ok: true });
  });

  it('refuses with the foreign site display_name (not slug, not kindoo_expected_site_name) when EID mismatches', () => {
    const result = checkRequestSite({
      request: wardRequest('FN'),
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(),
      stake: STAKE,
      wards: [FOREIGN_WARD],
      kindooSites: [FOREIGN_SITE_WITH_EID],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ProvisionSiteMismatchError);
    if (!(result.error instanceof ProvisionSiteMismatchError)) return;
    // Operator-facing wording must use the human-readable `display_name`,
    // never the slug (`east-stake`) or the internal matching key
    // (`kindoo_expected_site_name`).
    expect(result.error.expectedSiteName).toBe('East Stake (Foothills Building)');
    expect(result.error.message).toContain("'East Stake (Foothills Building)'");
    expect(result.error.message).toContain('Switch Kindoo sites and try again');
  });

  it('auto-populates the foreign site EID when active session name matches expected', () => {
    const result = checkRequestSite({
      request: wardRequest('FN'),
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: foreignEnvs('East Stake'),
      stake: STAKE,
      wards: [FOREIGN_WARD],
      kindooSites: [FOREIGN_SITE_NO_EID],
    });
    expect(result).toEqual({
      ok: true,
      populate: { kindooSiteId: 'east-stake', kindooEid: FOREIGN_EID },
    });
  });

  it('auto-populates after trim+lowercase normalisation of the site name', () => {
    const result = checkRequestSite({
      request: wardRequest('FN'),
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: foreignEnvs('  east stake  '),
      stake: STAKE,
      wards: [FOREIGN_WARD],
      kindooSites: [FOREIGN_SITE_NO_EID],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.populate).toEqual({ kindooSiteId: 'east-stake', kindooEid: FOREIGN_EID });
  });

  it('refuses (using display_name) when active session name does not match foreign expected name', () => {
    const result = checkRequestSite({
      request: wardRequest('FN'),
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(), // session is on home; foreign site expects 'East Stake'
      stake: STAKE,
      wards: [FOREIGN_WARD],
      kindooSites: [FOREIGN_SITE_NO_EID],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ProvisionSiteMismatchError);
    if (!(result.error instanceof ProvisionSiteMismatchError)) return;
    expect(result.error.expectedSiteName).toBe('East Stake (Foothills Building)');
  });

  it('refuses with ProvisionForeignSiteMissingError when ward references a kindoo_site_id not in the loaded set', () => {
    // The site isn't configured in SBA at all — switching Kindoo sites
    // won't help. Surface the dedicated missing-site error so the card
    // formatter can direct the operator to Configuration → Kindoo Sites
    // rather than telling them to switch sites.
    const stranded: Ward = {
      ...FOREIGN_WARD,
      kindoo_site_id: 'never-configured',
    } as unknown as Ward;
    const result = checkRequestSite({
      request: wardRequest('FN'),
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(),
      stake: STAKE,
      wards: [stranded],
      kindooSites: [], // empty — ward points at a site that was never added
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ProvisionForeignSiteMissingError);
    expect(result.error).not.toBeInstanceOf(ProvisionSiteMismatchError);
    // ProvisionForeignSiteMissingError carries the slug as kindooSiteId
    // (operator-actionable: it's what to add in Configuration), and the
    // message must NOT tell the operator to switch sites.
    if (result.error instanceof ProvisionForeignSiteMissingError) {
      expect(result.error.kindooSiteId).toBe('never-configured');
    }
    expect(result.error.message).toContain('never-configured');
    expect(result.error.message).not.toContain('Switch Kindoo sites');
  });

  it('refuses to auto-populate when foreign expected name collides with home and active session is on home', () => {
    // Footgun the reviewer flagged: a foreign KindooSite doc whose
    // `kindoo_expected_site_name` matches the home stake name (typo,
    // blank-then-copy, Kindoo-side rename). Operator is on a home
    // session. Without the home-collision guard the orchestrator would
    // return populate: { kindooEid: HOME_EID } and trap HOME_EID on the
    // foreign doc, permanently bypassing Phase 3.
    const collidingForeign: KindooSite = {
      id: 'east-stake',
      display_name: 'East Stake (Foothills Building)',
      // Whatever bug got us here, the foreign doc's expected name now
      // equals the home stake's name.
      kindoo_expected_site_name: 'Colorado Springs North Stake',
      // kindoo_eid absent — auto-populate path.
    } as unknown as KindooSite;
    const result = checkRequestSite({
      request: wardRequest('FN'),
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs('Colorado Springs North Stake'),
      stake: STAKE,
      wards: [FOREIGN_WARD],
      kindooSites: [collidingForeign],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ProvisionSiteMismatchError);
    if (!(result.error instanceof ProvisionSiteMismatchError)) return;
    expect(result.error.expectedSiteName).toBe('East Stake (Foothills Building)');
  });

  it('still auto-populates on name match when the active EID is not the home site_id', () => {
    // Sanity: the home-collision guard must not regress the legitimate
    // auto-populate path. Foreign session, foreign name match, foreign
    // EID — still returns populate.
    const result = checkRequestSite({
      request: wardRequest('FN'),
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: foreignEnvs('East Stake'),
      stake: STAKE,
      wards: [FOREIGN_WARD],
      kindooSites: [FOREIGN_SITE_NO_EID],
    });
    expect(result).toEqual({
      ok: true,
      populate: { kindooSiteId: 'east-stake', kindooEid: FOREIGN_EID },
    });
  });

  it('refuses (using display_name) when active session has no matching env entry (unknown site name)', () => {
    const result = checkRequestSite({
      request: wardRequest('FN'),
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: [], // no env match for the active eid
      stake: STAKE,
      wards: [FOREIGN_WARD],
      kindooSites: [FOREIGN_SITE_NO_EID],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ProvisionSiteMismatchError);
    if (!(result.error instanceof ProvisionSiteMismatchError)) return;
    expect(result.error.expectedSiteName).toBe('East Stake (Foothills Building)');
  });
});

describe('resolveActiveKindooSite — Phase 5 wizard helper', () => {
  it('returns home when EID matches stake.kindoo_config.site_id', () => {
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(),
      stake: STAKE,
      kindooSites: [],
    });
    expect(result).toEqual({ kind: 'home', displayName: 'Colorado Springs North Stake' });
  });

  it('returns home (by name) when kindoo_config is absent on the stake (first run)', () => {
    const stake: Stake = {
      stake_id: 'csnorth',
      stake_name: 'Colorado Springs North Stake',
    } as unknown as Stake;
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(),
      stake,
      kindooSites: [],
    });
    expect(result).toEqual({ kind: 'home', displayName: 'Colorado Springs North Stake' });
  });

  it('uses kindoo_expected_site_name as the home displayName when set', () => {
    const stake: Stake = {
      ...STAKE,
      kindoo_expected_site_name: 'CSN Stake',
    } as unknown as Stake;
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(),
      stake,
      kindooSites: [],
    });
    expect(result).toEqual({ kind: 'home', displayName: 'CSN Stake' });
  });

  it('returns foreign by EID when a kindooSites entry carries the active EID', () => {
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: foreignEnvs(),
      stake: STAKE,
      kindooSites: [FOREIGN_SITE_WITH_EID],
    });
    expect(result).toEqual({
      kind: 'foreign',
      siteId: 'east-stake',
      displayName: 'East Stake (Foothills Building)',
    });
  });

  it('returns foreign with populateEid when the foreign doc has no kindoo_eid and the name matches', () => {
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: foreignEnvs('East Stake'),
      stake: STAKE,
      kindooSites: [FOREIGN_SITE_NO_EID],
    });
    expect(result).toEqual({
      kind: 'foreign',
      siteId: 'east-stake',
      displayName: 'East Stake (Foothills Building)',
      populateEid: FOREIGN_EID,
    });
  });

  it('foreign name match is case- and whitespace-insensitive', () => {
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: foreignEnvs('  east stake  '),
      stake: STAKE,
      kindooSites: [FOREIGN_SITE_NO_EID],
    });
    expect(result.kind).toBe('foreign');
  });

  it('returns unknown when the active site name matches nothing the stake knows', () => {
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: 9999 },
      envs: [{ EID: 9999, Name: 'Stranger Stake' } as unknown as KindooEnvironment],
      stake: STAKE,
      kindooSites: [FOREIGN_SITE_WITH_EID],
    });
    expect(result).toEqual({ kind: 'unknown', activeSiteName: 'Stranger Stake' });
  });

  it('returns unknown when no env entry matches the active EID at all', () => {
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: 9999 },
      envs: [], // nothing
      stake: STAKE,
      kindooSites: [FOREIGN_SITE_WITH_EID],
    });
    expect(result).toEqual({ kind: 'unknown', activeSiteName: '' });
  });

  it('refuses to classify as home when active name matches home BUT a foreign site shares the same kindoo_expected_site_name', () => {
    // Symmetric leak the reviewer flagged. Scenario:
    //   - home configured: stake.kindoo_config.site_id = HOME_EID, name CSNS
    //   - operator misconfigures a foreign KindooSite whose
    //     kindoo_expected_site_name is accidentally also CSNS (typo /
    //     blank-then-copy / Kindoo-side rename)
    //   - foreign doc has no kindoo_eid yet
    //   - operator is on the FOREIGN session (eid 4321)
    // Step 1 home-by-EID fails (HOME_EID != FOREIGN_EID). Step 2 foreign-
    // by-EID fails (foreign has no kindoo_eid). Step 3 home-by-name
    // matched before this fix — wizard would call writeKindooConfig with
    // siteId: FOREIGN_EID and clobber home. Now step 3 must refuse on
    // name ambiguity; the load-bearing property is `result.kind !==
    // 'home'`. Step 4 (foreign by name) then catches it and returns
    // foreign with populateEid — that's a safe outcome: the writer
    // touches kindooSites/<id>, not stake.kindoo_config.
    const ambiguousForeign: KindooSite = {
      id: 'east-stake',
      display_name: 'East Stake (Foothills Building)',
      kindoo_expected_site_name: 'Colorado Springs North Stake',
      // kindoo_eid absent.
    } as unknown as KindooSite;
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: [
        { EID: FOREIGN_EID, Name: 'Colorado Springs North Stake' } as unknown as KindooEnvironment,
      ],
      stake: STAKE,
      kindooSites: [ambiguousForeign],
    });
    expect(result.kind).not.toBe('home');
    // The downstream classification is foreign (step 4 fires) — that
    // means the wizard's save will go through the foreign branch
    // (kindooSites/<id>) and the writer-side guard in data.ts will
    // verify payload.siteId doesn't collide with home.
    expect(result.kind).toBe('foreign');
    if (result.kind !== 'foreign') return;
    expect(result.siteId).toBe('east-stake');
    expect(result.populateEid).toBe(FOREIGN_EID);
  });

  it('refuses to classify as home when active EID collides with a known foreign kindoo_eid', () => {
    // Defense-in-depth: step 2 (foreign-by-EID) should have caught this
    // already, but if a duplicate / stale name match would otherwise let
    // step 3 fire on a foreign session, the EID-collision check refuses.
    // Construct a case where the home expected name and an active env
    // name both match (so step 3 would otherwise hit) AND the session
    // EID is recorded on a foreign doc — but force step 2 past it by
    // having the foreign doc's kindoo_expected_site_name also match
    // home, which still means step 2 returns first. Use a stake without
    // kindoo_config so step 1 is skipped, ensuring step 3's predicate is
    // the load-bearing one. (In practice this is a contrived edge — the
    // real load-bearing check is the name-ambiguity branch above.)
    const stakeNoConfig: Stake = {
      stake_id: 'csnorth',
      stake_name: 'Colorado Springs North Stake',
    } as unknown as Stake;
    // Foreign site whose kindoo_eid happens to match the session AND
    // whose expected name differs from home — step 2 catches it as
    // foreign before step 3 ever runs. The guard's role is to be a
    // belt-and-braces refusal if ordering ever changes.
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: FOREIGN_EID },
      envs: [
        { EID: FOREIGN_EID, Name: 'Colorado Springs North Stake' } as unknown as KindooEnvironment,
      ],
      stake: stakeNoConfig,
      kindooSites: [
        {
          id: 'east-stake',
          display_name: 'East Stake (Foothills Building)',
          kindoo_expected_site_name: 'East Stake',
          kindoo_eid: FOREIGN_EID,
        } as unknown as KindooSite,
      ],
    });
    // Step 2 wins: classify as foreign.
    expect(result.kind).toBe('foreign');
  });

  it('still classifies as home when only the home name matches and no foreign collides', () => {
    // Sanity: the new guard must not regress the legitimate first-run
    // home-by-name path. No foreign sites, name match → still home.
    const stakeNoConfig: Stake = {
      stake_id: 'csnorth',
      stake_name: 'Colorado Springs North Stake',
    } as unknown as Stake;
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(),
      stake: stakeNoConfig,
      kindooSites: [
        {
          id: 'east-stake',
          display_name: 'East Stake (Foothills Building)',
          kindoo_expected_site_name: 'East Stake',
        } as unknown as KindooSite,
      ],
    });
    expect(result.kind).toBe('home');
  });

  it('prefers home (EID match) over a foreign site that shares a stale EID record', () => {
    // Defensive: a foreign doc still carrying a stale kindoo_eid that
    // happens to collide with home's site_id shouldn't override the
    // stake's authoritative home_eid.
    const stale: KindooSite = {
      ...FOREIGN_SITE_WITH_EID,
      kindoo_eid: HOME_EID,
    } as unknown as KindooSite;
    const result = resolveActiveKindooSite({
      session: { token: 'tok', eid: HOME_EID },
      envs: homeEnvs(),
      stake: STAKE,
      kindooSites: [stale],
    });
    expect(result.kind).toBe('home');
  });
});
