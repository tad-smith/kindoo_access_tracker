// Manager Import page. Mirrors `src/ui/manager/Import.html`:
//   - "Import Now" button → calls `runImportNow` callable. Phase 8
//     wires the function; until it's deployed, the wrapper throws a
//     friendly "not yet enabled" error and we surface it as an info
//     toast.
//   - Status block: last import time + summary + callings sheet ID.
//   - Over-cap banner reads `stake.last_over_caps_json` and renders
//     each pool with a deep-link to the filtered All Seats view.

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '../../../components/ui/Button';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { toast } from '../../../lib/store/toast';
import { invokeRunImportNow } from '../../bootstrap/callables';
import { STAKE_ID } from '../../../lib/constants';
import { useStakeDoc } from './hooks';

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

export function ImportPage() {
  const stake = useStakeDoc();
  const [running, setRunning] = useState(false);

  async function runImport() {
    setRunning(true);
    try {
      const res = await invokeRunImportNow(STAKE_ID);
      const summary = res.summary || 'Import complete.';
      toast(summary, res.warnings && res.warnings.length > 0 ? 'warn' : 'success');
    } catch (err) {
      const msg = errorMessage(err);
      // The "not yet enabled" path bubbles up from `invokeRunImportNow`
      // — show as info rather than error since it's an expected
      // pre-Phase-8 state.
      const isPending = /not yet enabled/i.test(msg);
      toast(msg, isPending ? 'info' : 'error');
    } finally {
      setRunning(false);
    }
  }

  if (stake.isLoading || stake.data === undefined) {
    return <LoadingSpinner />;
  }

  const overCaps = stake.data.last_over_caps_json ?? [];

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
          <Button onClick={runImport} disabled={running} data-testid="import-now-button">
            {running ? 'Working…' : 'Import Now'}
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
      </div>
    </section>
  );
}
