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
// `building_codes`, `callings`, `duplicate_grants` are compared by
// JSON-stringified equality — shallow at the top level, deep within
// the field. Good enough for human-scale audit reads at this scale;
// avoids pulling in a deep-equal library.
//
// Note on key ordering: `JSON.stringify` is order-sensitive, but
// Firestore's normalised reads return object keys in insertion order
// per the SDK. For our doc shapes that come from a single source
// (the SPA / importer), that's stable enough; a key-reordering write
// is rare and at worst produces a redundant audit row, which is the
// safer failure mode.

/** Fields the diff treats as bookkeeping — never trigger audit emission. */
export const BOOKKEEPING_FIELDS = new Set<string>([
  'lastActor',
  'last_modified_at',
  'last_modified_by',
  'created_at',
  'added_at',
  'granted_at',
  'detected_at',
  'updated_at',
]);

/**
 * Return the set of top-level keys whose values changed between
 * `before` and `after`, EXCLUDING `BOOKKEEPING_FIELDS`. A missing key
 * on either side counts as a change. Map / array values are compared
 * via `JSON.stringify`.
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

function deepEqual(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (x === null || y === null) return false;
  if (typeof x !== 'object' || typeof y !== 'object') return false;
  // Cheap structural compare via JSON. Sufficient for the shapes we
  // store; doesn't handle Firestore Timestamps specially because
  // bookkeeping timestamps are filtered out before this is reached
  // and any non-bookkeeping timestamp difference is real.
  return JSON.stringify(x) === JSON.stringify(y);
}
