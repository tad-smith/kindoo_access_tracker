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
// `revokeUserFromAccessSchedule` is shipped but unused by v2.2 — v2.2
// always whole-revokes via `revokeUser` because `saveAccessRule` is
// MERGE-only and can't narrow a rule set. Reserved for the future
// scope-specific remove flow (see `docs/BUGS.md` B-10).

import { postKindoo, KindooApiError } from './client';
import type { KindooSession } from './auth';

export interface KindooEnvironment {
  /** Kindoo's site / environment id. Matches localStorage.state.sites.ids[0]. */
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
 * (whole-user). v2.2 only uses this on the add path, where MERGE is
 * exactly what we want.
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
 * v2.2 doesn't use this — its orchestrator always whole-revokes via
 * `revokeUser`. Reserved for the future scope-specific remove flow
 * (see `docs/BUGS.md` B-10).
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
