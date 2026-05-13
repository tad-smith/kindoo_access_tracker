// Sync drift report panel. Phase 1 of the Sync feature — read-only.
//
// State machine: idle → loading → report | error.
//
// On "Run Sync" the panel fires two reads in parallel:
//   - getSyncData() (SW → Firestore) — all SBA collections needed for drift.
//   - listAllEnvironmentUsers() (CS → Kindoo) — every Kindoo env-user, paginated.
//
// Once both resolve, `detect()` (in content/kindoo/sync/detector.ts)
// classifies divergence into one Discrepancy row per email and the
// panel renders the report. Filter chips narrow to drift-only / review-
// only. No fix actions — Phase 2.
//
// Design doc: `extension/docs/sync-design.md`.

import { useCallback, useMemo, useState } from 'react';
import { ExtensionApiError, getSyncData } from '../lib/extensionApi';
import { readKindooSession, type KindooSessionError } from '../content/kindoo/auth';
import { listAllEnvironmentUsers } from '../content/kindoo/endpoints';
import { KindooApiError } from '../content/kindoo/client';
import {
  detect,
  type Discrepancy,
  type DetectResult,
  type Severity,
} from '../content/kindoo/sync/detector';

interface SyncPanelProps {
  email: string | null | undefined;
  /** Called when the operator clicks "Back to Queue". */
  onBack: () => void;
}

type Step =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'report'; result: DetectResult }
  | { kind: 'error'; message: string }
  | { kind: 'no-kindoo'; error: KindooSessionError };

type FilterMode = 'all' | 'drift' | 'review';

function describeExtensionError(err: unknown): string {
  if (err instanceof ExtensionApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function describeKindooError(err: unknown): string {
  if (err instanceof KindooApiError) return `Kindoo API (${err.code}): ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function SyncPanel({ email, onBack }: SyncPanelProps) {
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [filter, setFilter] = useState<FilterMode>('all');

  const runSync = useCallback(async () => {
    setStep({ kind: 'loading' });

    const sessionResult = readKindooSession();
    if (!sessionResult.ok) {
      setStep({ kind: 'no-kindoo', error: sessionResult.error });
      return;
    }
    const session = sessionResult.session;

    try {
      const [bundle, kindooUsers] = await Promise.all([
        getSyncData(),
        listAllEnvironmentUsers(session),
      ]);
      const result = detect({ ...bundle, kindooUsers });
      setStep({ kind: 'report', result });
    } catch (err) {
      const message =
        err instanceof KindooApiError ? describeKindooError(err) : describeExtensionError(err);
      setStep({ kind: 'error', message });
    }
  }, []);

  return (
    <main className="sba-panel" data-testid="sba-sync">
      <header className="sba-header">
        <div>
          <h1>Sync</h1>
          {email ? <div className="sba-header-meta">{email}</div> : null}
        </div>
        <button type="button" className="sba-btn" onClick={onBack} data-testid="sba-sync-back">
          Back to Queue
        </button>
      </header>
      <div className="sba-body">
        <SyncBody step={step} filter={filter} onRun={() => void runSync()} onFilter={setFilter} />
      </div>
    </main>
  );
}

interface BodyProps {
  step: Step;
  filter: FilterMode;
  onRun: () => void;
  onFilter: (f: FilterMode) => void;
}

function SyncBody({ step, filter, onRun, onFilter }: BodyProps) {
  if (step.kind === 'idle') {
    return (
      <div data-testid="sba-sync-idle">
        <p>
          Compares SBA seats with Kindoo users and reports drift. Read-only — no changes are made.
        </p>
        <button
          type="button"
          className="sba-btn sba-btn-primary"
          onClick={onRun}
          data-testid="sba-sync-run"
        >
          Run Sync
        </button>
      </div>
    );
  }
  if (step.kind === 'loading') {
    return (
      <p className="sba-muted" data-testid="sba-sync-loading">
        Reading SBA + Kindoo…
      </p>
    );
  }
  if (step.kind === 'no-kindoo') {
    return (
      <div data-testid="sba-sync-no-kindoo">
        <p className="sba-error">
          {step.error === 'no-token'
            ? 'Sign into Kindoo first.'
            : 'Kindoo session not ready. Refresh web.kindoo.tech and retry.'}
        </p>
        <button type="button" className="sba-btn" onClick={onRun}>
          Retry
        </button>
      </div>
    );
  }
  if (step.kind === 'error') {
    return (
      <div data-testid="sba-sync-error">
        <p className="sba-error">Sync failed: {step.message}</p>
        <button type="button" className="sba-btn" onClick={onRun} data-testid="sba-sync-retry">
          Retry
        </button>
      </div>
    );
  }
  return <ReportView result={step.result} filter={filter} onFilter={onFilter} />;
}

interface ReportProps {
  result: DetectResult;
  filter: FilterMode;
  onFilter: (f: FilterMode) => void;
}

function ReportView({ result, filter, onFilter }: ReportProps) {
  const driftCount = useMemo(
    () => result.discrepancies.filter((d) => d.severity === 'drift').length,
    [result.discrepancies],
  );
  const reviewCount = useMemo(
    () => result.discrepancies.filter((d) => d.severity === 'review').length,
    [result.discrepancies],
  );
  const filtered = useMemo(() => {
    if (filter === 'all') return result.discrepancies;
    return result.discrepancies.filter((d) =>
      filter === 'drift' ? d.severity === 'drift' : d.severity === 'review',
    );
  }, [filter, result.discrepancies]);

  return (
    <div data-testid="sba-sync-report">
      <p className="sba-sync-summary" data-testid="sba-sync-summary">
        Found <strong>{driftCount}</strong> drift item{driftCount === 1 ? '' : 's'},{' '}
        <strong>{reviewCount}</strong> need review. SBA: <strong>{result.seatCount}</strong> seats.
        Kindoo: <strong>{result.kindooCount}</strong> users.
      </p>
      <div className="sba-sync-filters" role="group" aria-label="Filter discrepancies">
        <FilterChip current={filter} value="all" label="All" onFilter={onFilter} />
        <FilterChip current={filter} value="drift" label="Drift only" onFilter={onFilter} />
        <FilterChip current={filter} value="review" label="Review only" onFilter={onFilter} />
      </div>
      {filtered.length === 0 ? (
        <p className="sba-empty" data-testid="sba-sync-empty">
          No discrepancies to show.
        </p>
      ) : (
        <ul className="sba-sync-list" data-testid="sba-sync-list">
          {filtered.map((d) => (
            <li key={d.canonical}>
              <DiscrepancyRow discrepancy={d} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface FilterChipProps {
  current: FilterMode;
  value: FilterMode;
  label: string;
  onFilter: (f: FilterMode) => void;
}

function FilterChip({ current, value, label, onFilter }: FilterChipProps) {
  const active = current === value;
  return (
    <button
      type="button"
      className={active ? 'sba-chip sba-chip-active' : 'sba-chip'}
      onClick={() => onFilter(value)}
      aria-pressed={active}
      data-testid={`sba-sync-filter-${value}`}
    >
      {label}
    </button>
  );
}

function DiscrepancyRow({ discrepancy }: { discrepancy: Discrepancy }) {
  const severityClass = discrepancy.severity === 'drift' ? 'sba-badge-remove' : 'sba-badge-temp';
  return (
    <div
      className="sba-sync-row"
      data-testid={`sba-sync-row-${discrepancy.canonical}`}
      data-severity={discrepancy.severity}
    >
      <div className="sba-sync-row-head">
        <strong className="sba-sync-row-email">{discrepancy.displayEmail}</strong>
        <span className={`sba-badge ${severityClass}`}>{severityLabel(discrepancy.severity)}</span>
        <span className="sba-badge sba-badge-code">{discrepancy.code}</span>
      </div>
      <div className="sba-sync-sides">
        <SideBlock
          title="SBA"
          empty={!discrepancy.sba}
          content={
            discrepancy.sba ? (
              <>
                <div>
                  <em>scope:</em> {discrepancy.sba.scope}
                </div>
                <div>
                  <em>type:</em> {discrepancy.sba.type}
                </div>
                {discrepancy.sba.callings.length > 0 ? (
                  <div>
                    <em>callings:</em> {discrepancy.sba.callings.join(', ')}
                  </div>
                ) : null}
                {discrepancy.sba.reason ? (
                  <div>
                    <em>reason:</em> {discrepancy.sba.reason}
                  </div>
                ) : null}
                <div>
                  <em>buildings:</em>{' '}
                  {discrepancy.sba.buildingNames.length > 0
                    ? discrepancy.sba.buildingNames.join(', ')
                    : '(none)'}
                </div>
              </>
            ) : null
          }
        />
        <SideBlock
          title="Kindoo"
          empty={!discrepancy.kindoo}
          content={
            discrepancy.kindoo ? (
              <>
                <div>
                  <em>description:</em> {discrepancy.kindoo.description || '(empty)'}
                </div>
                <div>
                  <em>tempUser:</em> {discrepancy.kindoo.isTempUser ? 'yes' : 'no'}
                </div>
                <div>
                  <em>intended type:</em> {discrepancy.kindoo.intendedType ?? '(unresolved)'}
                </div>
                <div>
                  <em>rule IDs:</em>{' '}
                  {discrepancy.kindoo.ruleIds.length > 0
                    ? discrepancy.kindoo.ruleIds.join(', ')
                    : '(none)'}
                </div>
              </>
            ) : null
          }
        />
      </div>
      <p className="sba-sync-reason">{discrepancy.reason}</p>
    </div>
  );
}

function SideBlock({
  title,
  empty,
  content,
}: {
  title: string;
  empty: boolean;
  content: React.ReactNode;
}) {
  return (
    <div className="sba-sync-side">
      <div className="sba-sync-side-title">{title}</div>
      {empty ? <div className="sba-muted">— absent —</div> : <div>{content}</div>}
    </div>
  );
}

function severityLabel(s: Severity): string {
  return s === 'drift' ? 'Drift' : 'Review';
}
