// Read Kindoo's session token + active site id from web.kindoo.tech's
// localStorage. The content script runs in the page's same-origin
// context, so direct access is fine — no SW round-trip needed.
//
// Kindoo stores everything in two keys:
//   - `kindoo_token`  — bearer UUID for the ASMX API on service89.kindoo.tech.
//   - `state`         — JSON blob; the first id in `sites.ids[]` is the
//                       active environment / site (EID).
//
// Failure modes the caller branches on:
//   - 'no-token'  → operator is signed out of Kindoo (or never signed in).
//   - 'no-eid'    → token exists but site state is missing / malformed.
//                   In practice this means a partially-hydrated Kindoo
//                   page; ask the operator to refresh.
//
// All other shapes (missing keys, malformed JSON, empty `sites.ids[]`)
// collapse into `no-eid`. The caller doesn't need finer granularity —
// the user-facing recovery is identical (re-sign-into-Kindoo / refresh).

export interface KindooSession {
  token: string;
  eid: number;
}

export type KindooSessionError = 'no-token' | 'no-eid';

export type KindooSessionResult =
  | { ok: true; session: KindooSession }
  | { ok: false; error: KindooSessionError };

interface KindooStateShape {
  sites?: {
    ids?: unknown;
  };
}

function readToken(storage: Storage): string | null {
  const raw = storage.getItem('kindoo_token');
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readEid(storage: Storage): number | null {
  const raw = storage.getItem('state');
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const ids = (parsed as KindooStateShape).sites?.ids;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const first = ids[0];
  if (typeof first !== 'number' || !Number.isFinite(first)) return null;
  return first;
}

/**
 * Pull the Kindoo session from the given Storage (defaults to
 * `window.localStorage`). Returns a typed result so the caller can
 * `if (!result.ok)` and render the appropriate recovery state.
 */
export function readKindooSession(storage: Storage = window.localStorage): KindooSessionResult {
  const token = readToken(storage);
  if (!token) return { ok: false, error: 'no-token' };
  const eid = readEid(storage);
  if (eid === null) return { ok: false, error: 'no-eid' };
  return { ok: true, session: { token, eid } };
}
