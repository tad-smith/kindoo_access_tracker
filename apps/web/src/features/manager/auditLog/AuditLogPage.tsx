// Manager Audit Log page. Mirrors `src/ui/manager/AuditLog.html`.
// Cursor-paginated (request-response), filterable by action /
// entity_type / entity_id / actor_canonical / member_canonical / date
// range. Per-row collapsed summary + `<details>` field-by-field diff
// table (see `AuditDiffTable.tsx`). The `member_canonical` filter
// produces cross-collection rows; the diff table walks each row's
// before/after independently so heterogeneous shapes coexist.

import { useMemo, useState } from 'react';
import { Timestamp } from 'firebase/firestore';
import { useNavigate } from '@tanstack/react-router';
import { canonicalEmail } from '@kindoo/shared';
import type { AuditLog } from '@kindoo/shared';
import { useAuditLogPage, PAGE_SIZE, type AuditLogFilters } from './hooks';
import { useStakeDoc } from '../dashboard/hooks';
import { auditActionCategory, summariseAuditRow } from './summarise';
import type { BadgeVariant } from '../../../components/ui/Badge';
import { AuditDiffTable } from './AuditDiffTable';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { EmptyState } from '../../../lib/render/EmptyState';
import { formatDateTimeInStakeTz } from '../../../lib/datetime';

export interface AuditLogPageProps {
  initialFilters?: AuditLogFilters;
}

export function AuditLogPage({ initialFilters }: AuditLogPageProps) {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<AuditLogFilters>(initialFilters ?? {});
  // Stack of cursor timestamps — index 0 is the timestamp BEFORE the
  // first page (no cursor); pushing a new cursor pages forward; popping
  // pages back. The current page's cursor is `cursorStack[cursorStack.length - 1]`.
  const [cursorStack, setCursorStack] = useState<(Timestamp | null)[]>([null]);
  const cursor = cursorStack[cursorStack.length - 1] ?? null;

  const result = useAuditLogPage(filters, cursor);
  const rows = useMemo<readonly AuditLog[]>(() => result.data ?? [], [result.data]);
  const hasMore = rows.length === PAGE_SIZE;
  const stake = useStakeDoc();
  const tz = stake.data?.timezone;

  const onApply = (next: AuditLogFilters) => {
    setFilters(next);
    setCursorStack([null]);
    navigate({
      to: '/manager/audit',
      search: stripEmpty(next),
      replace: true,
    }).catch(() => {});
  };

  const onNext = () => {
    if (!hasMore) return;
    const last = rows[rows.length - 1];
    if (!last) return;
    const ts = last.timestamp as unknown as Timestamp;
    setCursorStack((prev) => [...prev, ts]);
  };

  const onPrev = () => {
    if (cursorStack.length <= 1) return;
    setCursorStack((prev) => prev.slice(0, -1));
  };

  const onReset = () => {
    setFilters({});
    setCursorStack([null]);
    navigate({ to: '/manager/audit', search: {}, replace: true }).catch(() => {});
  };

  return (
    <section>
      <h1>Audit Log</h1>
      <p className="kd-page-subtitle">
        Every state-changing action in the app, with who did it and what changed.
      </p>

      <FilterRow filters={filters} onApply={onApply} onReset={onReset} />

      <div className="kd-audit-pagination">
        <span data-testid="audit-page-counter">
          Page {cursorStack.length} · {rows.length} row{rows.length === 1 ? '' : 's'}
        </span>
        <Button variant="secondary" onClick={onPrev} disabled={cursorStack.length <= 1}>
          ← Prev
        </Button>
        <Button variant="secondary" onClick={onNext} disabled={!hasMore}>
          Next →
        </Button>
      </div>

      {result.isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState message="No audit rows match the current filters." />
      ) : (
        <div className="kd-audit-log-cards" data-testid="audit-log-cards">
          {rows.map((row) => (
            <AuditCard key={row.audit_id} row={row} timezone={tz} />
          ))}
        </div>
      )}
    </section>
  );
}

interface FilterRowProps {
  filters: AuditLogFilters;
  onApply: (filters: AuditLogFilters) => void;
  onReset: () => void;
}

function FilterRow({ filters, onApply, onReset }: FilterRowProps) {
  const [draft, setDraft] = useState<AuditLogFilters>(filters);
  const update = (patch: Partial<AuditLogFilters>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="kd-filter-row">
      <label>
        From
        <Input
          type="date"
          value={draft.date_from ?? ''}
          onChange={(e) => update({ date_from: e.target.value || undefined })}
        />
      </label>
      <label>
        To
        <Input
          type="date"
          value={draft.date_to ?? ''}
          onChange={(e) => update({ date_to: e.target.value || undefined })}
        />
      </label>
      <label>
        Action
        <Select
          value={draft.action ?? ''}
          onChange={(e) => update({ action: e.target.value || undefined })}
        >
          <option value="">Any</option>
          <option value="create_seat">create_seat</option>
          <option value="update_seat">update_seat</option>
          <option value="delete_seat">delete_seat</option>
          <option value="auto_expire">auto_expire</option>
          <option value="create_access">create_access</option>
          <option value="update_access">update_access</option>
          <option value="delete_access">delete_access</option>
          <option value="submit_request">submit_request</option>
          <option value="complete_request">complete_request</option>
          <option value="reject_request">reject_request</option>
          <option value="cancel_request">cancel_request</option>
          <option value="import_start">import_start</option>
          <option value="import_end">import_end</option>
          <option value="over_cap_warning">over_cap_warning</option>
        </Select>
      </label>
      <label>
        Entity type
        <Select
          value={draft.entity_type ?? ''}
          onChange={(e) => update({ entity_type: e.target.value || undefined })}
        >
          <option value="">Any</option>
          <option value="seat">seat</option>
          <option value="request">request</option>
          <option value="access">access</option>
          <option value="kindooManager">kindooManager</option>
          <option value="stake">stake</option>
          <option value="system">system</option>
        </Select>
      </label>
      <label>
        Entity id
        <Input
          type="text"
          value={draft.entity_id ?? ''}
          onChange={(e) => update({ entity_id: e.target.value || undefined })}
          placeholder="ID or email"
        />
      </label>
      <label>
        Actor
        <Input
          type="text"
          value={draft.actor_canonical ?? ''}
          onChange={(e) => update({ actor_canonical: e.target.value || undefined })}
          placeholder="email or 'Importer'"
        />
      </label>
      <label>
        Member
        <Input
          type="text"
          value={draft.member_canonical ?? ''}
          onChange={(e) => update({ member_canonical: e.target.value || undefined })}
          placeholder="email"
        />
      </label>
      <Button onClick={() => onApply(canonicalizeFilters(draft))}>Apply</Button>
      <Button
        variant="secondary"
        onClick={() => {
          setDraft({});
          onReset();
        }}
      >
        Reset
      </Button>
    </div>
  );
}

interface AuditCardProps {
  row: AuditLog;
  timezone: string | undefined;
}

function AuditCard({ row, timezone }: AuditCardProps) {
  const summary = summariseAuditRow(row);
  // Stake-timezone formatting per spec.md §13: `YYYY-MM-DD h:mm am/pm`.
  const tsString = formatDateTimeInStakeTz(row.timestamp, timezone);
  const automated = row.actor_email === 'Importer' || row.actor_email === 'ExpiryTrigger';
  // Hide bare canonical-email entity ids in the compact row — surface
  // the typed `member_email` from before/after when available so the
  // user sees the same display form they typed in. Canonical-keyed
  // entity types: seat, access, kindooManager. Other types (request /
  // stake) keep entity_id as-is.
  const entityIdDisplay = displayEntityId(row);

  return (
    <div className="kd-audit-card" data-testid={`audit-row-${row.audit_id}`}>
      <div className="kd-audit-card-row">
        <span className="kd-audit-card-ts">{tsString}</span>
        <span className={automated ? 'kd-audit-card-actor actor-automated' : 'kd-audit-card-actor'}>
          {row.actor_email}
        </span>
        <Badge variant={badgeVariantForAction(row.action)}>{row.action}</Badge>
        <span>
          <code>{row.entity_type}</code>
          {entityIdDisplay ? <span> {entityIdDisplay}</span> : null}
        </span>
        <span className="kd-audit-card-summary">{summary}</span>
      </div>
      <details className="kd-audit-card-diff">
        <summary>details</summary>
        <AuditDiffTable before={row.before} after={row.after} {...(timezone ? { timezone } : {})} />
      </details>
    </div>
  );
}

/** Map an audit-action category onto the Badge variant that renders
 *  the matching Apps Script color: blue for CRUD, green for request
 *  lifecycle, red for system, amber for importer. */
function badgeVariantForAction(action: AuditLog['action']): BadgeVariant {
  switch (auditActionCategory(action)) {
    case 'crud':
      return 'audit-crud';
    case 'request':
      return 'audit-request';
    case 'system':
      return 'audit-system';
    case 'import':
      return 'audit-import';
    default:
      return 'default';
  }
}

/** For canonical-keyed entities (seat / access / kindooManager) the
 *  `entity_id` is a canonical email. Surface the typed `member_email`
 *  from the before/after payload so the row display doesn't leak the
 *  canonical form. For non-canonical-keyed entities (request / stake)
 *  return entity_id as-is. */
function displayEntityId(row: AuditLog): string {
  const id = row.entity_id ?? '';
  const canonicalKeyed =
    row.entity_type === 'seat' ||
    row.entity_type === 'access' ||
    row.entity_type === 'kindooManager';
  if (!canonicalKeyed) return id;
  const typed = pickMemberEmail(row.after) ?? pickMemberEmail(row.before);
  return typed ?? id;
}

function pickMemberEmail(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.member_email === 'string' && obj.member_email) return obj.member_email;
  return null;
}

/** Convert user-typed actor / member emails to canonical form for the
 *  Firestore query. Literal automated actors (`Importer`,
 *  `ExpiryTrigger`) pass through unchanged because they're not real
 *  emails. The entity_id field is left unchanged here — the hook
 *  fans out to a typed-OR-canonical match in the worst case (see
 *  `useAuditLogPage`'s entity_id branch). */
function canonicalizeFilters(filters: AuditLogFilters): AuditLogFilters {
  const out: AuditLogFilters = { ...filters };
  if (out.actor_canonical) {
    const trimmed = out.actor_canonical.trim();
    out.actor_canonical = isAutomatedActor(trimmed) ? trimmed : canonicalEmail(trimmed);
  }
  if (out.member_canonical) {
    out.member_canonical = canonicalEmail(out.member_canonical.trim());
  }
  if (out.entity_id) {
    const trimmed = out.entity_id.trim();
    // For email-shaped entity ids, normalise to canonical form because
    // seat / access / kindooManager doc ids are always canonical. The
    // hook's query treats the value as exact-match either way; this
    // just lets the user type the displayed (typed) form.
    out.entity_id = trimmed.includes('@') ? canonicalEmail(trimmed) : trimmed;
  }
  return out;
}

function isAutomatedActor(s: string): boolean {
  return s === 'Importer' || s === 'ExpiryTrigger';
}

function stripEmpty(filters: AuditLogFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v) out[k] = v;
  }
  return out;
}
