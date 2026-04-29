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
import type { AuditLog } from '@kindoo/shared';
import { useAuditLogPage, PAGE_SIZE, type AuditLogFilters } from './hooks';
import { auditActionCategory, summariseAuditRow } from './summarise';
import type { BadgeVariant } from '../../../components/ui/Badge';
import { AuditDiffTable } from './AuditDiffTable';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { EmptyState } from '../../../lib/render/EmptyState';

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
            <AuditCard key={row.audit_id} row={row} />
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
          placeholder="exact match"
        />
      </label>
      <label>
        Actor (canonical)
        <Input
          type="text"
          value={draft.actor_canonical ?? ''}
          onChange={(e) => update({ actor_canonical: e.target.value || undefined })}
          placeholder="canonical email or 'Importer'"
        />
      </label>
      <label>
        Member (canonical)
        <Input
          type="text"
          value={draft.member_canonical ?? ''}
          onChange={(e) => update({ member_canonical: e.target.value || undefined })}
          placeholder="canonical email"
        />
      </label>
      <Button onClick={() => onApply(draft)}>Apply</Button>
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
}

function AuditCard({ row }: AuditCardProps) {
  const summary = summariseAuditRow(row);
  const ts = row.timestamp as unknown as { toDate?: () => Date };
  const tsString = ts.toDate ? ts.toDate().toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '';
  const automated = row.actor_email === 'Importer' || row.actor_email === 'ExpiryTrigger';

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
          {row.entity_id ? <span> {row.entity_id}</span> : null}
        </span>
        <span className="kd-audit-card-summary">{summary}</span>
      </div>
      <details className="kd-audit-card-diff">
        <summary>details</summary>
        <AuditDiffTable before={row.before} after={row.after} />
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

function stripEmpty(filters: AuditLogFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v) out[k] = v;
  }
  return out;
}
