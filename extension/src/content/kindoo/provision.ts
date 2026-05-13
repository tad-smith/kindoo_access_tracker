// v2.2 — orchestrates the Kindoo-side work for one SBA AccessRequest
// using a read-first / merged-state pattern. Two top-level functions:
//
//   provisionAddOrChange(req, seat, ...)  // add_manual / add_temp
//   provisionRemove(req, seat, ...)       // remove
//
// Both compute the **post-completion** target state (which buildings
// the user should have access to, what description the seat should
// carry, whether the user is temp + their date bounds), then drive
// Kindoo to it via:
//   - `editUser` for env-user advanced settings (description, temp,
//     dates) — only when the target differs from lookup.
//   - `saveAccessRule` always sending the COMPLETE target rule set
//     (never a delta) — Kindoo's REPLACE-vs-MERGE semantics aren't
//     pinned down; full-set REPLACE is unambiguous.
//
// "Read first" means: every flow starts with `lookupUserByEmail`
// (whose `null` return IS the "not in Kindoo" signal — `checkUserType`
// is no longer needed in the orchestrator). The lookup returns both
// EUID + UserID + every field needed to compute deltas.
//
// Idempotent on retry by construction: lookup-first means a re-click
// after a transient Kindoo error re-reads current state and only
// re-applies whatever still differs.

import type { AccessRequest, Building, DuplicateGrant, Seat, Stake, Ward } from '@kindoo/shared';
import type { KindooSession } from './auth';
import type {
  KindooEditUserPayload,
  KindooEnvironment,
  KindooEnvironmentUser,
  KindooInviteUserPayload,
} from './endpoints';
import { editUser, inviteUser, lookupUserByEmail, revokeUser, saveAccessRule } from './endpoints';
import { KindooApiError } from './client';

/** Returned by both orchestrators. */
export interface ProvisionResult {
  /** Kindoo `UserID`. Never EUID. `null` only on the no-op remove path. */
  kindoo_uid: string | null;
  /** Discriminator for what physically happened in Kindoo. */
  action: 'invited' | 'updated' | 'removed' | 'noop-remove';
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
 * One of the buildings the post-completion state should grant has no
 * Kindoo Access Rule mapped. Caller catches and offers the
 * "Reconfigure" recovery (matching v2.1's locked-in
 * block-on-missing-mapping decision).
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

// ---- Compute helpers -------------------------------------------------

/**
 * Pick the display name shown in the Kindoo "Description" field for a
 * given scope. Stake scope mirrors the v2.1 wizard's resolution
 * (`kindoo_expected_site_name` takes precedence over `stake_name`);
 * ward scope reads the matching ward doc by `ward_code`. Falls back
 * to the scope string verbatim when no ward doc matches.
 */
function resolveScopeName(scope: string, stake: Stake, wards: Ward[]): string {
  if (scope === 'stake') {
    const override = stake.kindoo_expected_site_name?.trim();
    return override && override.length > 0 ? override : stake.stake_name;
  }
  const ward = wards.find((w) => w.ward_code === scope);
  return ward ? ward.ward_name : scope;
}

/**
 * Resolve the buildings the request grants access to into building
 * names. Trust `req.building_names` as the source of truth regardless
 * of scope — SBA's submit form populates it (for stake scope from the
 * requester's selection; for ward scope inheriting from the ward's
 * `building_name`). Fall back to the ward's building only for legacy
 * requests where `req.building_names` is empty on a ward scope.
 */
function buildingsForRequest(req: AccessRequest, wards: Ward[]): string[] {
  if (req.building_names.length > 0) return [...req.building_names];
  if (req.scope !== 'stake') {
    const ward = wards.find((w) => w.ward_code === req.scope);
    if (ward) return [ward.building_name];
  }
  return [];
}

/** Stable, de-duplicated union of two string lists. */
function uniqueOrdered(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...a, ...b]) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Map a list of building names to their Kindoo RIDs via
 * `building.kindoo_rule.rule_id`. Throws
 * `ProvisionBuildingsMissingRuleError` listing the gaps.
 */
function ridsForBuildings(buildingNames: string[], buildings: Building[]): number[] {
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
  if (missing.length > 0) throw new ProvisionBuildingsMissingRuleError(missing);
  return rids;
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

/** Format one scope+attribution pair the way Kindoo's manually-typed
 * descriptions read (see capture doc § "Description format convention"). */
function formatDescriptionSegment(
  scope: string,
  type: 'auto' | 'manual' | 'temp',
  callings: string[],
  reason: string,
  stake: Stake,
  wards: Ward[],
): string {
  const name = resolveScopeName(scope, stake, wards);
  if (type === 'auto' && callings.length > 0) {
    return `${name} (${callings.join(', ')})`;
  }
  // manual / temp / auto-with-no-callings — fall back to reason free
  // text. If neither callings nor reason exist, show the scope alone.
  const r = reason.trim();
  return r.length > 0 ? `${name} (${r})` : name;
}

/**
 * Synthesize the Kindoo Description for the post-completion seat.
 * Starts from the seat's existing primary grant (or the request's
 * primary if the seat is fresh) and joins each duplicate_grants
 * entry with ` | ` per the v2.2 design decision 6.
 *
 * `mergeAddIntoSeat` controls whether to also overlay the request's
 * scope+type as if `markRequestComplete` had already merged. For
 * ADDs that's `true` (we're computing what the seat will look like
 * once the request commits); for REMOVEs it's `false` (the
 * orchestrator only narrows the building set, doesn't change the
 * description shape).
 */
function synthesizeDescription(
  seat: Seat | null,
  req: AccessRequest,
  stake: Stake,
  wards: Ward[],
  mergeAddIntoSeat: boolean,
): string {
  // Build the post-completion (scope, type, callings, reason) list.
  // First entry is the primary; rest are duplicates.
  type Segment = {
    scope: string;
    type: 'auto' | 'manual' | 'temp';
    callings: string[];
    reason: string;
  };

  const segments: Segment[] = [];

  if (seat) {
    segments.push({
      scope: seat.scope,
      type: seat.type,
      callings: seat.callings ?? [],
      reason: seat.reason ?? '',
    });
    for (const dup of seat.duplicate_grants ?? []) {
      segments.push(toSegment(dup));
    }
  }

  if (mergeAddIntoSeat) {
    const incoming: Segment = {
      scope: req.scope,
      type: req.type === 'add_temp' ? 'temp' : 'manual',
      callings: [],
      reason: req.reason,
    };
    if (segments.length === 0) {
      // Fresh seat — incoming is primary.
      segments.push(incoming);
    } else {
      // Already a primary; check for collision on scope+type. If
      // present, the request collapses into it (description segments
      // for a primary update share the same line). Otherwise append
      // as a duplicate_grant placeholder.
      const collides = segments.some((s) => s.scope === incoming.scope && s.type === incoming.type);
      if (!collides) segments.push(incoming);
    }
  }

  if (segments.length === 0) {
    // No prior seat and no merge (REMOVE on a member with no SBA
    // seat) — let the description fall through to the request's own
    // primary as a safety net.
    segments.push({
      scope: req.scope,
      type: req.type === 'add_temp' ? 'temp' : 'manual',
      callings: [],
      reason: req.reason,
    });
  }

  return segments
    .map((s) => formatDescriptionSegment(s.scope, s.type, s.callings, s.reason, stake, wards))
    .join(' | ');
}

function toSegment(dup: DuplicateGrant): {
  scope: string;
  type: 'auto' | 'manual' | 'temp';
  callings: string[];
  reason: string;
} {
  return {
    scope: dup.scope,
    type: dup.type,
    callings: dup.callings ?? [],
    reason: dup.reason ?? '',
  };
}

/** Stable equality on the rule-set: sort both arrays before comparing. */
function sameRids(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

function tempDatesFor(req: AccessRequest): { startEdit: string; expiryEdit: string } {
  const start = req.start_date ?? '';
  const end = req.end_date ?? '';
  if (!start || !end) {
    throw new KindooApiError(
      'unexpected-shape',
      `add_temp request ${req.request_id} missing start_date or end_date`,
    );
  }
  return {
    startEdit: `${start}T00:00`,
    expiryEdit: `${end}T23:59`,
  };
}

function tempDatesForInvite(req: AccessRequest): { startInvite: string; expiryInvite: string } {
  const start = req.start_date ?? '';
  const end = req.end_date ?? '';
  if (!start || !end) {
    throw new KindooApiError(
      'unexpected-shape',
      `add_temp request ${req.request_id} missing start_date or end_date`,
    );
  }
  return {
    startInvite: `${start} 00:00`,
    expiryInvite: `${end} 23:59`,
  };
}

// ---- Add / change ----------------------------------------------------

export interface ProvisionAddOrChangeArgs {
  request: AccessRequest;
  /** SBA seat for the request's subject; `null` if no prior seat. */
  seat: Seat | null;
  stake: Stake;
  buildings: Building[];
  wards: Ward[];
  envs: KindooEnvironment[];
  session: KindooSession;
  deps?: ProvisionDeps;
}

/**
 * Add or change a user's Kindoo access to match the post-completion
 * seat state. See file header for the read-first contract.
 *
 * Flow:
 *   1. Compute targetBuildings = unique(seat.building_names ∪ request.building_names).
 *   2. targetRIDs = buildings → kindoo_rule.rule_id (throws on missing mapping).
 *   3. lookupUserByEmail(email).
 *   4. Not found → inviteUser + saveAccessRule.
 *   5. Found → editUser (description / temp / dates) only if diff;
 *              saveAccessRule with full target RIDs only if diff.
 */
export async function provisionAddOrChange(
  args: ProvisionAddOrChangeArgs,
): Promise<ProvisionResult> {
  if (args.request.type !== 'add_manual' && args.request.type !== 'add_temp') {
    throw new Error(`provisionAddOrChange called with non-add type "${args.request.type}"`);
  }

  const fetchImpl = args.deps?.fetchImpl;

  // ---- Compute target state ----
  const requestBuildings = buildingsForRequest(args.request, args.wards);
  const seatBuildings = args.seat?.building_names ?? [];
  const targetBuildings = uniqueOrdered(seatBuildings, requestBuildings);
  const targetRIDs = ridsForBuildings(targetBuildings, args.buildings);
  const targetDescription = synthesizeDescription(
    args.seat,
    args.request,
    args.stake,
    args.wards,
    true,
  );

  const env = findEnvironment(args.envs, args.session);
  const envTzRaw = env.TimeZone;
  const envTz =
    typeof envTzRaw === 'string' && envTzRaw.length > 0 ? envTzRaw : 'Mountain Standard Time';

  // ---- Read Kindoo state ----
  const existing = await lookupUserByEmail(args.session, args.request.member_email, fetchImpl);

  if (!existing) {
    // ---- Invite + full saveAccessRule path ----
    const invitePayload = buildInvitePayload(args.request, targetDescription, envTz);
    const invited = await inviteUser(args.session, invitePayload, fetchImpl);
    await saveAccessRule(args.session, invited.uid, targetRIDs, fetchImpl);
    return {
      kindoo_uid: invited.uid,
      action: 'invited',
      note: noteForAction('invited', args.request, targetBuildings),
    };
  }

  // ---- Existing user — apply truth table ----
  // Promotion / refresh decisions:
  // - add_manual           → permanent (promote a temp if needed; no demote-permanent)
  // - add_temp + permanent → permanent (no demote)
  // - add_temp + temp      → still temp; refresh dates from the request
  const isAddTemp = args.request.type === 'add_temp';
  const targetIsTemp = isAddTemp && existing.isTempUser === true;

  // Date strings to send on edit. For permanent users Kindoo accepts
  // empty strings on edit (per capture); echo lookup values when
  // they're present and we're not changing them, otherwise use empty
  // strings as a deliberate "clear" signal.
  let targetStart = '';
  let targetExpiry = '';
  if (targetIsTemp) {
    const dates = tempDatesFor(args.request);
    targetStart = dates.startEdit;
    targetExpiry = dates.expiryEdit;
  } else {
    // Permanent post-state. If the user is already permanent, echo
    // whatever the lookup carries (likely null → empty string). If we
    // just promoted from temp → permanent, send empty strings to clear.
    targetStart = existing.startAccessDoorsDateAtTimeZone ?? '';
    targetExpiry = existing.expiryDateAtTimeZone ?? '';
    if (existing.isTempUser) {
      // Promotion — explicit clear.
      targetStart = '';
      targetExpiry = '';
    }
  }

  const descDiffers = targetDescription !== existing.description;
  const tempDiffers = targetIsTemp !== existing.isTempUser;
  const datesDiffer =
    targetIsTemp &&
    (targetStart !== (existing.startAccessDoorsDateAtTimeZone ?? '') ||
      targetExpiry !== (existing.expiryDateAtTimeZone ?? ''));

  let didEdit = false;
  if (descDiffers || tempDiffers || datesDiffer) {
    const editPayload: KindooEditUserPayload = {
      description: targetDescription,
      isTemp: targetIsTemp,
      startAccessDoorsDateTime: targetStart,
      expiryDate: targetExpiry,
      timeZone: existing.expiryTimeZone || envTz,
    };
    await editUser(args.session, existing.euid, editPayload, fetchImpl);
    didEdit = true;
  }

  const existingRids = existing.accessSchedules.map((s) => s.ruleId);
  let didSaveRules = false;
  if (!sameRids(targetRIDs, existingRids)) {
    await saveAccessRule(args.session, existing.userId, targetRIDs, fetchImpl);
    didSaveRules = true;
  }

  return {
    kindoo_uid: existing.userId,
    action: 'updated',
    note:
      didEdit || didSaveRules
        ? noteForAction('updated', args.request, targetBuildings)
        : `No Kindoo changes needed for ${nameOrEmail(args.request)}.`,
  };
}

function buildInvitePayload(
  req: AccessRequest,
  description: string,
  tz: string,
): KindooInviteUserPayload {
  const isTemp = req.type === 'add_temp';
  if (isTemp) {
    const { startInvite, expiryInvite } = tempDatesForInvite(req);
    return {
      UserEmail: req.member_email,
      UserRole: 2,
      Description: description,
      CCInEmail: false,
      IsTempUser: true,
      StartAccessDoorsDate: startInvite,
      ExpiryDate: expiryInvite,
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

function nameOrEmail(req: AccessRequest): string {
  return req.member_name || req.member_email;
}

function joinBuildingNames(names: string[]): string {
  return names.join(', ');
}

function noteForAction(
  action: 'invited' | 'updated' | 'removed',
  req: AccessRequest,
  buildings: string[],
): string {
  const who = nameOrEmail(req);
  if (action === 'invited') {
    return `Invited ${who} to Kindoo with access to ${joinBuildingNames(buildings)}.`;
  }
  if (action === 'updated') {
    if (buildings.length === 0) {
      return `Updated ${who}'s Kindoo access — no buildings remain.`;
    }
    return `Updated ${who}'s Kindoo access to ${joinBuildingNames(buildings)}.`;
  }
  return `Removed ${who} from Kindoo.`;
}

// ---- Remove ----------------------------------------------------------

export interface ProvisionRemoveArgs {
  request: AccessRequest;
  /** SBA seat for the request's subject; `null` if already gone. */
  seat: Seat | null;
  stake: Stake;
  buildings: Building[];
  wards: Ward[];
  session: KindooSession;
  deps?: ProvisionDeps;
}

/**
 * Remove (or narrow) a user's Kindoo access to match the
 * post-completion seat state.
 *
 * Flow:
 *   1. targetBuildings = seat.building_names − request.building_names.
 *      For the typical whole-seat remove case targetBuildings = [].
 *   2. lookupUserByEmail(email).
 *   3. Not found → noop-remove (SBA still flips complete).
 *   4. Found + targetRIDs.length === 0 → revokeUser. Description edit
 *      skipped (user is gone).
 *   5. Found + targetRIDs.length > 0  → saveAccessRule with remaining
 *      RIDs + editUser if the trimmed description differs.
 */
export async function provisionRemove(args: ProvisionRemoveArgs): Promise<ProvisionResult> {
  if (args.request.type !== 'remove') {
    throw new Error(`provisionRemove called with non-remove type "${args.request.type}"`);
  }
  const fetchImpl = args.deps?.fetchImpl;

  // ---- Compute target buildings ----
  const removeBuildings = buildingsForRequest(args.request, args.wards);
  const seatBuildings = args.seat?.building_names ?? [];
  // v2.2 single-stake convention: a remove with empty building_names
  // clears the whole seat. Otherwise drop only the listed buildings.
  const targetBuildings =
    removeBuildings.length === 0 ? [] : seatBuildings.filter((b) => !removeBuildings.includes(b));
  const targetRIDs = ridsForBuildings(targetBuildings, args.buildings);

  // ---- Read Kindoo state ----
  const existing = await lookupUserByEmail(args.session, args.request.member_email, fetchImpl);
  if (!existing) {
    return {
      kindoo_uid: null,
      action: 'noop-remove',
      note: `${nameOrEmail(args.request)} was not in Kindoo (no-op).`,
    };
  }

  if (targetRIDs.length === 0) {
    await revokeUser(args.session, existing.userId, fetchImpl);
    return {
      kindoo_uid: existing.userId,
      action: 'removed',
      note: noteForAction('removed', args.request, []),
    };
  }

  // Partial remove — narrow the rule set + (maybe) refresh the
  // description to drop the removed scope. Compute a description from
  // the seat post-removal: same callings/duplicates minus the
  // departing grant. For v2.2 single-stake we don't synthesize a
  // post-removal seat shape (out of scope); reuse the existing seat's
  // description as a best-effort match.
  await saveAccessRule(args.session, existing.userId, targetRIDs, fetchImpl);

  const targetDescription = synthesizeDescription(
    args.seat,
    args.request,
    args.stake,
    args.wards,
    false,
  );
  if (targetDescription !== existing.description) {
    const editPayload: KindooEditUserPayload = {
      description: targetDescription,
      isTemp: existing.isTempUser,
      startAccessDoorsDateTime: existing.startAccessDoorsDateAtTimeZone ?? '',
      expiryDate: existing.expiryDateAtTimeZone ?? '',
      timeZone: existing.expiryTimeZone,
    };
    await editUser(args.session, existing.euid, editPayload, fetchImpl);
  }

  return {
    kindoo_uid: existing.userId,
    action: 'updated',
    note: noteForAction('updated', args.request, targetBuildings),
  };
}

// Re-export so tests + UI can use the rich Kindoo user type without
// drilling into endpoints.
export type { KindooEnvironmentUser };
