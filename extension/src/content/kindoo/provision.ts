// v2.2 — orchestrates the Kindoo-side work for one SBA AccessRequest.
//
// Two top-level functions:
//   - provisionAddOrChange(req, ...) for `add_manual` / `add_temp`
//   - provisionRemove(req, ...)      for `remove`
//
// Each runs the captured "unified provision shape" from
// `extension/docs/v2-kindoo-api-capture.md`:
//
//   add (new user):       checkUserType -> inviteUser -> saveAccessRule
//   add (existing user):  checkUserType -> saveAccessRule
//   remove:               lookupUserByEmail -> revokeUser  (no-op if not found)
//
// Idempotent on retry: the lookup steps come first, so re-clicking the
// button after a transient Kindoo error resumes from the existing state
// (an already-invited user is matched as existing; a SaveAccessRule
// retry re-applies the same RIDs which is harmless).
//
// On any error we throw — the caller (RequestCard) renders inline and
// re-enables the button. Successful returns carry the synthesized note
// that the result dialog displays and that markRequestComplete persists
// on the request doc.

import type { AccessRequest, Building, Stake, Ward } from '@kindoo/shared';
import type { KindooSession } from './auth';
import type { KindooEnvironment, KindooInviteUserPayload } from './endpoints';
import {
  checkUserType,
  inviteUser,
  lookupUserByEmail,
  revokeUser,
  saveAccessRule,
} from './endpoints';
import { KindooApiError } from './client';

/** Returned by both orchestrators. */
export interface ProvisionResult {
  /** Kindoo internal UID. `null` only on the no-op remove path. */
  kindoo_uid: string | null;
  /** Discriminator for what physically happened in Kindoo. */
  action: 'added' | 'updated' | 'removed' | 'noop-remove';
  /** Human-readable summary; rendered in the result dialog AND
   * persisted on the request doc as `provisioning_note`. */
  note: string;
}

/** Caller-supplied dependency surface. Letting the caller hand in `fetch`
 * keeps the orchestrator easy to unit-test against mock endpoints
 * without a network call. */
export interface ProvisionDeps {
  fetchImpl?: typeof fetch;
}

/**
 * One of the buildings on the request has no Kindoo Access Rule mapped.
 * Caller catches and offers the "Reconfigure" recovery (matching v2.1's
 * locked-in block-on-missing-mapping decision).
 */
export class ProvisionBuildingsMissingRuleError extends Error {
  readonly code = 'buildings-missing-rule' as const;
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Buildings have no Kindoo Access Rule mapped: ${missing.join(', ')}. ` +
        `Re-run "Configure Kindoo" to map them, then retry.`,
    );
    this.name = 'ProvisionBuildingsMissingRuleError';
    this.missing = missing;
  }
}

/** No env entry matched the session's EID; we cannot resolve the
 * ExpiryTimeZone the invite payload requires. */
export class ProvisionEnvironmentNotFoundError extends Error {
  readonly code = 'environment-not-found' as const;
  constructor(eid: number) {
    super(`Kindoo did not return an environment matching EID=${eid}.`);
    this.name = 'ProvisionEnvironmentNotFoundError';
  }
}

// ---- Helpers ---------------------------------------------------------

/**
 * Pick the display name shown in the Kindoo "Description" field. Stake
 * scope mirrors the v2.1 wizard's resolution (`kindoo_expected_site_name`
 * takes precedence over `stake_name`); ward scope reads the matching
 * ward doc by `ward_code`. Falls back to the scope string verbatim
 * when no ward doc matches — keeps the description meaningful even if
 * the SBA wards collection is out of sync.
 */
function resolveScopeName(req: AccessRequest, stake: Stake, wards: Ward[]): string {
  if (req.scope === 'stake') {
    const override = stake.kindoo_expected_site_name?.trim();
    return override && override.length > 0 ? override : stake.stake_name;
  }
  const ward = wards.find((w) => w.ward_code === req.scope);
  return ward ? ward.ward_name : req.scope;
}

/**
 * Resolve the buildings the request grants access to into Kindoo RIDs.
 * For `scope === 'stake'`, the request's `building_names[]` is the
 * explicit list. For a ward scope, the building is implicit — pulled
 * from the ward doc's `building_name` field.
 *
 * Throws `ProvisionBuildingsMissingRuleError` if any resolved building
 * lacks a mapped `kindoo_rule.rule_id`.
 */
function resolveRids(
  req: AccessRequest,
  buildings: Building[],
  wards: Ward[],
): { rids: number[]; buildingNames: string[] } {
  let buildingNames: string[];
  if (req.scope === 'stake') {
    buildingNames = req.building_names;
  } else {
    const ward = wards.find((w) => w.ward_code === req.scope);
    buildingNames = ward ? [ward.building_name] : [];
  }

  const rids: number[] = [];
  const missing: string[] = [];
  for (const name of buildingNames) {
    const b = buildings.find((bldg) => bldg.building_name === name);
    if (!b || !b.kindoo_rule) {
      missing.push(name);
      continue;
    }
    rids.push(b.kindoo_rule.rule_id);
  }
  if (missing.length > 0) {
    throw new ProvisionBuildingsMissingRuleError(missing);
  }
  return { rids, buildingNames };
}

/**
 * Resolve the env entry for the active session's EID. Throws if no
 * match — we cannot proceed without the env's `TimeZone` to populate
 * `ExpiryTimeZone` on the invite payload.
 */
function findEnvironment(envs: KindooEnvironment[], session: KindooSession): KindooEnvironment {
  const env = envs.find((e) => e.EID === session.eid);
  if (!env) throw new ProvisionEnvironmentNotFoundError(session.eid);
  return env;
}

/** Format a list of building names into the prose suffix the result
 * dialog uses. One name renders as "Cordera Building"; multiple as
 * "Cordera Building, Pine Creek Building". */
function joinBuildingNames(names: string[]): string {
  return names.join(', ');
}

// ---- Add / change ----------------------------------------------------

export interface ProvisionAddOrChangeArgs {
  request: AccessRequest;
  stake: Stake;
  buildings: Building[];
  wards: Ward[];
  envs: KindooEnvironment[];
  session: KindooSession;
  deps?: ProvisionDeps;
}

/**
 * Add or change a user's Kindoo access to match the request.
 *
 * Flow:
 *   1. Resolve RIDs from the request's effective buildings.
 *   2. Resolve env (for TimeZone).
 *   3. checkUserType(email).
 *   4. If not exists → inviteUser; capture UID.
 *   5. saveAccessRule(UID, RIDs).
 *
 * `request.type === 'add_temp'` switches the invite payload to
 * `IsTempUser=true` with `StartAccessDoorsDate` / `ExpiryDate` derived
 * from `request.start_date` + `request.end_date` (full-day bounds).
 */
export async function provisionAddOrChange(
  args: ProvisionAddOrChangeArgs,
): Promise<ProvisionResult> {
  if (args.request.type !== 'add_manual' && args.request.type !== 'add_temp') {
    throw new Error(`provisionAddOrChange called with non-add type "${args.request.type}"`);
  }

  const { rids, buildingNames } = resolveRids(args.request, args.buildings, args.wards);
  const env = findEnvironment(args.envs, args.session);
  const scopeName = resolveScopeName(args.request, args.stake, args.wards);
  const fetchImpl = args.deps?.fetchImpl;

  const probe = await checkUserType(args.session, args.request.member_email, fetchImpl);

  let uid: string;
  let action: 'added' | 'updated';

  if (probe.exists && probe.uid) {
    uid = probe.uid;
    action = 'updated';
  } else {
    const payload = buildInvitePayload(args.request, scopeName, env);
    const invited = await inviteUser(args.session, payload, fetchImpl);
    uid = invited.uid;
    action = 'added';
  }

  await saveAccessRule(args.session, uid, rids, fetchImpl);

  const note = synthesizeAddNote(action, args.request, buildingNames);
  return { kindoo_uid: uid, action, note };
}

function buildInvitePayload(
  req: AccessRequest,
  scopeName: string,
  env: KindooEnvironment,
): KindooInviteUserPayload {
  // `TimeZone` field on the env object is Windows-style
  // ("Mountain Standard Time"); Kindoo expects that exact wire form.
  const rawTz = env.TimeZone;
  const tz = typeof rawTz === 'string' && rawTz.length > 0 ? rawTz : 'Mountain Standard Time';

  const isTemp = req.type === 'add_temp';
  const description = `${scopeName} (${req.reason})`;

  if (isTemp) {
    // SBA stores YYYY-MM-DD only; combine with full-day bounds.
    const start = req.start_date ?? '';
    const end = req.end_date ?? '';
    if (!start || !end) {
      throw new KindooApiError(
        'unexpected-shape',
        `add_temp request ${req.request_id} missing start_date or end_date`,
      );
    }
    return {
      UserEmail: req.member_email,
      UserRole: 2,
      Description: description,
      CCInEmail: false,
      IsTempUser: true,
      StartAccessDoorsDate: `${start} 00:00`,
      ExpiryDate: `${end} 23:59`,
      ExpiryTimeZone: tz,
    };
  }

  return {
    UserEmail: req.member_email,
    UserRole: 2,
    Description: description,
    CCInEmail: false,
    IsTempUser: false,
    StartAccessDoorsDate: null,
    ExpiryDate: null,
    ExpiryTimeZone: tz,
  };
}

function synthesizeAddNote(
  action: 'added' | 'updated',
  req: AccessRequest,
  buildingNames: string[],
): string {
  const who = req.member_name || req.member_email;
  const where = joinBuildingNames(buildingNames);
  if (action === 'added') {
    return `Added ${who} to Kindoo with access to ${where}.`;
  }
  return `Updated ${who}'s Kindoo access to ${where}.`;
}

// ---- Remove ----------------------------------------------------------

export interface ProvisionRemoveArgs {
  request: AccessRequest;
  session: KindooSession;
  deps?: ProvisionDeps;
}

/**
 * Remove a user's Kindoo access. Lookup is via the email-keyword
 * search; the first match wins (Kindoo's email index makes collisions
 * vanishingly rare in practice).
 *
 * No-op return when the user isn't in Kindoo — mirrors SBA's R-1 race
 * pattern. The caller still flips the SBA request to complete and the
 * note is persisted as `provisioning_note`.
 */
export async function provisionRemove(args: ProvisionRemoveArgs): Promise<ProvisionResult> {
  if (args.request.type !== 'remove') {
    throw new Error(`provisionRemove called with non-remove type "${args.request.type}"`);
  }
  const fetchImpl = args.deps?.fetchImpl;
  const who = args.request.member_name || args.request.member_email;

  const lookup = await lookupUserByEmail(args.session, args.request.member_email, fetchImpl);
  if (lookup.users.length === 0) {
    return {
      kindoo_uid: null,
      action: 'noop-remove',
      note: `${who} was not in Kindoo (no-op).`,
    };
  }
  const match = lookup.users[0]!;
  await revokeUser(args.session, match.uid, fetchImpl);
  return {
    kindoo_uid: match.uid,
    action: 'removed',
    note: `Removed ${who} from Kindoo.`,
  };
}
