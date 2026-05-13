// Typed wrappers over the two read-only Kindoo endpoints v2.1 needs.
//
// Both return plain JSON arrays. Response field shapes are observed
// from a live capture; we narrow only the fields the configuration
// flow consumes (EID + Name for environments, RID + Name for rules)
// and pass the rest through as unknown for forward compat.
//
// On a malformed response shape we throw `KindooApiError('unexpected-shape', …)`
// so the caller's catch can render a "Kindoo API changed" recovery.

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
  const eid = v.EID;
  const name = v.Name;
  if (typeof eid !== 'number' || typeof name !== 'string') return null;
  return { ...v, EID: eid, Name: name };
}

function asAccessRule(value: unknown): KindooAccessRule | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const rid = v.RID;
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
      throw new KindooApiError('unexpected-shape', 'KindooGetEnvironments entry missing EID/Name');
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
        'KindooGetEnvironmentRules entry missing RID/Name',
      );
    }
    parsed.push(rule);
  }
  return parsed;
}
