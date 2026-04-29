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

/** Top-level keys whose values differ. JSON-string-equality compare. */
export function diffKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
  }
  return changed;
}
