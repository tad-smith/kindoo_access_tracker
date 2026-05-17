// Typed wrappers over the Kindoo endpoints v2.1 + v2.2 need.
//
// All return plain JSON. Wire-format field names are verbose
// (`EnvironmentID`, `EnvironmentName`, …); we normalize to short
// internal names (`EID`, `Name`, …) at the parser so consumers stay
// stable if Kindoo ever changes its shape again.
//
// On a malformed response shape we throw `KindooApiError('unexpected-shape', …)`
// so the caller's catch can render a "Kindoo API changed" recovery.
//
// **v2.2 write endpoints.** Seven wrappers around the mutation
// surface: `checkUserType`, `inviteUser`, `editUser`,
// `saveAccessRule`, `lookupUserByEmail`, `revokeUser`,
// `revokeUserFromAccessSchedule`. `lookupUserByEmail` returns a rich
// `KindooEnvironmentUser | null` — the orchestrator reads the user's
// current EUID / UserID / Description / temp flag / dates /
// AccessSchedules from the lookup, computes the post-completion
// target state, and drives Kindoo to it via `editUser` (env-user
// settings) and/or `saveAccessRule` (rule set). EUID vs UserID:
// `editUser` and `revokeUserFromAccessSchedule` take EUID;
// `saveAccessRule` / `revokeUser` take UserID.
//
// `revokeUserFromAccessSchedule` narrows the rule set one rule at a
// time (since `saveAccessRule` is MERGE-only and can't shrink); used
// by the v2.2 scope-aware remove flow alongside `revokeUser` (full
// wipe when the seat has no buildings left).

import { postKindoo, KindooApiError } from './client';
import type { KindooSession } from './auth';

export interface KindooEnvironment {
  /** Kindoo's site / environment id. Matches a key under
   * `localStorage.state.sites.entities` and is recovered for the
   * active session via `readActiveEidFromDom` in `auth.ts`. */
  EID: number;
  /** Display name (e.g. `"Colorado Springs North Stake"`). */
  Name: string;
  /** Anything else Kindoo returns — opaque to v2.1. */
  [k: string]: unknown;
}

export interface KindooAccessRule {
  /** Kindoo's rule id. Persisted on the building doc as `kindoo_rule.rule_id`. */
  RID: number;
  /** Display name (e.g. `"Cordera Doors"`). */
  Name: string;
  /** Anything else Kindoo returns — opaque to v2.1. */
  [k: string]: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asEnvironment(value: unknown): KindooEnvironment | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const eid = v.EnvironmentID;
  const name = v.EnvironmentName;
  if (typeof eid !== 'number' || typeof name !== 'string') return null;
  return { ...v, EID: eid, Name: name };
}

function asAccessRule(value: unknown): KindooAccessRule | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const rid = v.ID;
  const name = v.Name;
  if (typeof rid !== 'number' || typeof name !== 'string') return null;
  return { ...v, RID: rid, Name: name };
}

/**
 * List every environment the signed-in Kindoo Manager can administer.
 * v2.1 uses this to verify the site name matches the SBA stake name.
 */
export async function getEnvironments(
  session: KindooSession,
  fetchImpl?: typeof fetch,
): Promise<KindooEnvironment[]> {
  const raw = await postKindoo('KindooGetEnvironments', session, {}, fetchImpl);
  const list = asArray(raw);
  const parsed: KindooEnvironment[] = [];
  for (const entry of list) {
    const env = asEnvironment(entry);
    if (!env) {
      throw new KindooApiError(
        'unexpected-shape',
        'KindooGetEnvironments entry missing EnvironmentID/EnvironmentName',
      );
    }
    parsed.push(env);
  }
  return parsed;
}

/**
 * List every Access Rule defined for the given site. The operator
 * picks one rule per SBA building from this list.
 *
 * `eid` is explicit (rather than re-using `session.eid`) because v2.1
 * verifies site identity by passing the localStorage-derived EID
 * separately; if the two ever diverge the caller wants the param to
 * win.
 */
export async function getEnvironmentRules(
  session: KindooSession,
  eid: number,
  fetchImpl?: typeof fetch,
): Promise<KindooAccessRule[]> {
  const raw = await postKindoo('KindooGetEnvironmentRules', { ...session, eid }, {}, fetchImpl);
  const list = asArray(raw);
  const parsed: KindooAccessRule[] = [];
  for (const entry of list) {
    const rule = asAccessRule(entry);
    if (!rule) {
      throw new KindooApiError(
        'unexpected-shape',
        'KindooGetEnvironmentRules entry missing ID/Name',
      );
    }
    parsed.push(rule);
  }
  return parsed;
}

// ============================================================
// v2.2 — write endpoints
// ============================================================

/**
 * Invite payload Kindoo's add-user form sends. We build one of these
 * and JSON-stringify it into the `UsersEmail` form field (Kindoo's
 * wire shape — a JSON array of user objects despite the
 * "Email"-ish field name).
 *
 * Date format is `YYYY-MM-DD HH:MM` (SPACE separator) for Invite —
 * distinct from Edit's T separator. See `extension/docs/v2-design.md`
 * § "Date format choreography".
 */
export interface KindooInviteUserPayload {
  UserEmail: string;
  /** Hardcoded to 2 (Guest) for every SBA-provisioned seat. */
  UserRole: 2;
  /** Free-text — "Cordera Ward (Sunday School President)" etc. */
  Description: string;
  CCInEmail: boolean;
  IsTempUser: boolean;
  /** `YYYY-MM-DD HH:MM` 24h, or null for permanent users. */
  StartAccessDoorsDate: string | null;
  /** `YYYY-MM-DD HH:MM` 24h, or null for permanent users. */
  ExpiryDate: string | null;
  /** Windows-style tz string from `KindooGetEnvironments` (e.g. `"Mountain Standard Time"`). */
  ExpiryTimeZone: string;
}

/**
 * Edit-user payload. Different field naming + date format from Invite:
 *   - lowercase `description` / `isTemp` / `timeZone` (Invite uses PascalCase)
 *   - `startAccessDoorsDateTime` / `expiryDate` with the T separator
 * Echo lookup values for any field you don't intend to change.
 */
export interface KindooEditUserPayload {
  description: string;
  isTemp: boolean;
  /** `YYYY-MM-DDTHH:MM` (T separator, no seconds). Empty string for
   * permanent users — Kindoo accepts that wire form per the live
   * capture. */
  startAccessDoorsDateTime: string;
  /** Same format as `startAccessDoorsDateTime`. */
  expiryDate: string;
  /** Windows-style; echo lookup's `ExpiryTimeZone`. */
  timeZone: string;
}

/** Result of the email-existence probe. */
export interface KindooUserCheckResult {
  exists: boolean;
  uid: string | null;
}

/**
 * The fields the v2.2 orchestrator needs off a Kindoo environment-user
 * record. The wire shape carries many more (see
 * `extension/docs/v2-kindoo-api-capture.md`); we narrow to a stable
 * subset and keep the index signature for opaque pass-through.
 */
export interface KindooEnvironmentUser {
  /** Environment-scoped user id. Used as the `euID` form field on Edit. */
  euid: string;
  /** Cross-env user id. Used as the `UID` form field on SaveAccessRule / Revoke. */
  userId: string;
  /** Login email (Kindoo's `Username` field). */
  username: string;
  /** Current free-text description on the Kindoo seat. */
  description: string;
  /** Current temp-vs-permanent flag. */
  isTempUser: boolean;
  /** Lookup's `StartAccessDoorsDateAtTimeZone` — already in Edit's `YYYY-MM-DDTHH:MM` format. `null` for permanent users. */
  startAccessDoorsDateAtTimeZone: string | null;
  /** Lookup's `ExpiryDateAtTimeZone` — already in Edit's `YYYY-MM-DDTHH:MM` format. `null` for permanent users. */
  expiryDateAtTimeZone: string | null;
  /** Windows-style tz string (e.g. `"Mountain Standard Time"`). */
  expiryTimeZone: string;
  /** Current rule assignments — `RuleID` narrowed from `AccessSchedules[]`. */
  accessSchedules: Array<{ ruleId: number }>;
  /**
   * Buildings derived from per-door grants via
   * `sync/buildingsFromDoors.ts`. Set by the Sync orchestrator BEFORE
   * calling `detect()`. Three states:
   *   - `string[]` — derivation succeeded; use this as Kindoo's
   *     effective building set (auto seats use this in
   *     `buildings-mismatch`).
   *   - `[]` — derived; user has no effective building access.
   *   - `null` / `undefined` — derivation skipped or failed; the
   *     detector falls back to Phase 1 behaviour (skip buildings
   *     comparison for auto seats).
   */
  derivedBuildings?: string[] | null;
  /** Anything else Kindoo returns. */
  [k: string]: unknown;
}

/**
 * Pull a string-typed UID off a Kindoo response object, recognising a
 * few common field-name spellings (response shapes vary by endpoint).
 * Returns null if nothing fits.
 */
function pickUid(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  for (const key of ['UID', 'Uid', 'uid', 'UserID', 'UserId', 'userId', 'ID', 'Id', 'id']) {
    const candidate = v[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * Some Kindoo responses come back wrapped in a `{ d: <payload> }`
 * envelope (ASP.NET's old default); others return the payload
 * directly. Unwrap once if we see the wrapper.
 */
function unwrapAspNet(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object' && 'd' in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).d;
  }
  return raw;
}

/**
 * Recursively search a value tree for the first UID-shaped string.
 * Used as a last-resort UID extractor when the response wraps the
 * field inside an unfamiliar nest.
 */
function findFirstUid(raw: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof raw !== 'object' || raw === null) return null;
  const direct = pickUid(raw);
  if (direct) return direct;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const nested = findFirstUid(entry, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  for (const v of Object.values(raw as Record<string, unknown>)) {
    const nested = findFirstUid(v, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * Probe whether `email` already has a Kindoo user record in the active
 * site. Wraps `KindooCheckUserTypeInKindoo`, which takes a JSON array
 * of emails in the `UsersEmail` form field and returns user info.
 *
 * Response shape is not captured live; the parser tries common UID
 * field names and returns `{ exists: false, uid: null }` when it sees
 * an explicit "not found" signal (empty array, `null`, `{}`). If the
 * response carries a string-typed UID anywhere we treat the user as
 * existing.
 *
 * The v2.2 orchestrator does NOT use this directly — it relies on
 * `lookupUserByEmail` returning `null` as the "not exists" signal so
 * one round-trip serves both existence + rich-state queries. Kept
 * for `inviteUser`'s fallback UID resolution.
 */
export async function checkUserType(
  session: KindooSession,
  email: string,
  fetchImpl?: typeof fetch,
): Promise<KindooUserCheckResult> {
  const raw = await postKindoo(
    'KindooCheckUserTypeInKindoo',
    session,
    { UsersEmail: JSON.stringify([email]) },
    fetchImpl,
  );
  const body = unwrapAspNet(raw);

  // Empty / null / missing = not in Kindoo.
  if (body === null || body === undefined) {
    return { exists: false, uid: null };
  }
  if (Array.isArray(body) && body.length === 0) {
    return { exists: false, uid: null };
  }

  const uid = findFirstUid(body);
  if (uid) return { exists: true, uid };

  // Plain `{}` / `[{}]` shapes with no UID — treat as not-found rather
  // than throwing. Kindoo's UI uses the same probe before showing the
  // invite form; "no UID returned" is the not-found signal.
  return { exists: false, uid: null };
}

/**
 * Invite a single user to the site. Wraps
 * `KindooCheckUserTypeAndInviteAccordingToType`. The Kindoo endpoint
 * takes a JSON array of one user object in `UsersEmail` (yes — the
 * field name is misleading; it's the user record).
 *
 * Returns the freshly-minted UID. When the response doesn't carry one
 * directly, falls back to a `checkUserType(email)` round-trip — the
 * orchestrator paid the cost of one extra request rather than failing
 * the whole flow if Kindoo varies the invite response shape.
 */
export async function inviteUser(
  session: KindooSession,
  payload: KindooInviteUserPayload,
  fetchImpl?: typeof fetch,
): Promise<{ uid: string }> {
  const raw = await postKindoo(
    'KindooCheckUserTypeAndInviteAccordingToType',
    session,
    { UsersEmail: JSON.stringify([payload]) },
    fetchImpl,
  );
  const body = unwrapAspNet(raw);
  const direct = findFirstUid(body);
  if (direct) return { uid: direct };

  // Fallback — re-probe by email to resolve the UID we just created.
  const probe = await checkUserType(session, payload.UserEmail, fetchImpl);
  if (probe.exists && probe.uid) return { uid: probe.uid };

  throw new KindooApiError(
    'unexpected-shape',
    'KindooCheckUserTypeAndInviteAccordingToType: no UID in response and fallback checkUserType found no match',
  );
}

/**
 * Edit advanced settings on an EXISTING environment-user. Wraps
 * `KindooEditEnvironmentUserAdvancedSettings`.
 *
 * Field naming is lowercase / camelCase (`euID`, `description`,
 * `isTemp`, `startAccessDoorsDateTime`, `expiryDate`, `timeZone`) —
 * distinct from Invite. Date format is `YYYY-MM-DDTHH:MM` (T
 * separator). PATCH-style: echo lookup values for fields you don't
 * intend to change.
 *
 * Response shape isn't captured; any HTTP-200 is success.
 */
export async function editUser(
  session: KindooSession,
  euId: string,
  payload: KindooEditUserPayload,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true }> {
  await postKindoo(
    'KindooEditEnvironmentUserAdvancedSettings',
    session,
    {
      euID: euId,
      description: payload.description,
      isTemp: String(payload.isTemp),
      startAccessDoorsDateTime: payload.startAccessDoorsDateTime,
      expiryDate: payload.expiryDate,
      timeZone: payload.timeZone,
    },
    fetchImpl,
  );
  return { ok: true };
}

/**
 * Apply a list of Access Rule RIDs to a user. Wraps
 * `KindooSaveAccessRuleFromListOfAccessSchedules`. The RIDs are sent
 * as a JSON array in the `RIDs` form field; `username` is empty
 * (captured live as empty string — purpose unclear, safest to match).
 *
 * **Semantics are MERGE, not REPLACE** (confirmed in staging
 * 2026-05-12): sending a subset of the user's current RIDs does NOT
 * remove the omitted rules — only additions land. To remove a rule
 * use `revokeUserFromAccessSchedule` (scope-specific) or `revokeUser`
 * (whole-user). v2.2's add path relies on MERGE directly; the remove
 * path also calls this when a promoted-duplicate brings in a building
 * not previously in Kindoo for the user.
 *
 * `uid` is **UserID** (NOT EUID — different from `editUser`'s param).
 *
 * Response shape isn't captured; any HTTP-200 is success.
 */
export async function saveAccessRule(
  session: KindooSession,
  uid: string,
  rids: number[],
  fetchImpl?: typeof fetch,
): Promise<{ ok: true }> {
  await postKindoo(
    'KindooSaveAccessRuleFromListOfAccessSchedules',
    session,
    {
      UID: uid,
      RIDs: JSON.stringify(rids),
      username: '',
    },
    fetchImpl,
  );
  return { ok: true };
}

/**
 * Narrow one `EUList` entry to the v2.2 `KindooEnvironmentUser` shape.
 * Returns `null` when the required identity fields aren't present.
 * Optional fields default to empty / null when missing.
 */
function asEnvironmentUser(value: unknown): KindooEnvironmentUser | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const euid = v.EUID;
  const userId = v.UserID;
  const username = v.Username;
  if (typeof euid !== 'string' || euid.length === 0) return null;
  if (typeof userId !== 'string' || userId.length === 0) return null;
  if (typeof username !== 'string' || username.length === 0) return null;

  const description = typeof v.Description === 'string' ? v.Description : '';
  const isTempUser = v.IsTempUser === true;
  const startAt = v.StartAccessDoorsDateAtTimeZone;
  const expiryAt = v.ExpiryDateAtTimeZone;
  const startAccessDoorsDateAtTimeZone =
    typeof startAt === 'string' && startAt.length > 0 ? startAt : null;
  const expiryDateAtTimeZone =
    typeof expiryAt === 'string' && expiryAt.length > 0 ? expiryAt : null;
  const expiryTimeZone = typeof v.ExpiryTimeZone === 'string' ? v.ExpiryTimeZone : '';

  const accessSchedulesRaw = Array.isArray(v.AccessSchedules) ? v.AccessSchedules : [];
  const accessSchedules: Array<{ ruleId: number }> = [];
  for (const sched of accessSchedulesRaw) {
    if (typeof sched !== 'object' || sched === null) continue;
    const s = sched as Record<string, unknown>;
    const ruleId = s.RuleID;
    if (typeof ruleId === 'number') accessSchedules.push({ ruleId });
  }

  return {
    ...v,
    euid,
    userId,
    username,
    description,
    isTempUser,
    startAccessDoorsDateAtTimeZone,
    expiryDateAtTimeZone,
    expiryTimeZone,
    accessSchedules,
  };
}

/**
 * Look up the Kindoo environment-user for `email` and return its rich
 * state (EUID, UserID, current description, temp flag, dates,
 * AccessSchedules). Wraps
 * `KindooGetEnvironmentUsersLightWithTotalNumberOfRecords`.
 *
 * Kindoo's `keyWord` parameter does a **substring** match; we filter
 * the returned list by exact `Username` (case-insensitive) so we
 * never accidentally update a different user whose email contains
 * the search term. Returns `null` when no exact match — that signal
 * is what the orchestrator branches on for "invite vs edit."
 *
 * Response wraps the list in `EUList` (per capture); legacy bare-array
 * and other key spellings are accepted defensively.
 */
export async function lookupUserByEmail(
  session: KindooSession,
  email: string,
  fetchImpl?: typeof fetch,
): Promise<KindooEnvironmentUser | null> {
  const raw = await postKindoo(
    'KindooGetEnvironmentUsersLightWithTotalNumberOfRecords',
    session,
    {
      start: '0',
      end: '50',
      keyWord: email,
      FetchInvitedOnInvitedByData: 'true',
    },
    fetchImpl,
  );
  const body = unwrapAspNet(raw);

  let list: unknown[] = [];
  if (Array.isArray(body)) {
    list = body;
  } else if (body !== null && typeof body === 'object') {
    const v = body as Record<string, unknown>;
    for (const key of ['EUList', 'Users', 'users', 'Items', 'items', 'Results', 'results']) {
      const candidate = v[key];
      if (Array.isArray(candidate)) {
        list = candidate;
        break;
      }
    }
  }

  const target = email.toLowerCase();
  for (const entry of list) {
    const user = asEnvironmentUser(entry);
    if (!user) continue;
    if (user.username.toLowerCase() === target) return user;
  }
  return null;
}

/**
 * Revoke a user from the site. Wraps
 * `KindooRevokeUserFromEnvironment`. Captured payload shows `username`
 * as an empty string — passing through verbatim.
 *
 * `uid` is **UserID** (NOT EUID).
 *
 * Response shape isn't captured; any HTTP-200 is success.
 */
export async function revokeUser(
  session: KindooSession,
  uid: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true }> {
  await postKindoo(
    'KindooRevokeUserFromEnvironment',
    session,
    {
      UID: uid,
      username: '',
    },
    fetchImpl,
  );
  return { ok: true };
}

/**
 * Page through every environment-user in the active site. Loops
 * `KindooGetEnvironmentUsersLightWithTotalNumberOfRecords` with
 * `start += 50` until the page returns fewer than 50 entries OR
 * `TotalRecordNumber` is reached.
 *
 * Used by the Sync feature to read the entire Kindoo user state for
 * the drift report. `lookupUserByEmail` is the single-user variant
 * that only reads the first page; this one drains all pages.
 *
 * The page size 50 matches Kindoo's own admin UI default (and is what
 * `lookupUserByEmail` sends).
 *
 * **Dedup by EUID after collection.** A no-keyword paginated listing
 * returns one row per access-schedule (a user with 3 rules → 3 rows).
 * `lookupUserByEmail`'s keyword-filtered single-user capture didn't
 * surface this; staging sync drove 313 SBA users to 652 reported rows
 * before dedup. We merge `accessSchedules[]` across rows (defensively,
 * in case different rows carry different rules) and keep the first
 * row's other metadata.
 */
export async function listAllEnvironmentUsers(
  session: KindooSession,
  fetchImpl?: typeof fetch,
): Promise<KindooEnvironmentUser[]> {
  const PAGE_SIZE = 50;
  const out: KindooEnvironmentUser[] = [];
  let start = 0;
  let total: number | null = null;
  // Hard safety cap. v1 single-stake operates at ~300 users; the cap
  // gives ample headroom while making sure an off-by-one wire issue
  // can't infinite-loop.
  const MAX_PAGES = 200;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const raw = await postKindoo(
      'KindooGetEnvironmentUsersLightWithTotalNumberOfRecords',
      session,
      {
        start: String(start),
        end: String(start + PAGE_SIZE),
        // Empty keyword fetches all users (Kindoo's substring-empty == "any").
        keyWord: '',
        FetchInvitedOnInvitedByData: 'true',
      },
      fetchImpl,
    );
    const body = unwrapAspNet(raw);
    let list: unknown[] = [];
    if (Array.isArray(body)) {
      list = body;
    } else if (body !== null && typeof body === 'object') {
      const v = body as Record<string, unknown>;
      for (const key of ['EUList', 'Users', 'users', 'Items', 'items', 'Results', 'results']) {
        const candidate = v[key];
        if (Array.isArray(candidate)) {
          list = candidate;
          break;
        }
      }
      if (total === null && typeof v.TotalRecordNumber === 'number') {
        total = v.TotalRecordNumber;
      }
    }

    for (const entry of list) {
      const user = asEnvironmentUser(entry);
      if (user) out.push(user);
    }

    // Stop when the page returned fewer than PAGE_SIZE entries OR we
    // reached the total record number.
    if (list.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
    if (total !== null && start >= total) break;
  }

  // Dedup by EUID — merge accessSchedules across duplicate rows,
  // keep first row's other metadata.
  const byEuid = new Map<string, KindooEnvironmentUser>();
  let dupRows = 0;
  for (const user of out) {
    const existing = byEuid.get(user.euid);
    if (existing) {
      dupRows += 1;
      const seenRuleIds = new Set(existing.accessSchedules.map((s) => s.ruleId));
      for (const sched of user.accessSchedules) {
        if (!seenRuleIds.has(sched.ruleId)) {
          existing.accessSchedules.push(sched);
          seenRuleIds.add(sched.ruleId);
        }
      }
    } else {
      byEuid.set(user.euid, user);
    }
  }
  if (dupRows > 0) {
    console.log(
      `[sba-ext] listAllEnvironmentUsers: dedup collapsed ${dupRows} duplicate rows to ${byEuid.size} unique users.`,
    );
  }
  return Array.from(byEuid.values());
}

// ============================================================
// Door-grant derivation endpoints (Phase 2 — auto-user buildings)
// ============================================================
//
// `getEnvironmentRuleWithEntryPoints` returns the full door list for
// the env with `IsSelected: true` on each door the queried rule
// includes; `getUserAccessRulesWithEntryPoints` returns every DoorID
// the user can open (paginated, regardless of whether the grant came
// via an AccessRule or a Church Access Automation direct grant).
//
// The two together let us derive an auto user's effective AccessRule
// set (and from there, their SBA building access) without depending on
// the bulk listing's `AccessSchedules` array, which excludes the
// direct-grant rows. See `sync/buildingsFromDoors.ts` for the
// strict-subset derivation.

/** One door in the environment. */
export interface KindooDoor {
  /** Kindoo's internal door id. */
  doorId: number;
  /** Display name ("Cordera - North"). */
  name: string;
  /** Building address text ("Meetinghouse - 8295 Jamboree Circle"). */
  description: string;
}

/**
 * Fetch one Kindoo Access Rule with its door membership. Wraps
 * `KindooGetEnvRuleWithEntryPointsFormatted`.
 *
 * The response includes every door in the environment with
 * `IsSelected: true` on the doors that belong to the queried rule.
 * We return both the selected DoorID subset and the full door list —
 * the immediate consumer (`buildRuleDoorMap`) uses the subset; the
 * full list rides along for future diagnostics.
 *
 * Network cost: one call per rule. csnorth has 4 rules; the caller
 * runs all 4 once per sync session.
 */
export async function getEnvironmentRuleWithEntryPoints(
  session: KindooSession,
  ruleId: number,
  eid: number,
  fetchImpl?: typeof fetch,
): Promise<{
  ruleId: number;
  ruleName: string;
  selectedDoorIds: number[];
  allDoors: KindooDoor[];
}> {
  const raw = await postKindoo(
    'KindooGetEnvRuleWithEntryPointsFormatted',
    { ...session, eid },
    {
      RuleID: String(ruleId),
      isClone: 'false',
    },
    fetchImpl,
  );
  const body = unwrapAspNet(raw);
  if (body === null || typeof body !== 'object') {
    throw new KindooApiError(
      'unexpected-shape',
      `KindooGetEnvRuleWithEntryPointsFormatted: non-object response for rule ${ruleId}`,
    );
  }
  const v = body as Record<string, unknown>;
  const id = v.ID;
  const name = v.Name;
  if (typeof id !== 'number' || typeof name !== 'string') {
    throw new KindooApiError(
      'unexpected-shape',
      `KindooGetEnvRuleWithEntryPointsFormatted: missing ID/Name on rule ${ruleId}`,
    );
  }
  const doorsRaw = Array.isArray(v.doors) ? v.doors : [];
  const allDoors: KindooDoor[] = [];
  const selectedDoorIds: number[] = [];
  for (const entry of doorsRaw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const d = entry as Record<string, unknown>;
    const did = d.ID;
    if (typeof did !== 'number') continue;
    const doorName = typeof d.Name === 'string' ? d.Name : '';
    const description = typeof d.Description === 'string' ? d.Description : '';
    allDoors.push({ doorId: did, name: doorName, description });
    if (d.IsSelected === true) selectedDoorIds.push(did);
  }
  return { ruleId: id, ruleName: name, selectedDoorIds, allDoors };
}

/** One door-grant row off
 * `KindooGetUserAccessRulesLightWithTotalNumberOfRecordsWithEntryPoints`.
 * `accessScheduleId === 0` indicates a direct grant (Church Access
 * Automation); non-zero ids point back at an AccessRule. */
export interface UserDoorGrantRow {
  doorId: number;
  accessScheduleId: number;
}

/**
 * Page through every door grant a Kindoo user has — covers BOTH
 * rule-derived grants AND direct grants from Church Access Automation.
 *
 * Wraps
 * `KindooGetUserAccessRulesLightWithTotalNumberOfRecordsWithEntryPoints`.
 * Loops `start = 0, 40, 80, …` (Kindoo's per-user page size) until a
 * short page or `TotalRecordNumber` terminates. The flattened list is
 * deduplicated by `doorId` — the same door can appear once per rule
 * that grants it; we only care about the unique door set.
 */
export async function getUserAccessRulesWithEntryPoints(
  session: KindooSession,
  userId: string,
  eid: number,
  fetchImpl?: typeof fetch,
): Promise<UserDoorGrantRow[]> {
  const PAGE_SIZE = 40;
  // Safety cap. A user with hundreds of doors would be an outlier; the
  // cap stops a wire mismatch from spinning forever.
  const MAX_PAGES = 100;
  const seen = new Set<number>();
  const out: UserDoorGrantRow[] = [];
  let start = 0;
  let total: number | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const raw = await postKindoo(
      'KindooGetUserAccessRulesLightWithTotalNumberOfRecordsWithEntryPoints',
      { ...session, eid },
      {
        UID: userId,
        keyword: '',
        start: String(start),
        end: String(start + PAGE_SIZE),
        source: 'SiteUserManage:useEffect:fetchUserRules',
        fillEmptyWeeklyDaysWithOneRow: 'true',
        FetchGrantedByData: 'true',
      },
      fetchImpl,
    );
    const body = unwrapAspNet(raw);
    let list: unknown[] = [];
    if (Array.isArray(body)) {
      list = body;
    } else if (body !== null && typeof body === 'object') {
      const v = body as Record<string, unknown>;
      for (const key of ['RulesList', 'rulesList', 'Rules', 'rules', 'Items', 'items']) {
        const candidate = v[key];
        if (Array.isArray(candidate)) {
          list = candidate;
          break;
        }
      }
      if (total === null && typeof v.TotalRecordNumber === 'number') {
        total = v.TotalRecordNumber;
      }
    }
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const r = entry as Record<string, unknown>;
      const did = r.DoorID;
      if (typeof did !== 'number') continue;
      if (seen.has(did)) continue;
      seen.add(did);
      const asid = typeof r.AccessScheduleID === 'number' ? r.AccessScheduleID : 0;
      out.push({ doorId: did, accessScheduleId: asid });
    }
    if (list.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
    if (total !== null && start >= total) break;
  }
  return out;
}

/**
 * Revoke a single Access Rule from a user — narrows the rule set
 * without touching the rest of the user. Wraps
 * `KindooRevokeUserFromAccesSchedule` (NOTE: Kindoo's typo — single
 * `s` in `AccesSchedule`; keep the typo as the wire spelling).
 *
 * Response is a plain string: `"1"` is success; any other response is
 * treated as an error.
 *
 * `euId` is **EUID** (env-scoped); `ruleId` is the rule's RID
 * (e.g. 6250).
 *
 * Used by the v2.2 scope-aware remove flow to drop the rules the
 * post-removal seat no longer needs while keeping the survivors. The
 * orchestrator falls through to `revokeUser` only when nothing
 * remains in the post-removal set.
 */
export async function revokeUserFromAccessSchedule(
  session: KindooSession,
  euId: string,
  ruleId: number,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true }> {
  const raw = await postKindoo(
    'KindooRevokeUserFromAccesSchedule',
    session,
    {
      EUID: euId,
      ID: String(ruleId),
    },
    fetchImpl,
  );
  if (raw === '1' || raw === 1) return { ok: true };
  throw new KindooApiError(
    'unexpected-shape',
    `KindooRevokeUserFromAccesSchedule returned ${JSON.stringify(raw)} (expected "1")`,
  );
}
