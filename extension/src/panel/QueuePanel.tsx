// Signed-in manager view. Renders the pending-request queue.
//
// v2.2: each card runs its own Provision & Complete flow (RequestCard
// owns the Kindoo orchestration + the result dialog). When the
// operator dismisses a result dialog we drop the card from the local
// list and refetch the queue to pick up any sibling changes.

import { useCallback, useEffect, useState } from 'react';
import type { AccessRequest } from '@kindoo/shared';
import { getMyPendingRequests, signOut, type StakeConfigBundle } from '../lib/extensionApi';
import { STAKE_ID } from '../lib/constants';
import { RequestCard } from './RequestCard';

interface QueuePanelProps {
  email: string | null | undefined;
  /** Stake / building / ward config loaded by App; threaded down so
   * each RequestCard can run the v2.2 provision flow. */
  bundle: StakeConfigBundle;
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
  /** Called when the operator clicks the Sync entry-point in the
   * header. Routes to the read-only drift report (Sync Phase 1). */
  onOpenSync?: () => void;
}

type FetchState =
  | { status: 'loading' }
  | { status: 'ready'; requests: AccessRequest[] }
  | { status: 'error'; message: string };

export function QueuePanel({
  email,
  bundle,
  onPermissionDenied,
  onReconfigure,
  onOpenSync,
}: QueuePanelProps) {
  const [state, setState] = useState<FetchState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const fetchQueue = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'refresh') setRefreshing(true);
      else setState({ status: 'loading' });
      try {
        const result = await getMyPendingRequests({ stakeId: STAKE_ID });
        setState({ status: 'ready', requests: result.requests });
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

  const handleDismissed = useCallback(
    (requestId: string) => {
      setState((prev) =>
        prev.status === 'ready'
          ? { status: 'ready', requests: prev.requests.filter((r) => r.request_id !== requestId) }
          : prev,
      );
      void fetchQueue('refresh');
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
          {onOpenSync ? (
            <button
              type="button"
              className="sba-btn-link"
              onClick={onOpenSync}
              data-testid="sba-open-sync"
            >
              Sync
            </button>
          ) : null}
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
        {state.status === 'ready' && state.requests.length === 0 ? (
          <p className="sba-empty" data-testid="sba-queue-empty">
            No pending requests.
          </p>
        ) : null}
        {state.status === 'ready' && state.requests.length > 0 ? (
          <ul className="sba-request-list" data-testid="sba-queue-list">
            {state.requests.map((req) => (
              <li key={req.request_id}>
                <RequestCard request={req} bundle={bundle} onDismissed={handleDismissed} />
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
