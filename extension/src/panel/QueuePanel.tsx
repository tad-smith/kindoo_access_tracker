// Signed-in manager view. Renders the pending-request queue and the
// "Mark Complete" affordance per row.
//
// State shape:
//   - 'loading'  — initial fetch in flight
//   - 'ready'    — fetched, render the list (possibly empty)
//   - 'error'    — last fetch failed with a non-permission error;
//                  show the message + a manual refresh button
//
// The `permission-denied` case is handled one level up in `App`: we
// surface the typed error to the root which then renders
// `NotAuthorizedPanel`. Keeping that branch out of this component
// keeps the queue UI focused on the happy path.

import { useCallback, useEffect, useState } from 'react';
import type { AccessRequest } from '@kindoo/shared';
import { getMyPendingRequests, markRequestComplete, signOut } from '../lib/extensionApi';
import { STAKE_ID } from '../lib/constants';
import { RequestCard } from './RequestCard';

interface QueuePanelProps {
  email: string | null | undefined;
  /**
   * Called when the queue fetch fails with `permission-denied`; the
   * root switches to `NotAuthorizedPanel`.
   */
  onPermissionDenied: () => void;
  /**
   * Called when the operator clicks the reconfigure entry-point in the
   * header. Used for adding a newly-created building, remapping rules,
   * or recovering from a site-identity change.
   */
  onReconfigure?: () => void;
}

type FetchState =
  | { status: 'loading' }
  | { status: 'ready'; requests: AccessRequest[] }
  | { status: 'error'; message: string };

export function QueuePanel({ email, onPermissionDenied, onReconfigure }: QueuePanelProps) {
  const [state, setState] = useState<FetchState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchQueue = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'refresh') setRefreshing(true);
      else setState({ status: 'loading' });
      try {
        const result = await getMyPendingRequests({ stakeId: STAKE_ID });
        setState({ status: 'ready', requests: result.requests });
        setActionError(null);
      } catch (err) {
        const code = readFunctionsErrorCode(err);
        if (code === 'permission-denied') {
          onPermissionDenied();
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', message });
      } finally {
        setRefreshing(false);
      }
    },
    [onPermissionDenied],
  );

  useEffect(() => {
    void fetchQueue('initial');
  }, [fetchQueue]);

  const handleComplete = useCallback(
    async (requestId: string, completionNote: string | undefined) => {
      setActionError(null);
      // Optimistic removal: drop the row immediately, then refetch to
      // pick up server-side changes (e.g. another manager completing a
      // sibling request).
      setState((prev) =>
        prev.status === 'ready'
          ? { status: 'ready', requests: prev.requests.filter((r) => r.request_id !== requestId) }
          : prev,
      );
      try {
        const payload: { stakeId: string; requestId: string; completionNote?: string } = {
          stakeId: STAKE_ID,
          requestId,
        };
        if (completionNote && completionNote.length > 0) {
          payload.completionNote = completionNote;
        }
        await markRequestComplete(payload);
        await fetchQueue('refresh');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setActionError(`Mark complete failed: ${message}. Refreshing…`);
        await fetchQueue('refresh');
      }
    },
    [fetchQueue],
  );

  return (
    <main className="sba-panel" data-testid="sba-queue">
      <header className="sba-header">
        <div>
          <h1>Pending requests</h1>
          {email ? <div className="sba-header-meta">{email}</div> : null}
        </div>
        <div className="sba-request-actions">
          {onReconfigure ? (
            <button
              type="button"
              className="sba-btn-link"
              onClick={onReconfigure}
              data-testid="sba-reconfigure"
            >
              Configure Kindoo
            </button>
          ) : null}
          <button
            type="button"
            className="sba-btn"
            onClick={() => void fetchQueue('refresh')}
            disabled={refreshing || state.status === 'loading'}
            data-testid="sba-refresh"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="sba-btn"
            onClick={() => void signOut()}
            data-testid="sba-sign-out"
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="sba-body">
        {state.status === 'loading' ? <p className="sba-muted">Loading…</p> : null}
        {state.status === 'error' ? (
          <p role="alert" className="sba-error" data-testid="sba-queue-error">
            {state.message}
          </p>
        ) : null}
        {actionError ? (
          <p role="alert" className="sba-error">
            {actionError}
          </p>
        ) : null}
        {state.status === 'ready' && state.requests.length === 0 ? (
          <p className="sba-empty" data-testid="sba-queue-empty">
            No pending requests.
          </p>
        ) : null}
        {state.status === 'ready' && state.requests.length > 0 ? (
          <ul className="sba-request-list" data-testid="sba-queue-list">
            {state.requests.map((req) => (
              <li key={req.request_id}>
                <RequestCard request={req} onComplete={handleComplete} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </main>
  );
}

/**
 * Firebase Functions httpsCallable rejections surface as an `Error`
 * with `.code` set to the HttpsError code (e.g. `'permission-denied'`,
 * `'failed-precondition'`). Plain `Error` instances do not carry the
 * field; narrow safely.
 */
function readFunctionsErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
