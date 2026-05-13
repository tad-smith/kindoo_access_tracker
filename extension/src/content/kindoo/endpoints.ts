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
// **v2.2 write endpoints.** Response shapes for the five mutating
// endpoints (checkUserType, inviteUser, saveAccessRule, lookupUserByEmail,
// revokeUser) were not captured live before the wrappers shipped;
// parsers extract only the fields the orchestrator needs and degrade
// gracefully when the shape varies. Each parser throws unexpected-shape
// only when a load-bearing field is unrecoverable.

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
 * server-side and JSON-stringify it into the `UsersEmail` form field
 * (Kindoo's wire shape — a JSON array of user objects despite the
 * "Email"-ish field name).
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

/** Result of the email-existence probe. */
export interface KindooUserCheckResult {
  exists: boolean;
  uid: string | null;
}

/** One user record from the email-keyword lookup. */
export interface KindooUserSummary {
  uid: string;
  email: string;
}

/**
 * Pull a string-typed UID off a Kindoo response object, recognising a
 * few common field-name spellings (we don't have a captured response
 * shape yet — defend against several). Returns null if nothing fits.
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
 * Pull a string-typed email off a user-ish object, recognising a few
 * common field-name spellings.
 */
function pickEmail(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  for (const key of ['Email', 'UserEmail', 'email']) {
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
 * Response shape is not captured live for v2.2; the parser tries
 * common UID field names and returns `{ exists: false, uid: null }`
 * when it sees an explicit "not found" signal (empty array, `null`,
 * `{}`). If the response carries a string-typed UID anywhere we treat
 * the user as existing.
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
 * Apply a list of Access Rule RIDs to a user. Wraps
 * `KindooSaveAccessRuleFromListOfAccessSchedules`. The RIDs are sent
 * as a JSON array in the `RIDs` form field; `username` is empty
 * (captured live as empty string — purpose unclear, safest to match).
 *
 * Response shape isn't captured; we treat any HTTP-200 as success
 * (the underlying `postKindoo` already throws on non-2xx + bad JSON).
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
 * Search users by email keyword. Wraps
 * `KindooGetEnvironmentUsersLightWithTotalNumberOfRecords` with the
 * default first-page pagination Kindoo's UI uses.
 *
 * Returns a slim shape — `{ uid, email }` for each match. The remove
 * flow uses the first match's UID; future disambiguation logic can be
 * added if we ever see collisions in practice.
 */
export async function lookupUserByEmail(
  session: KindooSession,
  keyword: string,
  fetchImpl?: typeof fetch,
): Promise<{ users: KindooUserSummary[] }> {
  const raw = await postKindoo(
    'KindooGetEnvironmentUsersLightWithTotalNumberOfRecords',
    session,
    {
      start: '0',
      end: '50',
      keyWord: keyword,
      FetchInvitedOnInvitedByData: 'true',
    },
    fetchImpl,
  );
  const body = unwrapAspNet(raw);

  // Kindoo's "users + total" endpoints commonly return either a bare
  // array of users or `{ Users: [...], TotalNumberOfRecords: N }`.
  // Handle both.
  let list: unknown[] = [];
  if (Array.isArray(body)) {
    list = body;
  } else if (body !== null && typeof body === 'object') {
    const v = body as Record<string, unknown>;
    for (const key of ['Users', 'users', 'Items', 'items', 'Results', 'results']) {
      const candidate = v[key];
      if (Array.isArray(candidate)) {
        list = candidate;
        break;
      }
    }
  }

  const users: KindooUserSummary[] = [];
  for (const entry of list) {
    const uid = pickUid(entry);
    const email = pickEmail(entry);
    if (uid && email) users.push({ uid, email });
  }
  return { users };
}

/**
 * Revoke a user from the site. Wraps
 * `KindooRevokeUserFromEnvironment`. Captured payload shows `username`
 * as an empty string — passing through verbatim.
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
