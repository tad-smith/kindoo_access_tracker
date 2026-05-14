// Sync Phase 2 — Kindoo-side fix orchestrator. Drives Kindoo to match a
// single SBA `Seat` (the source-of-truth side for `sba-only` and the
// "Update Kindoo" path of every `*-mismatch` discrepancy).
//
// The v2.2 `provisionAddOrChange` / `provisionRemove` orchestrators in
// `provision.ts` are request-driven — they consume an `AccessRequest`
// and merge it into an existing seat. Sync fixes don't have a request
// in hand; the seat IS the truth. Rather than synthesize an
// `AccessRequest` shell with phantom requester / completion bookkeeping
// fields and route through the merge path, we wrap the same low-level
// Kindoo endpoint helpers (`lookupUserByEmail`, `inviteUser`,
// `editUser`, `saveAccessRule`, `revokeUserFromAccessSchedule`) and
// drive Kindoo straight to the seat's target shape.
//
// Read-first contract carries over: lookup → diff against current →
// invite-or-edit + reconcile RIDs. Idempotent on retry — a re-click
// after a transient Kindoo error re-reads current state and only
// re-applies whatever still differs.
//
// Auto seats: the auto/manual/temp axis lives in SBA's seat shape, but
// the Kindoo Description carries the calling list in parens. For
// `sba-only` on an auto seat we still invite + write the description
// (so the manager sees the right text in Kindoo); the actual door
// access for auto seats lands via Church Access Automation's direct
// door grants, NOT via `AccessSchedules`. We still write
// `saveAccessRule` for completeness — it's harmless if Church Access
// Automation has already covered the door grants (merge semantics).

import type { Building, DuplicateGrant, Seat, Stake, Ward } from '@kindoo/shared';
import type { KindooSession } from './auth';
import type {
  KindooEditUserPayload,
  KindooEnvironment,
  KindooInviteUserPayload,
} from './endpoints';
import {
  editUser,
  inviteUser,
  lookupUserByEmail,
  revokeUserFromAccessSchedule,
  saveAccessRule,
} from './endpoints';
import {
  ProvisionBuildingsMissingRuleError,
  ProvisionEnvironmentNotFoundError,
  type ProvisionDeps,
  type ProvisionResult,
} from './provision';

export interface SyncProvisionArgs {
  /** The SBA seat to drive Kindoo to. */
  seat: Seat;
  stake: Stake;
  wards: Ward[];
  buildings: Building[];
  envs: KindooEnvironment[];
  session: KindooSession;
  deps?: ProvisionDeps;
}

/**
 * Reconcile Kindoo to a single SBA `Seat`. Invites the user if absent
 * from Kindoo; otherwise edits description / temp flag / dates and
 * reconciles the rule set (additions via `saveAccessRule`, removals
 * via per-rule revoke).
 *
 * Returns the same `ProvisionResult` shape v2.2's orchestrators return
 * so the panel's existing result rendering applies unchanged.
 */
export async function syncProvisionFromSeat(args: SyncProvisionArgs): Promise<ProvisionResult> {
  const { seat, stake, wards, buildings, envs, session } = args;
  const fetchImpl = args.deps?.fetchImpl;

  // ---- Compute target state ----
  const targetBuildings = unionSeatBuildings(seat);
  const targetRIDs = ridsForBuildings(targetBuildings, buildings);
  const targetDescription = synthesizeSeatDescription(seat, stake, wards);

  const env = findEnvironment(envs, session);
  const envTz = pickTimeZone(env);

  // ---- Read Kindoo state ----
  const existing = await lookupUserByEmail(session, seat.member_email, fetchImpl);

  if (!existing) {
    // Invite path. Date payload mirrors v2.2: temp seats carry start/end,
    // permanent seats clear with nulls.
    const invitePayload = buildInvitePayloadFromSeat(seat, targetDescription, envTz);
    const invited = await inviteUser(session, invitePayload, fetchImpl);
    if (targetRIDs.length > 0) {
      await saveAccessRule(session, invited.uid, targetRIDs, fetchImpl);
    }
    return {
      kindoo_uid: invited.uid,
      action: 'invited',
      note: `Invited ${displayName(seat)} to Kindoo with access to ${joinBuildings(targetBuildings)}.`,
    };
  }

  // ---- Existing user — drive to seat ----
  const targetIsTemp = seat.type === 'temp';
  let targetStart = '';
  let targetExpiry = '';
  if (targetIsTemp) {
    const dates = tempDatesForEdit(seat);
    targetStart = dates.startEdit;
    targetExpiry = dates.expiryEdit;
  } else if (!existing.isTempUser) {
    // Permanent both sides — echo lookup values (likely null → empty).
    targetStart = existing.startAccessDoorsDateAtTimeZone ?? '';
    targetExpiry = existing.expiryDateAtTimeZone ?? '';
  } else {
    // Demoting from temp → permanent. Explicit clear.
    targetStart = '';
    targetExpiry = '';
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
    await editUser(session, existing.euid, editPayload, fetchImpl);
    didEdit = true;
  }

  // Rule-set reconcile: narrow with per-rule revoke (saveAccessRule is
  // merge-only and can't shrink), then add the rest with one
  // saveAccessRule call.
  const currentRIDs = existing.accessSchedules.map((s) => s.ruleId);
  const targetSet = new Set(targetRIDs);
  const currentSet = new Set(currentRIDs);
  const toRevoke = currentRIDs.filter((id) => !targetSet.has(id));
  const toAdd = targetRIDs.filter((id) => !currentSet.has(id));
  let didRules = false;
  for (const rid of toRevoke) {
    await revokeUserFromAccessSchedule(session, existing.euid, rid, fetchImpl);
    didRules = true;
  }
  if (toAdd.length > 0) {
    await saveAccessRule(session, existing.userId, toAdd, fetchImpl);
    didRules = true;
  }

  return {
    kindoo_uid: existing.userId,
    action: 'updated',
    note:
      didEdit || didRules
        ? `Updated ${displayName(seat)}'s Kindoo access to ${joinBuildings(targetBuildings)}.`
        : `No Kindoo changes needed for ${displayName(seat)}.`,
  };
}

// ---- Compute helpers ------------------------------------------------

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

/** Union of `seat.building_names` + every `duplicate_grants[].building_names`. */
function unionSeatBuildings(seat: Seat): string[] {
  const dupBuildings = (seat.duplicate_grants ?? []).flatMap((d) => d.building_names ?? []);
  return uniqueOrdered(seat.building_names ?? [], dupBuildings);
}

/** Map building names to Kindoo rule IDs, throwing on any unmapped name. */
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

function findEnvironment(envs: KindooEnvironment[], session: KindooSession): KindooEnvironment {
  const env = envs.find((e) => e.EID === session.eid);
  if (!env) throw new ProvisionEnvironmentNotFoundError(session.eid);
  return env;
}

function pickTimeZone(env: KindooEnvironment): string {
  const raw = env.TimeZone;
  return typeof raw === 'string' && raw.length > 0 ? raw : 'Mountain Standard Time';
}

/**
 * Build the Kindoo Description for a seat. Primary segment first; one
 * `' | '`-joined entry per duplicate grant. Matches the convention v2.2
 * synthesises for request-driven provisions.
 */
export function synthesizeSeatDescription(seat: Seat, stake: Stake, wards: Ward[]): string {
  const segments: Array<{
    scope: string;
    type: Seat['type'];
    callings: string[];
    reason: string;
  }> = [
    {
      scope: seat.scope,
      type: seat.type,
      callings: seat.callings ?? [],
      reason: seat.reason ?? '',
    },
  ];
  for (const dup of seat.duplicate_grants ?? []) {
    segments.push(dupSegment(dup));
  }
  return segments
    .map((s) => formatSegment(s.scope, s.type, s.callings, s.reason, stake, wards))
    .join(' | ');
}

function dupSegment(dup: DuplicateGrant): {
  scope: string;
  type: Seat['type'];
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

function formatSegment(
  scope: string,
  type: Seat['type'],
  callings: string[],
  reason: string,
  stake: Stake,
  wards: Ward[],
): string {
  const name = resolveScopeName(scope, stake, wards);
  if (type === 'auto' && callings.length > 0) {
    return `${name} (${callings.join(', ')})`;
  }
  const r = reason.trim();
  return r.length > 0 ? `${name} (${r})` : name;
}

function resolveScopeName(scope: string, stake: Stake, wards: Ward[]): string {
  if (scope === 'stake') {
    const override = stake.kindoo_expected_site_name?.trim();
    return override && override.length > 0 ? override : stake.stake_name;
  }
  const ward = wards.find((w) => w.ward_code === scope);
  return ward ? ward.ward_name : scope;
}

function buildInvitePayloadFromSeat(
  seat: Seat,
  description: string,
  tz: string,
): KindooInviteUserPayload {
  if (seat.type === 'temp') {
    const { startInvite, expiryInvite } = tempDatesForInvite(seat);
    return {
      UserEmail: seat.member_email,
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
    UserEmail: seat.member_email,
    UserRole: 2,
    Description: description,
    CCInEmail: false,
    IsTempUser: false,
    StartAccessDoorsDate: null,
    ExpiryDate: null,
    ExpiryTimeZone: tz,
  };
}

function tempDatesForEdit(seat: Seat): { startEdit: string; expiryEdit: string } {
  const start = seat.start_date ?? '';
  const end = seat.end_date ?? '';
  // Temp seats without dates are unusual; pass empty strings and let
  // Kindoo's UI render them as "missing" rather than failing the call.
  return {
    startEdit: start ? `${start}T00:00` : '',
    expiryEdit: end ? `${end}T23:59` : '',
  };
}

function tempDatesForInvite(seat: Seat): { startInvite: string; expiryInvite: string } {
  const start = seat.start_date ?? '';
  const end = seat.end_date ?? '';
  return {
    startInvite: start ? `${start} 00:00` : '',
    expiryInvite: end ? `${end} 23:59` : '',
  };
}

function displayName(seat: Seat): string {
  return seat.member_name || seat.member_email;
}

function joinBuildings(names: string[]): string {
  return names.length > 0 ? names.join(', ') : '(no buildings)';
}
