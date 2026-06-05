// Signed-in manager view. Renders the pending-request queue, matched
// to the app's manager Requests Queue: three priority sections
// (Urgent → Outstanding → Future), per-card Reject (reason required),
// and add-for-existing-seat → Reject-only.
//
// Each card runs its own Provision & Complete flow (RequestCard owns
// the Kindoo orchestration + the result dialog). When the operator
// dismisses a result dialog OR rejects a request, we drop the card from
// the local list and refetch the queue to pick up any sibling changes.
//
// Seat-existence: after the request list loads we fetch `getSeatByEmail`
// for each `add_manual` / `add_temp` request and build a
// `request_id → hasSeat` map. A handful of extra reads is fine at this
// scale. Lookups are resilient — a failed read resolves to `false` so
// the provision button stays visible rather than blocking the queue on
// a transient miss.
//
// Body-only: chrome (sign-out button, email, reconfigure / sync nav)
// has moved to the shared toolbar + tab bar in TabbedShell. This file
// renders the queue sections and its Refresh control only.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccessRequest } from '@kindoo/shared';
import { getMyPendingRequests, getSeatByEmail, type StakeConfigBundle } from '../lib/extensionApi';
import { RequestCard } from './RequestCard';
import { partitionPendingRequests, type QueueSections } from './sections';

interface QueuePanelProps {
  /** Active stake — threaded from App's resolution step. */
  stakeId: string;
  /** Stake / building / ward config loaded by App; threaded down so
   * each RequestCard can run the v2.2 provision flow. */
  bundle: StakeConfigBundle;
  /**
   * Called when the queue fetch fails with `permission-denied`; the
   * root switches to `NotAuthorizedPanel`.
   */
  onPermissionDenied: () => void;
}

type FetchState =
  | { status: 'loading' }
  | { status: 'ready'; requests: AccessRequest[] }
  | { status: 'error'; message: string };

/** `request_id → member already holds an SBA seat`. */
type SeatMap = Record<string, boolean>;

/**
 * Resolve seat-existence for every add request. Non-add types are not
 * in the map (the caller defaults absent → false). Each lookup is
 * caught individually so one failed read can't reject the batch or
 * block the queue — an unknown lookup falls back to `false`, leaving
 * the provision button visible.
 */
async function fetchSeatMap(stakeId: string, requests: readonly AccessRequest[]): Promise<SeatMap> {
  const addRequests = requests.filter((r) => r.type === 'add_manual' || r.type === 'add_temp');
  const entries = await Promise.all(
    addRequests.map(async (r): Promise<[string, boolean]> => {
      try {
        const seat = await getSeatByEmail(stakeId, r.member_canonical);
        return [r.request_id, seat !== null];
      } catch {
        // Resilient: treat a lookup failure as "unknown" → not blocked.
        return [r.request_id, false];
      }
    }),
  );
  return Object.fromEntries(entries);
}

export function QueuePanel({ stakeId, bundle, onPermissionDenied }: QueuePanelProps) {
  const [state, setState] = useState<FetchState>({ status: 'loading' });
  const [seatMap, setSeatMap] = useState<SeatMap>({});
  const [refreshing, setRefreshing] = useState(false);

  const fetchQueue = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'refresh') setRefreshing(true);
      else setState({ status: 'loading' });
      try {
        const result = await getMyPendingRequests({ stakeId });
        setState({ status: 'ready', requests: result.requests });
        // Seat-existence is a best-effort overlay — never fails the
        // queue. `fetchSeatMap` catches per-lookup, so this resolves.
        const map = await fetchSeatMap(stakeId, result.requests);
        setSeatMap(map);
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

  const requests = state.status === 'ready' ? state.requests : EMPTY_REQUESTS;
  // Compute "now" once per render; the day-level section boundary is
  // insensitive to sub-day drift within a session.
  const sections = useMemo(() => partitionPendingRequests(requests, new Date()), [requests]);

  return (
    <div className="sba-body" data-testid="sba-queue">
      <div className="sba-request-actions">
        <button
          type="button"
          className="sba-btn"
          onClick={() => void fetchQueue('refresh')}
          disabled={refreshing || state.status === 'loading'}
          data-testid="sba-refresh"
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {state.status === 'loading' ? <p className="sba-muted">Loading…</p> : null}
      {state.status === 'error' ? (
        <p role="alert" className="sba-error" data-testid="sba-queue-error">
          {state.message}
        </p>
      ) : null}
      {state.status === 'ready' && requests.length === 0 ? (
        <p className="sba-empty" data-testid="sba-queue-empty">
          No pending requests.
        </p>
      ) : null}
      {state.status === 'ready' && requests.length > 0 ? (
        <div data-testid="sba-queue-sections">
          <QueueSection
            title="Urgent Requests"
            testid="sba-queue-section-urgent"
            requests={sections.urgent}
            stakeId={stakeId}
            bundle={bundle}
            seatMap={seatMap}
            onDismissed={handleDismissed}
          />
          <QueueSection
            title="Outstanding Requests"
            testid="sba-queue-section-outstanding"
            requests={sections.outstanding}
            stakeId={stakeId}
            bundle={bundle}
            seatMap={seatMap}
            onDismissed={handleDismissed}
          />
          <QueueSection
            title="Future Requests"
            testid="sba-queue-section-future"
            requests={sections.future}
            stakeId={stakeId}
            bundle={bundle}
            seatMap={seatMap}
            onDismissed={handleDismissed}
          />
        </div>
      ) : null}
    </div>
  );
}

const EMPTY_REQUESTS: readonly AccessRequest[] = [];

interface QueueSectionProps {
  title: string;
  testid: string;
  requests: QueueSections[keyof QueueSections];
  stakeId: string;
  bundle: StakeConfigBundle;
  seatMap: SeatMap;
  onDismissed: (requestId: string) => void;
}

function QueueSection({
  title,
  testid,
  requests,
  stakeId,
  bundle,
  seatMap,
  onDismissed,
}: QueueSectionProps) {
  // Hide the whole section (header + body) when empty.
  if (requests.length === 0) return null;
  return (
    <div className="sba-queue-section" data-testid={testid}>
      <h2 className="sba-queue-section-header">
        {title} ({requests.length})
      </h2>
      <ul className="sba-request-list">
        {requests.map((req) => (
          <li key={req.request_id}>
            <RequestCard
              stakeId={stakeId}
              request={req}
              bundle={bundle}
              memberHasSeat={seatMap[req.request_id] === true}
              onDismissed={onDismissed}
            />
          </li>
        ))}
      </ul>
    </div>
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
