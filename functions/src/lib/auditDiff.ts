// Shallow before/after diff for audit-trigger payloads.
//
// The audit log stores a snapshot pair (`before`, `after`) per row;
// readers (the manager Audit Log page) re-derive a field-by-field
// summary from the pair. The trigger uses the diff helper for two
// purposes:
//
//   1. **No-op skip.** A write whose only changed fields are
//      bookkeeping (timestamps, the `lastActor` integrity-check field,
//      `last_modified_*` mirrors) shouldn't emit an audit row. Such
//      writes happen when, e.g., the SPA writes a doc with a fresh
//      `lastActor` but no real field change — a stutter that the audit
//      trail shouldn't notice.
//
//   2. **Bookkeeping field exclusion.** When a row IS written, the
//      `before`/`after` snapshots still include bookkeeping fields
//      (the operator may want to see exactly what landed in
//      Firestore). Only the *changed-keys* check excludes them.
//
// Map/array fields like `manual_grants`, `importer_callings`,
// `building_codes`, `callings`, `duplicate_grants` are compared by a
// recursive deep-equal helper. Contract: primitives compare with
// `===`; arrays compare positionally (same length, same value at
// each index, recursively); plain objects compare by key SET (NOT
// key order), then recurse on each value. `undefined` and missing
// keys are treated identically. `null` compares only equal to
// `null`. Self-contained, no dependency.

import { BOOKKEEPING_FIELDS } from '@kindoo/shared';

// Re-exported so existing local imports of `BOOKKEEPING_FIELDS` from
// `./auditDiff` still work. The canonical home is `@kindoo/shared`;
// the renderer in apps/web pulls it from there too.
export { BOOKKEEPING_FIELDS };

/**
 * Return the set of top-level keys whose values changed between
 * `before` and `after`, EXCLUDING `BOOKKEEPING_FIELDS`. A missing key
 * on either side counts as a change. Map / array values are compared
 * by recursive deep equality (object key order is irrelevant; array
 * order is significant).
 */
export function changedKeys(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  const b = before ?? {};
  const a = after ?? {};
  const keys = new Set<string>([...Object.keys(b), ...Object.keys(a)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (BOOKKEEPING_FIELDS.has(k)) continue;
    if (!deepEqual(b[k], a[k])) changed.push(k);
  }
  return changed;
}

/**
 * `true` iff a write's only material change is in bookkeeping fields
 * (or there's no change at all). The trigger uses this as the no-op
 * gate — a `true` return means "don't write an audit row."
 *
 * Special case: a true create (`before == null`) or true delete
 * (`after == null`) is never a no-op even if all the non-bookkeeping
 * fields happen to be empty, because the existence transition itself
 * is the change.
 */
export function isNoOpUpdate(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): boolean {
  if (!before || !after) return false;
  return changedKeys(before, after).length === 0;
}

export function deepEqual(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  // Treat `undefined` and a missing key as equal — matches how
  // `changedKeys` unions Object.keys(before) ∪ Object.keys(after).
  if (x === undefined || y === undefined) return x === y;
  if (x === null || y === null) return false;
  if (typeof x !== 'object' || typeof y !== 'object') return false;
  const xArr = Array.isArray(x);
  const yArr = Array.isArray(y);
  if (xArr !== yArr) return false;
  if (xArr && yArr) {
    const a = x as unknown[];
    const b = y as unknown[];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const xo = x as Record<string, unknown>;
  const yo = y as Record<string, unknown>;
  const keys = new Set<string>([...Object.keys(xo), ...Object.keys(yo)]);
  for (const k of keys) {
    if (!deepEqual(xo[k], yo[k])) return false;
  }
  return true;
}
