// Result dialog shown after v2.2's Provision & Complete flow finishes
// (or partially finishes — the SBA mark-complete step can fail
// independently of the Kindoo step).
//
// Two render modes:
//   - { kind: 'ok' }     — both Kindoo + SBA succeeded; one dismiss button.
//                           When `over_caps` is non-empty, also renders a
//                           warning row listing each pool that went over
//                           cap as a result of this completion.
//   - { kind: 'partial' } — Kindoo succeeded but the SBA mark-complete
//                           call failed; second button retries ONLY the
//                           SBA side using the captured kindoo_uid +
//                           provisioning_note (no Kindoo retry needed).
//                           The partial branch never carries over_caps
//                           — the SBA write never landed, so the server
//                           has nothing to report.
//
// Vanilla DOM modal in the same backdrop style as CompleteDialog.

import { useState } from 'react';
import type { OverCapEntry } from '@kindoo/shared';

export type ResultDialogState =
  | { kind: 'ok'; note: string; over_caps?: OverCapEntry[] }
  | {
      kind: 'partial';
      note: string;
      errorMessage: string;
      onRetrySba: () => Promise<void> | void;
    };

interface ResultDialogProps {
  state: ResultDialogState;
  onDismiss: () => void;
}

export function ResultDialog({ state, onDismiss }: ResultDialogProps) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const isPartial = state.kind === 'partial';

  async function handleRetry() {
    if (state.kind !== 'partial') return;
    setRetrying(true);
    setRetryError(null);
    try {
      await state.onRetrySba();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRetryError(message);
      setRetrying(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sba-result-dialog-title"
      className="sba-dialog-backdrop"
      data-testid="sba-result-dialog"
    >
      <div className="sba-dialog">
        <h2 id="sba-result-dialog-title">
          {isPartial ? 'Kindoo done — SBA still pending' : 'Done'}
        </h2>
        <p data-testid="sba-result-note">{state.note}</p>
        {state.kind === 'ok' && state.over_caps && state.over_caps.length > 0 ? (
          <div className="sba-result-overcap" data-testid="sba-result-overcap">
            <strong>Now over cap:</strong>
            <ul>
              {state.over_caps.map((entry) => (
                <li key={entry.pool}>
                  {entry.pool === 'stake' ? 'Stake-wide' : `Ward ${entry.pool}`}: {entry.count} /{' '}
                  {entry.cap} (+{entry.over_by})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {state.kind === 'partial' ? (
          <p className="sba-error" data-testid="sba-result-partial-error">
            Could not mark complete in SBA: {state.errorMessage}
          </p>
        ) : null}
        {retryError ? (
          <p role="alert" className="sba-error" data-testid="sba-result-retry-error">
            {retryError}
          </p>
        ) : null}
        <div className="sba-dialog-actions">
          {state.kind === 'partial' ? (
            <button
              type="button"
              className="sba-btn sba-btn-primary"
              onClick={() => void handleRetry()}
              disabled={retrying}
              data-testid="sba-result-retry"
            >
              {retrying ? 'Retrying…' : 'Mark Complete in SBA'}
            </button>
          ) : null}
          <button
            type="button"
            className="sba-btn"
            onClick={onDismiss}
            disabled={retrying}
            data-testid="sba-result-dismiss"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
