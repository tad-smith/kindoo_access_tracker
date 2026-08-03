// Pending-request queue fetch, lifted out of QueuePanel.
//
// Why it lives here and not in QueuePanel: TabbedShell renders
// QueuePanel only while the Queue tab is active, so a fetch owned by
// QueuePanel unmounts the moment the operator parks on Sync or the gear
// tab. That would blank the slide-over handle's pending-count badge and
// re-fetch on every return to the queue. Hosted by TabbedShell instead,
// one fetch spans the whole signed-in session — including while the
// panel is shut, since the React tree stays mounted and only a CSS
// transform hides it.
//
// Seat-existence lookups deliberately stay in QueuePanel: they are a
// per-card render concern, not queue state.

import { useCallback, useEffect, useState } from 'react';
import type { AccessRequest } from '@kindoo/shared';
import { getMyPendingRequests } from '../lib/extensionApi';

export type PendingRequestsState =
  | { status: 'loading' }
  | { status: 'ready'; requests: AccessRequest[] }
  | { status: 'error'; message: string };

export interface PendingRequests {
  state: PendingRequestsState;
  /** True while a background refresh is in flight. The initial load
   * reports through `state.status === 'loading'` instead. */
  refreshing: boolean;
  refresh: () => void;
  /** Optimistically drop one card, then refetch to pick up siblings. */
  dismiss: (requestId: string) => void;
}

/**
 * `onPermissionDenied` must be referentially stable — it feeds the
 * fetch callback's dependency list, so a fresh arrow on every render
 * would re-run the initial fetch and reset the queue to `loading`.
 */
export function usePendingRequests(
  stakeId: string,
  onPermissionDenied: () => void,
): PendingRequests {
  const [state, setState] = useState<PendingRequestsState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const fetchQueue = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'refresh') setRefreshing(true);
      else setState({ status: 'loading' });
      try {
        const result = await getMyPendingRequests({ stakeId });
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
    [stakeId, onPermissionDenied],
  );

  useEffect(() => {
    void fetchQueue('initial');
  }, [fetchQueue]);

  const refresh = useCallback(() => {
    void fetchQueue('refresh');
  }, [fetchQueue]);

  const dismiss = useCallback(
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

  return { state, refreshing, refresh, dismiss };
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
