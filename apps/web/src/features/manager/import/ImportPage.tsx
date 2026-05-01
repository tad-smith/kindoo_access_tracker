// Manager Import page. Mirrors `src/ui/manager/Import.html`:
//   - "Import Now" button → calls the `runImportNow` callable via
//     `useRunImportNowMutation`. Shows an inline busy state, the
//     returned `ImportSummary` after success, and the error message on
//     failure. Also fires a toast for top-of-page feedback.
//   - Status block: last import time + summary + callings sheet ID,
//     read live from the stake doc.
//   - Over-cap banner reads `stake.last_over_caps_json` and renders
//     each pool with a deep-link to the filtered All Seats view. The
//     banner clears reactively when the field empties.

import { Link } from '@tanstack/react-router';
import type { ImportSummary } from '@kindoo/shared';
import { Button } from '../../../components/ui/Button';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { toast } from '../../../lib/store/toast';
import { useRunImportNowMutation, useStakeDoc } from './hooks';

function formatTimestamp(ts: { toDate?: () => Date } | undefined): string {
  if (!ts || !ts.toDate) return 'never';
  try {
    return ts.toDate().toLocaleString();
  } catch {
    return String(ts);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function ImportPage() {
  const stake = useStakeDoc();
  const run = useRunImportNowMutation();

  async function runImport() {
    try {
      const summary = await run.mutateAsync();
      const tone =
        summary.ok && summary.warnings.length === 0 ? 'success' : summary.ok ? 'warn' : 'error';
      const headline = summary.ok
        ? `Import complete — ${summary.inserted} inserts, ${summary.updated} updates, ${summary.deleted} deletes.`
        : `Import failed: ${summary.error ?? 'unknown error'}`;
      toast(headline, tone);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  if (stake.isLoading || stake.data === undefined) {
    return <LoadingSpinner />;
  }

  const overCaps = stake.data.last_over_caps_json ?? [];
  const lastResult = run.data;
  const lastError = run.error;

  return (
    <section>
      <h1>Import</h1>
      <p className="kd-page-subtitle">
        Pulls the latest state from the callings spreadsheet and updates Seats (auto) and Access.
        The weekly scheduled run fires automatically at <code>{stake.data.import_day}</code>{' '}
        <code>{stake.data.import_hour}:00</code> ({stake.data.timezone}). The button below triggers
        a run on demand.
      </p>

      {overCaps.length > 0 ? (
        <div className="kd-over-cap-banner" data-testid="import-over-cap-banner">
          <h2 className="kd-over-cap-heading">Over-cap warning after last import</h2>
          <p>
            The most recent import left the following pools over their configured cap. Imports
            always apply (LCR truth wins); to resolve, reduce manual/temp seats in the affected
            pool(s), or raise the seat cap on the Configuration page.
          </p>
          <ul className="kd-over-cap-list">
            {overCaps.map((p) => (
              <li key={p.pool} data-testid={`import-over-cap-row-${p.pool}`}>
                <strong>{p.pool === 'stake' ? 'Stake' : `Ward ${p.pool}`}</strong>: {p.count} /{' '}
                {p.cap} (over by {p.over_by}){' '}
                <Link
                  to="/manager/seats"
                  search={{ ward: p.pool === 'stake' ? 'stake' : p.pool }}
                  className="kd-over-cap-link"
                >
                  View seats →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="kd-import-card">
        <div className="form-actions">
          <Button onClick={runImport} disabled={run.isPending} data-testid="import-now-button">
            {run.isPending ? 'Importing…' : 'Import Now'}
          </Button>
        </div>

        <dl className="kd-import-status">
          <dt>Last import</dt>
          <dd data-testid="import-last-at">{formatTimestamp(stake.data.last_import_at)}</dd>
          <dt>Summary</dt>
          <dd data-testid="import-last-summary">{stake.data.last_import_summary || '—'}</dd>
          <dt>Callings sheet ID</dt>
          <dd data-testid="import-callings-sheet-id">
            {stake.data.callings_sheet_id || '(not set — add to Config)'}
          </dd>
        </dl>

        {lastError ? (
          <div className="kd-import-error" role="alert" data-testid="import-error">
            <strong>Import failed.</strong> {errorMessage(lastError)}
          </div>
        ) : null}

        {lastResult ? <ImportSummaryCard summary={lastResult} /> : null}
      </div>
    </section>
  );
}

interface ImportSummaryCardProps {
  summary: ImportSummary;
}

function ImportSummaryCard({ summary }: ImportSummaryCardProps) {
  const tone = summary.ok ? (summary.warnings.length > 0 ? 'warn' : 'ok') : 'fail';
  return (
    <div
      className={`kd-import-result kd-import-result-${tone}`}
      data-testid="import-summary"
      data-summary-status={summary.ok ? 'ok' : 'fail'}
    >
      <h2>{summary.ok ? 'Last run summary' : 'Last run failed'}</h2>
      <dl className="kd-import-result-grid">
        <dt>Inserts</dt>
        <dd data-testid="import-summary-inserted">{summary.inserted}</dd>
        <dt>Updates</dt>
        <dd data-testid="import-summary-updated">{summary.updated}</dd>
        <dt>Deletes</dt>
        <dd data-testid="import-summary-deleted">{summary.deleted}</dd>
        <dt>Access added</dt>
        <dd data-testid="import-summary-access-added">{summary.access_added}</dd>
        <dt>Access removed</dt>
        <dd data-testid="import-summary-access-removed">{summary.access_removed}</dd>
        <dt>Duration</dt>
        <dd data-testid="import-summary-elapsed">{formatElapsed(summary.elapsed_ms)}</dd>
        <dt>Triggered by</dt>
        <dd data-testid="import-summary-triggered-by">{summary.triggered_by}</dd>
      </dl>

      {!summary.ok && summary.error ? (
        <p className="kd-import-result-error" data-testid="import-summary-error">
          <strong>Error:</strong> {summary.error}
        </p>
      ) : null}

      {summary.warnings.length > 0 ? (
        <div data-testid="import-summary-warnings">
          <strong>Warnings ({summary.warnings.length})</strong>
          <ul>
            {summary.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {summary.skipped_tabs.length > 0 ? (
        <div data-testid="import-summary-skipped">
          <strong>Skipped tabs:</strong> {summary.skipped_tabs.join(', ')}
        </div>
      ) : null}
    </div>
  );
}
