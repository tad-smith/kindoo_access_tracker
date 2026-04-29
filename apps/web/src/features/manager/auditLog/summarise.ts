// One-line summary of an audit row, ported from
// `src/ui/manager/AuditLog.html`'s `shortSummary()`. Used both on the
// Audit Log page (collapsed row) and on the Dashboard's Recent Activity
// card.
//
// Special cases for the rows whose surface form is more readable as
// custom prose than as a key/value dump:
//   - complete_request with a completion_note (the R-1 race) surfaces
//     the note directly so a manager can spot the no-op at a glance.
//   - import_end summarises the inserted/deleted/updated counts.
//   - over_cap_warning lists the affected pools.
//
// Generic fallback: insert / delete / update against the before+after
// payloads.

import type { AuditLog } from '@kindoo/shared';
import { BOOKKEEPING_FIELDS } from '@kindoo/shared';

export function summariseAuditRow(row: AuditLog): string {
  const { action, before, after } = row;
  if (
    action === 'complete_request' &&
    after &&
    typeof after === 'object' &&
    'completion_note' in after &&
    typeof (after as Record<string, unknown>).completion_note === 'string'
  ) {
    return `Completed with note: "${(after as Record<string, unknown>).completion_note}"`;
  }
  if (action === 'over_cap_warning' && after && typeof after === 'object' && 'pools' in after) {
    const pools = (after as { pools?: Array<{ pool: string; count: number; cap: number }> }).pools;
    if (Array.isArray(pools)) {
      const labels = pools.map((p) => `${p.pool} (${p.count}/${p.cap})`);
      return `${pools.length} pool${pools.length === 1 ? '' : 's'} over: ${labels.join(', ')}`;
    }
  }
  if (action === 'import_end' && after && typeof after === 'object') {
    const o = after as Record<string, unknown>;
    const bits: string[] = [];
    if (typeof o.inserted === 'number') bits.push(`${o.inserted} ins`);
    if (typeof o.deleted === 'number') bits.push(`${o.deleted} del`);
    if (typeof o.updated_names === 'number') bits.push(`${o.updated_names} name upd`);
    if (typeof o.access_added === 'number') bits.push(`${o.access_added} access+`);
    if (typeof o.access_removed === 'number') bits.push(`${o.access_removed} access-`);
    if (typeof o.elapsed_ms === 'number') bits.push(`${o.elapsed_ms}ms`);
    if (typeof o.error === 'string' && o.error) bits.push(`ERROR: ${o.error}`);
    if (bits.length > 0) return bits.join(', ');
  }
  if (action === 'auto_expire' && before && typeof before === 'object') {
    const b = before as Record<string, unknown>;
    const who = (b.member_name as string) || (b.member_email as string) || '(unknown)';
    const end = b.end_date ? ` (end ${b.end_date as string})` : '';
    return `expired temp seat for ${who}${end}`;
  }
  if (before == null && after && typeof after === 'object') {
    return `insert: ${topKeysSummary(after as Record<string, unknown>)}`;
  }
  if (before && before !== null && typeof before === 'object' && after == null) {
    return `delete: ${topKeysSummary(before as Record<string, unknown>)}`;
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const changed = diffKeys(before as Record<string, unknown>, after as Record<string, unknown>);
    if (changed.length === 0) return '(no field changes)';
    return `changed: ${changed.join(', ')}`;
  }
  return '';
}

function topKeysSummary(obj: Record<string, unknown>): string {
  const prefs = [
    'member_name',
    'member_email',
    'email',
    'building_name',
    'ward_code',
    'calling_name',
    'scope',
  ];
  const seen = new Set<string>();
  const bits: string[] = [];
  for (const k of prefs) {
    if (bits.length >= 3) break;
    const v = obj[k];
    if (v != null && v !== '') {
      bits.push(`${k}=${stringifyValue(v)}`);
      seen.add(k);
    }
  }
  for (const k of Object.keys(obj)) {
    if (bits.length >= 3) break;
    if (seen.has(k)) continue;
    bits.push(`${k}=${stringifyValue(obj[k])}`);
  }
  return bits.join(', ');
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'object') return JSON.stringify(v);
  let s = String(v);
  if (s.length > 80) s = `${s.substring(0, 77)}…`;
  return s;
}

/** Top-level keys whose values differ. JSON-string-equality compare.
 *  Bookkeeping fields (lastActor, last_modified_*, *_at, *_by) are
 *  filtered — they shouldn't surface in the user-visible inline
 *  summary even when they did technically change. */
export function diffKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (BOOKKEEPING_FIELDS.has(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
  }
  return changed;
}

/** A single row in the field-by-field diff table. `kind` controls how
 *  the renderer styles the row: `change` shows both columns, `add`
 *  shows only after (insert path), `remove` shows only before (delete
 *  path). `before` / `after` are raw — formatting happens in the
 *  renderer. */
export interface FieldDiffRow {
  field: string;
  kind: 'change' | 'add' | 'remove';
  before: unknown;
  after: unknown;
}

export interface FieldDiffResult {
  /** Action shape: 'create' has no `before`, 'delete' has no `after',
   *  'update' has both. Drives the table header in the renderer. */
  shape: 'create' | 'update' | 'delete' | 'empty';
  rows: FieldDiffRow[];
  /** Count of fields present on either side that didn't change. Surfaced
   *  in the renderer trailer ("N unchanged fields not shown") so the
   *  reader knows the table isn't truncated. Always 0 for create/delete
   *  shapes (every field is, by definition, an add or a remove). */
  unchangedCount: number;
}

/** Walk `before` + `after`, return only the fields that differ. The
 *  shape ('create' | 'update' | 'delete' | 'empty') captures the
 *  before/after presence and lets the renderer pick a sensible header
 *  per audit action.
 *
 *  Bookkeeping fields (`lastActor`, `last_modified_*`, `*_at`, `*_by`
 *  per `BOOKKEEPING_FIELDS` in `@kindoo/shared`) are filtered out
 *  entirely — the operator's view of the diff shouldn't be muddied by
 *  audit-trigger plumbing. The values are still in the stored
 *  `before`/`after` snapshots; we just don't render them.
 *
 *  Cross-collection rows (member_canonical filter spans seats / access
 *  / requests) work transparently: every row's keys are computed from
 *  its own before+after, so heterogeneous shapes render side-by-side
 *  without any per-collection branching. */
export function computeFieldDiff(before: unknown, after: unknown): FieldDiffResult {
  const beforeObj = isPlainObject(before) ? before : null;
  const afterObj = isPlainObject(after) ? after : null;

  if (!beforeObj && !afterObj) return { shape: 'empty', rows: [], unchangedCount: 0 };

  if (!beforeObj && afterObj) {
    const rows: FieldDiffRow[] = Object.keys(afterObj)
      .filter((field) => !BOOKKEEPING_FIELDS.has(field))
      .sort()
      .map((field) => ({ field, kind: 'add', before: undefined, after: afterObj[field] }));
    return { shape: 'create', rows, unchangedCount: 0 };
  }
  if (beforeObj && !afterObj) {
    const rows: FieldDiffRow[] = Object.keys(beforeObj)
      .filter((field) => !BOOKKEEPING_FIELDS.has(field))
      .sort()
      .map((field) => ({ field, kind: 'remove', before: beforeObj[field], after: undefined }));
    return { shape: 'delete', rows, unchangedCount: 0 };
  }

  // Both sides present — compute the changed-keys set, build rows in a
  // stable sort order, count the unchanged fields for the trailer.
  // Bookkeeping fields are dropped entirely; they don't add to the
  // unchanged count either, since the trailer is already a hint that
  // "non-shown user fields exist", and surfacing bookkeeping noise
  // there would be confusing.
  const allKeys = new Set<string>([
    ...Object.keys(beforeObj!).filter((k) => !BOOKKEEPING_FIELDS.has(k)),
    ...Object.keys(afterObj!).filter((k) => !BOOKKEEPING_FIELDS.has(k)),
  ]);
  const rows: FieldDiffRow[] = [];
  let unchangedCount = 0;
  for (const field of [...allKeys].sort()) {
    const b = (beforeObj as Record<string, unknown>)[field];
    const a = (afterObj as Record<string, unknown>)[field];
    if (JSON.stringify(b) === JSON.stringify(a)) {
      unchangedCount += 1;
      continue;
    }
    const inBefore = field in beforeObj!;
    const inAfter = field in afterObj!;
    const kind: FieldDiffRow['kind'] = !inBefore ? 'add' : !inAfter ? 'remove' : 'change';
    rows.push({ field, kind, before: b, after: a });
  }
  return { shape: 'update', rows, unchangedCount };
}

/** Render an arbitrary value into the diff cell text. Mirrors the Apps
 *  Script `stringifyValue_`: nulls render as `(empty)` instead of the
 *  literal `""`, timestamps render in human-readable form, primitives
 *  cap at 200 chars (Apps Script capped at 80 — bumped because the diff
 *  table cell is wider than the inline summary), arrays / maps render
 *  as compact JSON. */
export function formatDiffValue(v: unknown): string {
  if (v === undefined) return '(absent)';
  if (v === null || v === '') return '(empty)';
  if (typeof v === 'string') {
    // ISO-ish timestamp string: drop ms + "T" / "Z" for readability.
    const isoMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/.exec(v);
    if (isoMatch) return `${isoMatch[1]} ${isoMatch[2]} UTC`;
    return v.length > 200 ? `${v.substring(0, 197)}…` : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isFirestoreTimestamp(v)) {
    return v.toDate().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '(empty list)';
    // Comma-separated for primitive arrays; JSON for nested.
    if (v.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) {
      return v.join(', ');
    }
    return JSON.stringify(v);
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return '(empty map)';
    return JSON.stringify(v);
  }
  return String(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFirestoreTimestamp(v: unknown): v is { toDate: () => Date } {
  return (
    v !== null &&
    typeof v === 'object' &&
    'toDate' in v &&
    typeof (v as { toDate: unknown }).toDate === 'function'
  );
}

/** Audit-action category. Drives the row-card action-badge color so
 *  CRUD, request-lifecycle, system-events, and importer rows are
 *  visually distinguishable at a glance. Mirrors Apps Script's
 *  `ACTION_CATEGORY` map in `src/ui/manager/AuditLog.html`.
 *
 *  - `crud`    — create_*, update_*, delete_* on entity docs
 *  - `request` — submit / complete / reject / cancel request
 *  - `system`  — auto_expire, over_cap_warning, setup_complete, ...
 *  - `import`  — import_start, import_end
 *  - `default` — fallback (unknown action; renders neutral grey)
 */
export type AuditActionCategory = 'crud' | 'request' | 'system' | 'import' | 'default';

export function auditActionCategory(action: AuditLog['action']): AuditActionCategory {
  if (action.startsWith('create_') || action.startsWith('update_') || action.startsWith('delete_'))
    return 'crud';
  // `submit_request` / `complete_request` / `reject_request` /
  // `cancel_request` / future `*_request` lifecycle events.
  if (action.endsWith('_request')) return 'request';
  if (action.startsWith('import_')) return 'import';
  if (action === 'auto_expire' || action === 'over_cap_warning' || action === 'setup_complete')
    return 'system';
  return 'default';
}
