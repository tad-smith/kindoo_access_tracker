// Throwaway-style admin page that fires the T-42 `backfillKindooSiteId`
// callable for the current stake and renders the counters inline.
// Direct-URL only — not linked from any nav. Re-runnable; the callable
// is idempotent (skip-if-equal). See `docs/spec.md` §15 "One-shot
// migration".

import { useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { STAKE_ID } from '../../../lib/constants';
import { invokeBackfillKindooSiteId, type BackfillKindooSiteIdResult } from './callables';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function MigratePage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackfillKindooSiteIdResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await invokeBackfillKindooSiteId(STAKE_ID);
      setResult(out);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="kd-page-medium">
      <h1>Migration: backfill kindoo_site_id</h1>
      <p className="kd-page-subtitle">
        Backfills <code>Seat.kindoo_site_id</code>, <code>duplicate_grants[].kindoo_site_id</code>,
        and the <code>duplicate_scopes</code> mirror for the home stake. Safe to re-run — idempotent
        skip-if-equal.
      </p>

      <div className="form-actions">
        <Button onClick={run} disabled={busy} data-testid="migrate-run-button">
          {busy ? 'Running…' : 'Run Migration'}
        </Button>
      </div>

      {error ? (
        <div className="kd-import-error" role="alert" data-testid="migrate-error">
          <strong>Migration failed.</strong> {error}
        </div>
      ) : null}

      {result ? (
        <div className="kd-import-result kd-import-result-ok" data-testid="migrate-result">
          <h2>Run summary</h2>
          <dl className="kd-import-result-grid">
            <dt>Seats total</dt>
            <dd data-testid="migrate-seats-total">{result.seats_total}</dd>
            <dt>Seats updated</dt>
            <dd data-testid="migrate-seats-updated">{result.seats_updated}</dd>
            <dt>Primary scope skipped (missing ward)</dt>
            <dd data-testid="migrate-primary-skipped">{result.primary_kindoo_site_id_skipped}</dd>
            <dt>Duplicates updated</dt>
            <dd data-testid="migrate-duplicates-updated">{result.duplicates_updated}</dd>
            <dt>Duplicates skipped (missing ward)</dt>
            <dd data-testid="migrate-duplicates-skipped">
              {result.duplicates_skipped_missing_ward}
            </dd>
          </dl>

          {result.warnings.length > 0 ? (
            <div data-testid="migrate-warnings">
              <strong>Warnings ({result.warnings.length})</strong>
              <ul>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
