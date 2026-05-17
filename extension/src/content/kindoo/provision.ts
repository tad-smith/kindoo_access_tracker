// v2.2 — orchestrates the Kindoo-side work for one SBA AccessRequest.
// Three top-level functions:
//
//   provisionAddOrChange(req, seat, ...)  // add_manual / add_temp
//   provisionRemove(req, seat, ...)       // remove (scope-specific)
//   provisionEdit(req, seat, ...)         // edit_auto / edit_manual / edit_temp
//
// All flows use a read-first / merged-state pattern: compute the
// post-completion target state (buildings, description, temp + date
// bounds), then drive Kindoo to it via:
//   - `saveAccessRule` to ADD missing rules. `saveAccessRule` is
//     MERGE-only (confirmed in staging 2026-05-12): it can grow the
//     rule set but cannot shrink it.
//   - `revokeUserFromAccessSchedule` per dropped rule when narrowing
//     a rule set (since `saveAccessRule` can't shrink).
//   - `revokeUser` when the post-removal state has no rules at all —
//     wipe the env-user record entirely.
//   - `editUser` for env-user advanced settings (description / temp
//     flag / dates) when the target differs from lookup.
//
// The remove flow mirrors SBA's `removeSeatOnRequestComplete`
// trigger: compute the post-removal seat shape (which scope wins
// primary, what duplicates survive, what building set remains),
// derive the post-removal rule set, and reconcile Kindoo to it.
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
import {
  editUser,
  inviteUser,
  lookupUserByEmail,
  revokeUser,
  revokeUserFromAccessSchedule,
  saveAccessRule,
} from './endpoints';
import { KindooApiError } from './client';
import {
  buildRuleDoorMap,
  deriveEffectiveRuleIds,
  getUserDoorIds,
} from './sync/buildingsFromDoors';

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

/**
 * Edit flow can only operate on a Kindoo user record that already
 * exists — there is no "create a user as part of an edit" path. If the
 * lookup misses, surface a clean error so the operator knows to
 * provision the user via an add request first.
 */
export class ProvisionEditUserMissingError extends Error {
  readonly code = 'edit-user-missing' as const;
  constructor(email: string) {
    super(
      `Cannot edit Kindoo access for ${email}: user not found in Kindoo. ` +
        `Provision them via an add request first.`,
    );
    this.name = 'ProvisionEditUserMissingError';
  }
}

/**
 * Defense in depth: `edit_auto` requests with `scope='stake'` should
 * never reach the extension (web hides the affordance; rules reject
 * the create; the callable rejects the complete). If one does, we
 * refuse to write to Kindoo so a stale request can never grant access
 * outside what the Church-automation already grants.
 */
export class ProvisionStakeAutoEditError extends Error {
  readonly code = 'stake-auto-edit' as const;
  constructor() {
    super(
      'edit_auto requests with scope=stake are not allowed (stake auto seats are not editable).',
    );
    this.name = 'ProvisionStakeAutoEditError';
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
 * The user's total current building coverage across all SBA grants
 * captured on the seat. `seat.building_names` is primary-only by
 * design (per `firebase-schema.md`); cross-scope grants live in
 * `duplicate_grants[].building_names`. The add path needs the union
 * so the post-completion target rule set covers everything the user
 * is already entitled to, not just the primary grant's buildings.
 *
 * T-42: when `requestSiteId` is supplied, only grants whose
 * `kindoo_site_id` resolves to that site contribute — the per-site
 * Kindoo write should not pollute the active site with buildings
 * that belong to a different Kindoo environment. Within-site
 * duplicates (same site as the primary) contribute; parallel-site
 * duplicates (different site) are excluded. `null` value or absent
 * resolves to "home"; falls back to the seat's `scope` → ward
 * `kindoo_site_id` for legacy seats still in the migration window.
 *
 * Returns the union, de-duplicated in insertion order.
 */
function currentSeatBuildings(
  seat: Seat | null,
  requestSiteId?: string | null,
  wards?: Ward[],
): string[] {
  if (!seat) return [];
  if (requestSiteId === undefined) {
    // Pre-T-42 behaviour: union every grant. Tests that don't supply
    // a site id rely on this; the spec change is opt-in.
    const dupBuildings = (seat.duplicate_grants ?? []).flatMap((d) => d.building_names ?? []);
    return uniqueOrdered(seat.building_names ?? [], dupBuildings);
  }
  const wardSite = (wardCode: string): string | null => {
    if (wardCode === 'stake') return null;
    if (!wards) return null;
    const ward = wards.find((w) => w.ward_code === wardCode);
    return ward ? (ward.kindoo_site_id ?? null) : null;
  };
  const grantSite = (
    grantKindooSiteId: string | null | undefined,
    grantScope: string,
  ): string | null => {
    if (grantKindooSiteId !== undefined && grantKindooSiteId !== null) {
      return grantKindooSiteId;
    }
    if (grantKindooSiteId === null) return null;
    return wardSite(grantScope);
  };
  const includePrimary = grantSite(seat.kindoo_site_id, seat.scope) === requestSiteId;
  const primaryBuildings = includePrimary ? (seat.building_names ?? []) : [];
  const dupBuildings = (seat.duplicate_grants ?? [])
    .filter((d) => grantSite(d.kindoo_site_id, d.scope) === requestSiteId)
    .flatMap((d) => d.building_names ?? []);
  return uniqueOrdered(primaryBuildings, dupBuildings);
}

/**
 * Mirror of `functions/src/callable/markRequestComplete.ts` `planEditSeat`
 * — apply an edit request to the seat in memory, returning the
 * post-edit seat. The backend resolves the slot identically; we
 * recompute the post-edit shape locally so the extension can derive
 * the post-edit composite building set (primary ∪ surviving duplicates)
 * before talking to Kindoo. Returns `null` when no slot matches
 * (callable will throw `failed-precondition`); the orchestrator falls
 * back to a pre-edit composite + the request's building set so the
 * Kindoo write still covers the user's existing scope, and the
 * subsequent callable invocation is the canonical authority on whether
 * the edit is accepted.
 *
 * Slot resolution (backend-aligned):
 *   1. If `(seat.scope, seat.type) == (scope, targetType)` → primary
 *      gets its `building_names` (and `reason` / dates if supplied)
 *      replaced.
 *   2. Else walk `duplicate_grants[]` for the first `(scope, type)`
 *      match; replace its fields.
 *   3. Else return `null` — no slot matched.
 */
function applyEditToSeat(
  seat: Seat,
  scope: string,
  targetType: 'auto' | 'manual' | 'temp',
  fields: {
    building_names: string[];
    reason?: string;
    start_date?: string;
    end_date?: string;
  },
): Seat | null {
  // Primary slot match.
  if (seat.scope === scope && seat.type === targetType) {
    const next: Seat = { ...seat, building_names: [...fields.building_names] };
    if (fields.reason !== undefined) next.reason = fields.reason;
    if (fields.start_date !== undefined) next.start_date = fields.start_date;
    if (fields.end_date !== undefined) next.end_date = fields.end_date;
    return next;
  }

  // Duplicate slot match.
  const dupes = seat.duplicate_grants ?? [];
  const matchIdx = dupes.findIndex((d) => d.scope === scope && d.type === targetType);
  if (matchIdx >= 0) {
    const matched = dupes[matchIdx]!;
    const replacement: DuplicateGrant = {
      ...matched,
      building_names: [...fields.building_names],
    };
    if (fields.reason !== undefined) replacement.reason = fields.reason;
    if (fields.start_date !== undefined) replacement.start_date = fields.start_date;
    if (fields.end_date !== undefined) replacement.end_date = fields.end_date;
    const nextDupes = dupes.slice();
    nextDupes[matchIdx] = replacement;
    return { ...seat, duplicate_grants: nextDupes };
  }

  return null;
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
 * orchestrator narrows existing segments — see `removeScope`).
 *
 * `removeScope` (REMOVE only) drops the first segment whose `scope`
 * matches. Used so the post-removal description reflects what survives
 * after the trigger updates the seat shape. Skips at most one segment
 * per call (matches the seat-shape rule: at most one grant per scope).
 */
function synthesizeDescription(
  seat: Seat | null,
  req: AccessRequest,
  stake: Stake,
  wards: Ward[],
  mergeAddIntoSeat: boolean,
  removeScope?: string,
  editTarget?: { scope: string; type: 'auto' | 'manual' | 'temp'; reason: string },
): string {
  // Build the post-completion (scope, type, callings, reason) list.
  // First entry is the primary; rest are duplicates.
  type Segment = {
    scope: string;
    type: 'auto' | 'manual' | 'temp';
    callings: string[];
    reason: string;
  };

  let segments: Segment[] = [];

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

  if (removeScope !== undefined) {
    // Drop the first segment whose scope matches the request's. Seats
    // carry at most one grant per scope (primary + duplicates), so a
    // single-pass filter cleanly mirrors the trigger's "promote first
    // duplicate / drop matching duplicate" behavior in the description.
    let dropped = false;
    segments = segments.filter((s) => {
      if (!dropped && s.scope === removeScope) {
        dropped = true;
        return false;
      }
      return true;
    });
  }

  if (editTarget !== undefined) {
    // Replace the matching (scope, type) segment's `reason` with the
    // request's reason. For `edit_auto` the description text is
    // driven by callings (reason is unused in formatDescriptionSegment),
    // so the resulting description is unchanged — that's intentional;
    // the edit only mutates building grants. For `edit_manual` /
    // `edit_temp` the reason field drives the description text.
    //
    // Mirrors `planEditSeat`'s slot resolution: primary `(scope, type)`
    // wins; otherwise the first duplicate-segment match.
    let replaced = false;
    segments = segments.map((s) => {
      if (!replaced && s.scope === editTarget.scope && s.type === editTarget.type) {
        replaced = true;
        return { ...s, reason: editTarget.reason };
      }
      return s;
    });
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
      `${req.type} request ${req.request_id} missing start_date or end_date`,
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

/**
 * Effective rule IDs the user already holds via Church Access
 * Automation's direct door grants. Strict-subset derivation:
 * `getUserDoorIds` returns every DoorID the user can open (both
 * AccessRule-derived AND `AccessScheduleID === 0` direct grants);
 * `deriveEffectiveRuleIds` claims a rule iff EVERY door in that
 * rule's door set is in the user's door set.
 *
 * The orchestrator subtracts these from `ridsToAdd` so it never
 * writes a redundant AccessSchedule for a building the user already
 * has effective access to. Without this, `saveAccessRule`'s MERGE
 * semantics would add a parallel AccessRule alongside the direct
 * door grants — two grant sources for the same building. Functionally
 * harmless (the user can still open the door) but pollutes the user's
 * Kindoo state and creates the exact divergence the Sync feature is
 * meant to surface.
 *
 * Returns `null` on any I/O failure in the derivation chain. The
 * caller falls back to the legacy diff (`currentSchedules` only).
 * The provision write still proceeds; in the worst case we re-introduce
 * the redundant-rule scenario but don't block the operator on a
 * transient Kindoo error.
 */
async function deriveDirectGrantRids(
  session: KindooSession,
  buildings: Building[],
  userId: string,
  fetchImpl: typeof fetch | undefined,
): Promise<Set<number> | null> {
  const stakeRuleIds = buildings
    .map((b) => b.kindoo_rule?.rule_id)
    .filter((id): id is number => typeof id === 'number');
  if (stakeRuleIds.length === 0) return new Set();
  try {
    const ruleDoorMap = await buildRuleDoorMap(session, session.eid, stakeRuleIds, fetchImpl);
    const userDoorIds = await getUserDoorIds(session, userId, session.eid, fetchImpl);
    return deriveEffectiveRuleIds(userDoorIds, ruleDoorMap);
  } catch (err) {
    console.log(
      `[sba-ext] deriveDirectGrantRids: door-grant derivation failed for ${userId}; ` +
        `falling back to legacy diff. ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Compute the add/revoke RID diff for a Kindoo write, accounting for
 * BOTH the user's existing AccessSchedules AND Church Access
 * Automation's direct door grants.
 *
 *   ridsAlreadyEffective = currentSchedules ∪ effectiveRuleIdsFromDoors
 *   ridsToAdd            = targetRids   - ridsAlreadyEffective
 *   ridsToRevoke         = currentSchedules - targetRids
 *
 * `ridsToRevoke` only looks at the schedules — we can't revoke a
 * direct door grant via `revokeUserFromAccessSchedule` (it operates
 * on AccessSchedules); Church Access Automation owns those.
 *
 * If door-grant derivation fails, falls back to the legacy diff
 * (`ridsToAdd = targetRids - currentSchedules`). `derivationFailed`
 * lets the caller distinguish "no direct grants" (Set) from "we
 * don't know" (null) for logging / behavior assertions.
 */
async function computeKindooDiff(args: {
  session: KindooSession;
  buildings: Building[];
  userId: string;
  currentSchedules: number[];
  targetRids: number[];
  fetchImpl: typeof fetch | undefined;
}): Promise<{ ridsToAdd: number[]; ridsToRevoke: number[]; derivationFailed: boolean }> {
  const targetSet = new Set(args.targetRids);
  const currentSet = new Set(args.currentSchedules);
  const ridsToRevoke = args.currentSchedules.filter((id) => !targetSet.has(id));

  const directGrantRids = await deriveDirectGrantRids(
    args.session,
    args.buildings,
    args.userId,
    args.fetchImpl,
  );

  if (directGrantRids === null) {
    // Fallback: ignore direct grants. May write a redundant rule but
    // the provision still completes.
    const ridsToAdd = args.targetRids.filter((id) => !currentSet.has(id));
    return { ridsToAdd, ridsToRevoke, derivationFailed: true };
  }

  const ridsToAdd = args.targetRids.filter((id) => !currentSet.has(id) && !directGrantRids.has(id));
  return { ridsToAdd, ridsToRevoke, derivationFailed: false };
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
 *   1. Compute targetBuildings = unique(seat.building_names ∪
 *      seat.duplicate_grants[].building_names ∪ request.building_names).
 *      The seat-side union captures the user's total existing scope
 *      coverage; `seat.building_names` alone is primary-only.
 *   2. targetRIDs = buildings → kindoo_rule.rule_id (throws on missing mapping).
 *   3. lookupUserByEmail(email).
 *   4. Not found → inviteUser + saveAccessRule(targetRIDs). A brand-new
 *      user has no direct grants yet, so the full target set ships.
 *   5. Found → computeKindooDiff against the user's current
 *      AccessSchedules AND Church Access Automation's direct door
 *      grants. saveAccessRule only for RIDs not already effectively
 *      held; editUser (description / temp / dates) only if diff.
 *      Direct grants are read via `deriveDirectGrantRids` (4 rule
 *      calls + 1 user call); failure falls back to the legacy
 *      schedules-only diff so a transient Kindoo error doesn't block
 *      the operator.
 */
export async function provisionAddOrChange(
  args: ProvisionAddOrChangeArgs,
): Promise<ProvisionResult> {
  if (args.request.type !== 'add_manual' && args.request.type !== 'add_temp') {
    throw new Error(`provisionAddOrChange called with non-add type "${args.request.type}"`);
  }

  const fetchImpl = args.deps?.fetchImpl;

  // ---- Compute target state ----
  // T-42: limit the union to grants on the request's target site so
  // the per-site Kindoo write doesn't pollute the active site with
  // buildings that belong to another Kindoo environment. Stake-scope
  // requests target home; ward-scope requests target the ward's
  // `kindoo_site_id` (home wards resolve to `null`).
  const requestSiteId: string | null =
    args.request.scope === 'stake'
      ? null
      : (args.wards.find((w) => w.ward_code === args.request.scope)?.kindoo_site_id ?? null);
  const requestBuildings = buildingsForRequest(args.request, args.wards);
  const seatBuildings = currentSeatBuildings(args.seat, requestSiteId, args.wards);
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
  // Compute the additive diff against schedules ∪ direct door grants.
  // We only call saveAccessRule for RIDs not already effectively held;
  // a building whose entire rule door set is covered by Church Access
  // Automation's direct grants is skipped to avoid writing a
  // redundant AccessSchedule (the MERGE-pollution scenario).
  //
  // The add path does NOT issue per-rule revokes — adds only grow the
  // rule set. We still pass currentSchedules so the helper produces
  // the canonical pair, but only `ridsToAdd` drives the write here.
  const { ridsToAdd } = await computeKindooDiff({
    session: args.session,
    buildings: args.buildings,
    userId: existing.userId,
    currentSchedules: existingRids,
    targetRids: targetRIDs,
    fetchImpl,
  });
  let didSaveRules = false;
  if (ridsToAdd.length > 0) {
    await saveAccessRule(args.session, existing.userId, ridsToAdd, fetchImpl);
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
  /** SBA seat for the request's subject pre-removal; `null` if no
   * seat exists (R-1 race). */
  seat: Seat | null;
  stake: Stake;
  buildings: Building[];
  wards: Ward[];
  envs: KindooEnvironment[];
  session: KindooSession;
  deps?: ProvisionDeps;
}

/**
 * Compute the post-removal seat's building set, mirroring the
 * `removeSeatOnRequestComplete` trigger's "promote first duplicate /
 * drop matching duplicate" logic:
 *
 *   - `seat` null → empty (no seat = no buildings).
 *   - request.scope matches the primary:
 *     - no duplicates → seat is deleted by trigger → empty.
 *     - has duplicates → first duplicate promotes to primary; its
 *       building_names become the seat's primary building_names; the
 *       remaining duplicates keep their building_names recorded as
 *       informational entries (their buildings persist in the seat's
 *       overall building set).
 *   - request.scope matches a duplicate → drop that duplicate; primary
 *     building_names persist; remaining duplicates keep theirs.
 *   - stale request where no scope matches → seat is unchanged.
 *
 * Result is de-duplicated in stable order so downstream consumers
 * (RID mapping, note text) get a predictable list.
 *
 * T-42: per-site filtering. The remove orchestrator runs on a single
 * Kindoo session (the request's target site); the write should only
 * include grants whose `kindoo_site_id` resolves to that site. Without
 * this, removing the primary of a multi-site seat would leak the
 * foreign duplicate's buildings into the active environment.
 */
function computePostRemovalBuildings(
  seat: Seat | null,
  request: AccessRequest,
  wards: Ward[],
  requestSiteId: string | null,
): string[] {
  if (!seat) return [];
  const wardSite = (wardCode: string): string | null => {
    if (wardCode === 'stake') return null;
    const ward = wards.find((w) => w.ward_code === wardCode);
    return ward ? (ward.kindoo_site_id ?? null) : null;
  };
  const grantSite = (
    grantKindooSiteId: string | null | undefined,
    grantScope: string,
  ): string | null => {
    if (grantKindooSiteId !== undefined && grantKindooSiteId !== null) {
      return grantKindooSiteId;
    }
    if (grantKindooSiteId === null) return null;
    return wardSite(grantScope);
  };
  const primaryBuildings = seat.building_names ?? [];
  const primaryOnSite = grantSite(seat.kindoo_site_id, seat.scope) === requestSiteId;
  const filteredDup = (d: DuplicateGrant): string[] =>
    grantSite(d.kindoo_site_id, d.scope) === requestSiteId ? (d.building_names ?? []) : [];

  if (seat.scope === request.scope) {
    const duplicates = seat.duplicate_grants ?? [];
    if (duplicates.length === 0) return [];
    const [promoted, ...rest] = duplicates;
    // Only contribute the promoted duplicate's buildings when its
    // site matches; same filter for the remaining duplicates.
    const promotedBuildings =
      grantSite(promoted!.kindoo_site_id, promoted!.scope) === requestSiteId
        ? (promoted!.building_names ?? [])
        : [];
    return uniqueOrdered(promotedBuildings, rest.flatMap(filteredDup));
  }

  const duplicates = seat.duplicate_grants ?? [];
  const matched = duplicates.some((d) => d.scope === request.scope);
  if (!matched) {
    // Stale request — scope no longer present in the seat. Building
    // set unchanged on the active site (primary if on-site +
    // surviving duplicates on-site).
    return uniqueOrdered(primaryOnSite ? primaryBuildings : [], duplicates.flatMap(filteredDup));
  }
  let dropped = false;
  const surviving = duplicates.filter((d) => {
    if (!dropped && d.scope === request.scope) {
      dropped = true;
      return false;
    }
    return true;
  });
  return uniqueOrdered(primaryOnSite ? primaryBuildings : [], surviving.flatMap(filteredDup));
}

/**
 * Reconcile Kindoo to the post-removal seat shape. Computes the
 * post-removal building set (mirroring SBA's
 * `removeSeatOnRequestComplete` trigger), derives the surviving rule
 * set, and drives Kindoo to it via per-rule revoke (narrowing), full
 * `revokeUser` (when nothing remains), and `editUser` (description
 * sync only).
 *
 * Flow:
 *   1. Compute targetBuildings via `computePostRemovalBuildings`.
 *   2. targetRIDs = buildings → kindoo_rule.rule_id (throws on missing
 *      mapping just like the add path).
 *   3. lookupUserByEmail(email). Not found → noop-remove.
 *   4. toRevoke = currentRIDs \ targetRIDs — revoke each individually.
 *   5. toAdd = targetRIDs \ currentRIDs — rare on a remove flow
 *      (only happens when a promoted duplicate's building wasn't yet
 *      in Kindoo). saveAccessRule merges.
 *   6. If targetRIDs is empty after revocations → `revokeUser` to
 *      delete the env-user record entirely; action='removed'.
 *   7. Else → editUser only when description differs; action='updated'.
 */
export async function provisionRemove(args: ProvisionRemoveArgs): Promise<ProvisionResult> {
  if (args.request.type !== 'remove') {
    throw new Error(`provisionRemove called with non-remove type "${args.request.type}"`);
  }
  const fetchImpl = args.deps?.fetchImpl;

  // ---- Compute target state ----
  // T-42: derive the request's target site so the per-site write
  // only includes buildings on that site. Pre-fix this leaked
  // foreign-site duplicate buildings into the active environment
  // when removing the primary of a multi-site seat.
  const requestSiteId: string | null =
    args.request.scope === 'stake'
      ? null
      : (args.wards.find((w) => w.ward_code === args.request.scope)?.kindoo_site_id ?? null);
  const targetBuildings = computePostRemovalBuildings(
    args.seat,
    args.request,
    args.wards,
    requestSiteId,
  );
  const targetRIDs = ridsForBuildings(targetBuildings, args.buildings);

  const env = findEnvironment(args.envs, args.session);
  const envTzRaw = env.TimeZone;
  const envTz =
    typeof envTzRaw === 'string' && envTzRaw.length > 0 ? envTzRaw : 'Mountain Standard Time';

  // ---- Read Kindoo state ----
  const existing = await lookupUserByEmail(args.session, args.request.member_email, fetchImpl);
  if (!existing) {
    return {
      kindoo_uid: null,
      action: 'noop-remove',
      note: `${nameOrEmail(args.request)} was not in Kindoo (no-op).`,
    };
  }

  // ---- Reconcile rule set ----
  const currentRIDs = existing.accessSchedules.map((s) => s.ruleId);
  const targetSet = new Set(targetRIDs);
  const currentSet = new Set(currentRIDs);
  const toRevoke = currentRIDs.filter((id) => !targetSet.has(id));
  const toAdd = targetRIDs.filter((id) => !currentSet.has(id));

  // Drop removed rules first (per-rule revoke — `saveAccessRule` can't
  // narrow). `revokeUserFromAccessSchedule` takes EUID.
  for (const ruleId of toRevoke) {
    await revokeUserFromAccessSchedule(args.session, existing.euid, ruleId, fetchImpl);
  }

  // Then add any newly-needed rules (e.g. promoted duplicate brought a
  // building not previously in Kindoo for this user).
  if (toAdd.length > 0) {
    await saveAccessRule(args.session, existing.userId, toAdd, fetchImpl);
  }

  // If nothing survives, wipe the env-user record entirely. Matches the
  // semantics SBA conveys for a request that empties the seat.
  if (targetRIDs.length === 0) {
    await revokeUser(args.session, existing.userId, fetchImpl);
    return {
      kindoo_uid: existing.userId,
      action: 'removed',
      note: noteForAction('removed', args.request, []),
    };
  }

  // ---- Description sync ----
  const targetDescription = synthesizeDescription(
    args.seat,
    args.request,
    args.stake,
    args.wards,
    false,
    args.request.scope,
  );
  if (targetDescription !== existing.description) {
    const editPayload: KindooEditUserPayload = {
      description: targetDescription,
      isTemp: existing.isTempUser,
      // Echo current dates; remove flow doesn't change temp state.
      startAccessDoorsDateTime: existing.startAccessDoorsDateAtTimeZone ?? '',
      expiryDate: existing.expiryDateAtTimeZone ?? '',
      timeZone: existing.expiryTimeZone || envTz,
    };
    await editUser(args.session, existing.euid, editPayload, fetchImpl);
  }

  return {
    kindoo_uid: existing.userId,
    action: 'updated',
    note: noteForAction('updated', args.request, targetBuildings),
  };
}

// ---- Edit ------------------------------------------------------------

export interface ProvisionEditArgs {
  request: AccessRequest;
  /** SBA seat for the request's subject. Edit requires a seat — the
   * web UI and rules only allow editing an existing seat. If null,
   * we still proceed but the description-rewrite falls back to the
   * request's own segment as a safety net (matches the orphan
   * recovery shape used elsewhere). */
  seat: Seat | null;
  stake: Stake;
  buildings: Building[];
  wards: Ward[];
  envs: KindooEnvironment[];
  session: KindooSession;
  deps?: ProvisionDeps;
}

/**
 * Edit a user's Kindoo access in place — replace the buildings on the
 * matching seat slot, refresh the Description, and (for `edit_temp`)
 * update the date bounds.
 *
 * Replace-semantics for the EDITED slot — `request.building_names` IS
 * the new building set on the matching seat slot. The orchestrator
 * does NOT union the request's buildings with the slot's pre-edit
 * buildings: the requester explicitly chose the post-edit set in the
 * dialog, and any buildings that were on this slot but aren't in the
 * new set should be dropped from that slot.
 *
 * Cross-slot preservation — buildings belonging to OTHER seat slots
 * (the primary slot if a duplicate is being edited, or surviving
 * duplicate slots if the primary is being edited) must stay. The
 * orchestrator computes a post-edit seat in memory (`applyEditToSeat`,
 * mirroring the backend's `planEditSeat`), then unions building_names
 * across primary + ALL surviving duplicate slots — that union is the
 * post-edit composite the user is entitled to.
 *
 * The Kindoo diff is composite-vs-composite, AND consults Church
 * Access Automation's direct door grants so we never write a redundant
 * AccessSchedule for a building the user already has effective access
 * to:
 *   - `targetRids` = rules backing the post-edit composite.
 *   - `ridsAlreadyEffective` = currentSchedules ∪ rules whose door set
 *     is fully covered by the user's direct door grants (the
 *     `buildingsFromDoors` strict-subset derivation; covers both
 *     AccessRule-derived doors AND `AccessScheduleID === 0` Church
 *     direct grants).
 *   - `ridsToAdd` = targetRids - ridsAlreadyEffective. A building
 *     covered by direct grants alone is skipped — `saveAccessRule`'s
 *     MERGE semantics would otherwise create a parallel AccessSchedule
 *     alongside the direct grants, polluting the user's Kindoo state.
 *   - `ridsToRevoke` = currentSchedules - targetRids. Only operates on
 *     AccessSchedules; direct grants can't be revoked here (Church
 *     Access Automation owns them). RIDs belonging to an UNTOUCHED
 *     slot are in `targetRids` (because that slot contributes its
 *     buildings to the composite), so they're never in `ridsToRevoke`.
 *
 * Flow:
 *   1. Stake-auto guard — refuse `edit_auto` + `scope='stake'`.
 *   2. Apply the edit to the seat in memory to derive the post-edit
 *      seat (`applyEditToSeat`). If no slot matches (stale request),
 *      fall back to the pre-edit seat ∪ request's buildings; the
 *      callable invocation will reject the request with
 *      `failed-precondition` and the Kindoo write is a benign add.
 *   3. Compute targetBuildings = union over primary + all surviving
 *      duplicate `building_names` of the post-edit seat.
 *   4. targetRids = ridsForBuildings(targetBuildings) (throws on
 *      missing mapping).
 *   5. lookupUserByEmail — must exist; otherwise
 *      `ProvisionEditUserMissingError`.
 *   6. computeKindooDiff against currentSchedules AND direct door
 *      grants. Door-grant derivation failure falls back to the legacy
 *      schedules-only diff so a transient Kindoo error doesn't block
 *      the operator.
 *   7. saveAccessRule(ridsToAdd) (MERGE); revokeUserFromAccessSchedule
 *      per ridsToRevoke rid.
 *   8. Synthesize description with the matching slot's `reason`
 *      replaced by the request's reason. For `edit_auto` this leaves
 *      the description unchanged (callings drive the text, not
 *      reason); for manual/temp the text changes if `reason` changed.
 *   9. editUser with the new description; for `edit_temp` also update
 *      isTemp + dates from the request.
 */
export async function provisionEdit(args: ProvisionEditArgs): Promise<ProvisionResult> {
  const req = args.request;
  if (req.type !== 'edit_auto' && req.type !== 'edit_manual' && req.type !== 'edit_temp') {
    throw new Error(`provisionEdit called with non-edit type "${req.type}"`);
  }

  // 1. Stake-auto defense in depth.
  if (req.type === 'edit_auto' && req.scope === 'stake') {
    throw new ProvisionStakeAutoEditError();
  }

  // edit_temp must carry both dates — validate at the boundary so a
  // bad request never reaches the wire.
  if (req.type === 'edit_temp') {
    tempDatesFor(req); // throws KindooApiError('unexpected-shape', ...) on miss
  }

  const fetchImpl = args.deps?.fetchImpl;

  // ---- Compute target state ----
  // Apply the edit in memory to derive the post-edit seat shape, then
  // union building_names across primary + all surviving duplicates.
  // That union is what the user is entitled to AFTER the edit commits;
  // the Kindoo diff against this composite leaves untouched slots'
  // RIDs intact (they remain in the target set, so they're never in
  // `toRevoke`).
  const requestBuildings = [...(req.building_names ?? [])];
  const targetType: 'auto' | 'manual' | 'temp' =
    req.type === 'edit_auto' ? 'auto' : req.type === 'edit_manual' ? 'manual' : 'temp';
  const editFields: {
    building_names: string[];
    reason?: string;
    start_date?: string;
    end_date?: string;
  } = { building_names: requestBuildings };
  if (req.type !== 'edit_auto') editFields.reason = req.reason;
  if (req.type === 'edit_temp') {
    if (req.start_date !== undefined) editFields.start_date = req.start_date;
    if (req.end_date !== undefined) editFields.end_date = req.end_date;
  }
  const postEditSeat = args.seat
    ? applyEditToSeat(args.seat, req.scope, targetType, editFields)
    : null;
  // T-42: per-site target. Edit requests target the request's scope's
  // site; we union only grants whose `kindoo_site_id` matches.
  const requestSiteId: string | null =
    req.scope === 'stake'
      ? null
      : (args.wards.find((w) => w.ward_code === req.scope)?.kindoo_site_id ?? null);
  // If a slot matched, take the post-edit composite. If no slot
  // matched (stale request, or no seat) fall back to the pre-edit
  // seat ∪ request — the Kindoo write is a benign add and the
  // callable will reject the request authoritatively.
  const targetBuildings = postEditSeat
    ? currentSeatBuildings(postEditSeat, requestSiteId, args.wards)
    : uniqueOrdered(currentSeatBuildings(args.seat, requestSiteId, args.wards), requestBuildings);
  const targetRIDs = ridsForBuildings(targetBuildings, args.buildings);

  const env = findEnvironment(args.envs, args.session);
  const envTzRaw = env.TimeZone;
  const envTz =
    typeof envTzRaw === 'string' && envTzRaw.length > 0 ? envTzRaw : 'Mountain Standard Time';

  const targetDescription = synthesizeDescription(
    args.seat,
    req,
    args.stake,
    args.wards,
    false,
    undefined,
    { scope: req.scope, type: targetType, reason: req.reason },
  );

  // ---- Read Kindoo state ----
  const existing = await lookupUserByEmail(args.session, req.member_email, fetchImpl);
  if (!existing) {
    throw new ProvisionEditUserMissingError(req.member_email);
  }

  // ---- Reconcile rule set (add + revoke diff) ----
  const currentRIDs = existing.accessSchedules.map((s) => s.ruleId);
  const { ridsToAdd, ridsToRevoke } = await computeKindooDiff({
    session: args.session,
    buildings: args.buildings,
    userId: existing.userId,
    currentSchedules: currentRIDs,
    targetRids: targetRIDs,
    fetchImpl,
  });

  let didRuleWrite = false;
  if (ridsToAdd.length > 0) {
    // saveAccessRule MERGES — adds the missing rids without disturbing
    // unrelated grants on the same user record.
    await saveAccessRule(args.session, existing.userId, ridsToAdd, fetchImpl);
    didRuleWrite = true;
  }
  for (const ruleId of ridsToRevoke) {
    await revokeUserFromAccessSchedule(args.session, existing.euid, ruleId, fetchImpl);
    didRuleWrite = true;
  }

  // ---- Description + date sync ----
  const isTempTarget = req.type === 'edit_temp';
  let targetStart: string;
  let targetExpiry: string;
  if (isTempTarget) {
    const dates = tempDatesFor(req);
    targetStart = dates.startEdit;
    targetExpiry = dates.expiryEdit;
  } else {
    // For edit_auto / edit_manual we don't touch dates. Echo the
    // current values from lookup so editUser preserves them.
    targetStart = existing.startAccessDoorsDateAtTimeZone ?? '';
    targetExpiry = existing.expiryDateAtTimeZone ?? '';
  }

  const descDiffers = targetDescription !== existing.description;
  const tempDiffers = isTempTarget !== existing.isTempUser;
  const datesDiffer =
    isTempTarget &&
    (targetStart !== (existing.startAccessDoorsDateAtTimeZone ?? '') ||
      targetExpiry !== (existing.expiryDateAtTimeZone ?? ''));

  let didEdit = false;
  if (descDiffers || tempDiffers || datesDiffer) {
    const editPayload: KindooEditUserPayload = {
      description: targetDescription,
      isTemp: isTempTarget,
      startAccessDoorsDateTime: targetStart,
      expiryDate: targetExpiry,
      timeZone: existing.expiryTimeZone || envTz,
    };
    await editUser(args.session, existing.euid, editPayload, fetchImpl);
    didEdit = true;
  }

  return {
    kindoo_uid: existing.userId,
    action: 'updated',
    note:
      didEdit || didRuleWrite
        ? noteForAction('updated', req, targetBuildings)
        : `No Kindoo changes needed for ${nameOrEmail(req)}.`,
  };
}

// Re-export so tests + UI can use the rich Kindoo user type without
// drilling into endpoints.
export type { KindooEnvironmentUser };
