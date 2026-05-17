// One-line summary of an audit row. Used on both the Audit Log page
// (collapsed row) and the Dashboard's Recent Activity card.
//
// Special cases for the rows whose surface form is more readable as
// custom prose than as a key/value dump:
//   - complete_request with a typed `completion_status` discriminator
//     (R-1 race or T-43 grant-shifted race) renders a case-specific
//     prefix so a manager can spot the no-op kind at a glance. Pre-
//     T-43 rows with only `completion_note` (no discriminator) fall
//     back to the generic "Completed with note" surface.
//   - import_end summarises the inserted/deleted/updated counts.
//   - over_cap_warning lists the affected pools.
//
// Generic fallback: insert / delete / update against the before+after
// payloads.

import type { AuditLog, CompletionStatus } from '@kindoo/shared';
import { BOOKKEEPING_FIELDS } from '@kindoo/shared';
import { formatDateTimeInStakeTz } from '../../../lib/datetime';

function completionStatusLabel(status: CompletionStatus): string {
  if (status === 'noop_already_removed') return 'No-op (seat already removed)';
  if (status === 'noop_grant_shifted') return 'No-op (grant moved before completion)';
  // Exhaustive on the union; fall-through preserves compile-time
  // safety if a future CompletionStatus value is added.
  return status;
}

export function summariseAuditRow(row: AuditLog): string {
  const { action, before, after } = row;
  if (action === 'complete_request' && after && typeof after === 'object') {
    const a = after as Record<string, unknown>;
    const note = typeof a.completion_note === 'string' ? a.completion_note : null;
    const status =
      a.completion_status === 'noop_already_removed' || a.completion_status === 'noop_grant_shifted'
        ? (a.completion_status as CompletionStatus)
        : null;
    if (status !== null) {
      const label = completionStatusLabel(status);
      return note ? `${label}: "${note}"` : label;
    }
    if (note !== null) {
      return `Completed with note: "${note}"`;
    }
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

// Canonical-email fields are plumbing, not user-facing. Skip them in
// the inline summary too — the typed `member_email` / `actor_email`
// already cover the user-display need.
const SUMMARY_HIDDEN_KEYS = new Set([
  'member_canonical',
  'actor_canonical',
  'requester_canonical',
  'completer_canonical',
]);

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
    if (SUMMARY_HIDDEN_KEYS.has(k)) continue;
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

/** Fields whose values are `{ [scope]: <something> }` maps where each
 *  scope-key carries useful diff signal (per-scope add/remove). For
 *  these, `computeFieldDiff` flattens to one row per scope-key (e.g.
 *  `manual_grants[CO]`, `manual_grants[stake]`) instead of dumping the
 *  whole map as a single JSON cell. Listed by name so unknown nested
 *  maps still render compactly (the field-by-field design is for
 *  human-scale shapes; arbitrary deep nesting goes back to JSON).
 *
 *  See `firebase-schema.md` §4.5 (Access doc) for the source data
 *  model — `manual_grants` and `importer_callings` are the two
 *  maps we want to flatten. */
const FLATTENED_MAP_FIELDS = new Set(['manual_grants', 'importer_callings']);

/** Canonical-email fields stripped from the diff table — the typed
 *  email field rendered alongside is the user-readable form. The
 *  canonical version is plumbing that surfaces only inside the rule
 *  comparison; surfacing it in the UI conflates "the user" with "the
 *  doc id" and makes screenshots leak data the user expects to be
 *  hidden behind their typed email. */
const HIDDEN_CANONICAL_FIELDS = new Set([
  'member_canonical',
  'actor_canonical',
  'requester_canonical',
  'completer_canonical',
]);

function isHiddenField(field: string): boolean {
  if (BOOKKEEPING_FIELDS.has(field)) return true;
  if (HIDDEN_CANONICAL_FIELDS.has(field)) return true;
  return false;
}

/** Expand a `field` whose value is a map-of-scopes into per-scope rows.
 *  Each row's `field` becomes `parent[scope]`; before/after carry the
 *  per-scope value. Empty / unchanged scopes collapse into the
 *  unchanged-count tally rather than rendering their own row. */
function flattenMapField(
  parentField: string,
  beforeMap: Record<string, unknown> | undefined,
  afterMap: Record<string, unknown> | undefined,
): { rows: FieldDiffRow[]; unchangedCount: number } {
  const b = beforeMap ?? {};
  const a = afterMap ?? {};
  const keys = new Set<string>([...Object.keys(b), ...Object.keys(a)]);
  const rows: FieldDiffRow[] = [];
  let unchangedCount = 0;
  for (const key of [...keys].sort()) {
    const bv = b[key];
    const av = a[key];
    if (JSON.stringify(bv) === JSON.stringify(av)) {
      unchangedCount += 1;
      continue;
    }
    const inBefore = key in b;
    const inAfter = key in a;
    const kind: FieldDiffRow['kind'] = !inBefore ? 'add' : !inAfter ? 'remove' : 'change';
    rows.push({ field: `${parentField}[${key}]`, kind, before: bv, after: av });
  }
  return { rows, unchangedCount };
}

/** Walk `before` + `after`, return only the fields that differ. The
 *  shape ('create' | 'update' | 'delete' | 'empty') captures the
 *  before/after presence and lets the renderer pick a sensible header
 *  per audit action.
 *
 *  Bookkeeping fields (`lastActor`, `last_modified_*`, `*_at`, `*_by`
 *  per `BOOKKEEPING_FIELDS` in `@kindoo/shared`) plus
 *  `*_canonical` fields are filtered out entirely — neither belongs in
 *  the user-visible diff (one is plumbing, the other duplicates the
 *  typed email).
 *
 *  Map-valued fields listed in `FLATTENED_MAP_FIELDS` (e.g.
 *  `manual_grants`) flatten to per-scope rows.
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
    const rows: FieldDiffRow[] = [];
    for (const field of Object.keys(afterObj)
      .filter((f) => !isHiddenField(f))
      .sort()) {
      const value = afterObj[field];
      if (FLATTENED_MAP_FIELDS.has(field) && isPlainObject(value)) {
        const flat = flattenMapField(field, undefined, value);
        rows.push(...flat.rows);
        continue;
      }
      rows.push({ field, kind: 'add', before: undefined, after: value });
    }
    return { shape: 'create', rows, unchangedCount: 0 };
  }
  if (beforeObj && !afterObj) {
    const rows: FieldDiffRow[] = [];
    for (const field of Object.keys(beforeObj)
      .filter((f) => !isHiddenField(f))
      .sort()) {
      const value = beforeObj[field];
      if (FLATTENED_MAP_FIELDS.has(field) && isPlainObject(value)) {
        const flat = flattenMapField(field, value, undefined);
        rows.push(...flat.rows);
        continue;
      }
      rows.push({ field, kind: 'remove', before: value, after: undefined });
    }
    return { shape: 'delete', rows, unchangedCount: 0 };
  }

  // Both sides present — compute the changed-keys set, build rows in a
  // stable sort order, count the unchanged fields for the trailer.
  // Bookkeeping + canonical-email fields are dropped entirely.
  const allKeys = new Set<string>([
    ...Object.keys(beforeObj!).filter((k) => !isHiddenField(k)),
    ...Object.keys(afterObj!).filter((k) => !isHiddenField(k)),
  ]);
  const rows: FieldDiffRow[] = [];
  let unchangedCount = 0;
  for (const field of [...allKeys].sort()) {
    const b = (beforeObj as Record<string, unknown>)[field];
    const a = (afterObj as Record<string, unknown>)[field];
    if (FLATTENED_MAP_FIELDS.has(field)) {
      const flat = flattenMapField(
        field,
        isPlainObject(b) ? b : undefined,
        isPlainObject(a) ? a : undefined,
      );
      rows.push(...flat.rows);
      unchangedCount += flat.unchangedCount;
      continue;
    }
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
 *  cap at 200 chars, arrays render as comma-separated for primitives
 *  or as readable per-item summaries for known shapes (manual grants,
 *  actor refs).
 *
 *  Pass `timezone` (e.g. `stake.timezone`) to render any embedded
 *  Firestore Timestamps in stake-local form. Omitting it falls back to
 *  the `formatDateTimeInStakeTz` default (`America/Denver`). */
export function formatDiffValue(v: unknown, timezone?: string): string {
  if (v === undefined) return '(absent)';
  if (v === null || v === '') return '(empty)';
  if (typeof v === 'string') {
    // ISO-ish timestamp string: re-render in stake-local time.
    const isoMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/.exec(v);
    if (isoMatch) return formatDateTimeInStakeTz(new Date(v), timezone);
    return v.length > 200 ? `${v.substring(0, 197)}…` : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Firestore Timestamp variants: SDK objects (with toDate) and
  // already-serialised envelopes (`{ type: 'firestore/timestamp/1.0',
  // seconds, nanoseconds }`) that surface in audit-trigger payloads.
  const date = coerceTimestampLike(v);
  if (date) return formatDateTimeInStakeTz(date, timezone);
  if (Array.isArray(v)) {
    if (v.length === 0) return '(empty list)';
    if (v.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) {
      return v.join(', ');
    }
    if (v.every(isManualGrantLike)) {
      return v.map((g) => formatManualGrant(g, timezone)).join('; ');
    }
    // Heterogeneous / unknown shape — summarise each entry recursively.
    return v.map((x) => formatDiffValue(x, timezone)).join('; ');
  }
  if (typeof v === 'object') {
    if (isActorRef(v)) return formatActorRef(v);
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return '(empty map)';
    // Render `key=value` pairs, recursively formatting each value, with
    // canonical-email + bookkeeping keys stripped so the surface stays
    // user-readable. The flat fallback isn't ideal for deeply-nested
    // shapes but at our data scale the only nested map shapes that
    // surface are well-modelled (grants, actor refs, callings) and
    // covered above.
    const bits = entries
      .filter(([k]) => !isHiddenField(k))
      .map(([k, val]) => `${k}=${formatDiffValue(val, timezone)}`);
    return bits.join(', ');
  }
  return String(v);
}

/** Render a single `ManualGrant` row. Strips the `canonical` half of
 *  `granted_by` and renders `granted_at` in stake-local time. */
function formatManualGrant(grant: unknown, timezone?: string): string {
  if (!grant || typeof grant !== 'object') return '';
  const g = grant as Record<string, unknown>;
  const reason = typeof g.reason === 'string' ? g.reason : '';
  const grantedBy = isActorRef(g.granted_by) ? (g.granted_by as { email: string }).email : '';
  const grantedAtDate = coerceTimestampLike(g.granted_at);
  const grantedAt = grantedAtDate ? formatDateTimeInStakeTz(grantedAtDate, timezone) : '';
  const bits: string[] = [];
  if (reason) bits.push(reason);
  if (grantedBy) bits.push(`by ${grantedBy}`);
  if (grantedAt) bits.push(`at ${grantedAt}`);
  return bits.join(' · ');
}

function isManualGrantLike(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const g = v as Record<string, unknown>;
  // grant_id is the unique fingerprint; reason and granted_by are
  // present on every real grant.
  return typeof g.grant_id === 'string' && typeof g.reason === 'string';
}

function isActorRef(v: unknown): v is { email: string; canonical?: string } {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.email === 'string' && Object.keys(r).every((k) => k === 'email' || k === 'canonical')
  );
}

function formatActorRef(v: unknown): string {
  const r = v as { email: string };
  return r.email;
}

/** Coerce known timestamp-shaped values into a `Date`. Handles:
 *   - Firestore SDK Timestamp instances (`.toDate()` available)
 *   - Serialised envelopes like
 *     `{ type: 'firestore/timestamp/1.0', seconds, nanoseconds }`
 *     written by the audit trigger when it stores raw `before`/`after`
 *     payloads through Firestore's reference encoder.
 *   - Plain `{ seconds, nanoseconds }` shapes (TimestampLike). */
function coerceTimestampLike(v: unknown): Date | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown> & { toDate?: () => Date };
  if (typeof r.toDate === 'function') {
    try {
      return r.toDate();
    } catch {
      return null;
    }
  }
  if (typeof r.seconds === 'number') {
    const nanos = typeof r.nanoseconds === 'number' ? r.nanoseconds : 0;
    return new Date(r.seconds * 1000 + nanos / 1_000_000);
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Audit-action category. Drives the row-card action-badge color so
 *  CRUD, request-lifecycle, system-events, and importer rows are
 *  visually distinguishable at a glance.
 *
 *  - `crud`    — create_*, update_*, delete_* on entity docs
 *  - `request` — submit / complete / reject / cancel request
 *  - `system`  — auto_expire, over_cap_warning, setup_complete, ...
 *  - `import`  — import_start, import_end
 *  - `default` — fallback (unknown action; renders neutral grey)
 */
export type AuditActionCategory = 'crud' | 'request' | 'system' | 'import' | 'default';

export function auditActionCategory(action: AuditLog['action']): AuditActionCategory {
  // `reject_request` is destructive — surface it in red (system) so a
  // manager can spot rejections at a glance, distinct from successful
  // submit / complete / cancel rows that share the green-request hue.
  if (action === 'reject_request') return 'system';
  if (action.startsWith('create_') || action.startsWith('update_') || action.startsWith('delete_'))
    return 'crud';
  // `submit_request` / `complete_request` / `cancel_request` / future
  // `*_request` lifecycle events. `reject_request` is excluded above.
  if (action.endsWith('_request')) return 'request';
  if (action.startsWith('import_')) return 'import';
  if (action === 'auto_expire' || action === 'over_cap_warning' || action === 'setup_complete')
    return 'system';
  return 'default';
}
