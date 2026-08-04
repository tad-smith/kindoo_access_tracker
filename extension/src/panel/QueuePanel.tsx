// Signed-in manager view. Renders the pending-request queue, matched
// to the app's manager Requests Queue: three priority sections
// (Urgent → Outstanding → Future), per-card Reject (reason required),
// add-for-existing-seat → Reject-only, and edit-for-nonexistent-seat →
// Reject-only.
//
// Each card runs its own Provision & Complete flow (RequestCard owns
// the Kindoo orchestration + the result dialog). When the operator
// dismisses a result dialog OR rejects a request, `pending.dismiss`
// drops the card and refetches to pick up any sibling changes.
//
// The queue fetch itself is NOT owned here — it lives in
// `usePendingRequests`, hosted by TabbedShell, so it survives this
// component unmounting on every tab switch. We consume it as the
// `pending` prop.
//
// Remote apply (D27) is likewise hosted by TabbedShell. This file owns
// only its visible surfaces: the opt-in row, the banner, and gating the
// provision button on whichever card a phone-initiated job has in hand —
// queued or running, since the queued window is where a manager who taps
// on their phone and turns to their computer actually finds the card.
// The post-job queue refresh stays in TabbedShell — it has to fire with
// this component unmounted.
//
// Seat-existence: whenever the request list resolves we fetch
// `getSeatByEmail` for every non-`remove` request and build a
// `request_id → 'present' | 'absent'` map. A handful of extra reads is fine at this scale. The
// map is three-state by omission: a lookup that resolved records
// `'present'` (seat found) or `'absent'` (returned null); a lookup that
// FAILED is left out of the map entirely → "unknown". RequestCard maps
// each state to its gate:
//   - add-for-existing blocks only on `'present'` (unknown → not blocked)
//   - edit-for-nonexistent blocks only on `'absent'` (unknown → not blocked)
// Either way a failed lookup never blocks — the provision button stays
// visible and the server-side preconditions are the backstop.
//
// Body-only: chrome (sign-out button, email, reconfigure / sync nav)
// has moved to the shared toolbar + tab bar in TabbedShell. This file
// renders the queue sections and its Refresh control only.

import { useEffect, useMemo, useState } from 'react';
import {
  partitionPendingRequests,
  type AccessRequest,
  type QueueSections,
  type Seat,
} from '@kindoo/shared';
import { getSeatByEmail, type StakeConfigBundle } from '../lib/extensionApi';
import { useRemoteApplyEnabled } from '../lib/remoteApplyPrefs';
import type { RemoteApplyState } from '../content/remoteApply/useRemoteApply';
import { RequestCard, type RemoteApplyPhase } from './RequestCard';
import type { PendingRequests } from './usePendingRequests';

interface QueuePanelProps {
  /** Active stake — threaded from App's resolution step. */
  stakeId: string;
  /** Stake / building / ward config loaded by App; threaded down so
   * each RequestCard can run the v2.2 provision flow. */
  bundle: StakeConfigBundle;
  /** Lifted queue fetch, hosted by TabbedShell so it outlives this
   * component's per-tab-switch unmount. Owns the permission-denied
   * escalation too. */
  pending: PendingRequests;
  /**
   * Live state of the remote-apply loop, also hosted by `TabbedShell`.
   * Read-only here: this component renders the running banner and gates
   * the matching card's provision button. The post-job queue refresh is
   * TabbedShell's, since it has to fire with this component unmounted.
   * Optional so the queue can be rendered standalone (tests, and any
   * future host that doesn't run the loop) — absent simply means no
   * banner and no gating.
   */
  remoteApply?: RemoteApplyState | undefined;
}

/**
 * Per-request seat snapshot keyed by `request_id`. A present entry
 * carries:
 *   - `existence` — `'present'` (seat found) or `'absent'` (returned
 *     null). A failed / unresolved lookup omits the request entirely →
 *     "unknown"; both seat gates treat unknown as not-blocked.
 *   - `hasStakeGrant` — true when the seat already holds a stake-scope
 *     grant (primary OR any duplicate). Drives the add-for-existing-seat
 *     carve-out for stake-scope `add_manual` (see RequestCard). Always
 *     false for an `'absent'` seat.
 */
type SeatExistence = 'present' | 'absent';
interface SeatInfo {
  existence: SeatExistence;
  hasStakeGrant: boolean;
}
type SeatMap = Record<string, SeatInfo>;

/** True when the seat holds a stake-scope grant — primary or duplicate. */
function seatHasStakeGrant(seat: Seat): boolean {
  return seat.scope === 'stake' || (seat.duplicate_grants ?? []).some((g) => g.scope === 'stake');
}

/**
 * Resolve seat info for every request that operates on a seat —
 * `add_*` (block on present, minus the stake-grant carve-out) and
 * `edit_*` (block on absent). `remove` is skipped: it targets an
 * existing seat by design and has no gate. Each lookup is caught
 * individually so one failed read can't reject the batch or block the
 * queue — a failed lookup is OMITTED from the map ("unknown"), and both
 * gates treat unknown as not-blocked.
 */
async function fetchSeatMap(stakeId: string, requests: readonly AccessRequest[]): Promise<SeatMap> {
  const seatRequests = requests.filter((r) => r.type !== 'remove');
  const entries = await Promise.all(
    seatRequests.map(async (r): Promise<[string, SeatInfo] | null> => {
      try {
        const seat = await getSeatByEmail(stakeId, r.member_canonical);
        if (seat === null) return [r.request_id, { existence: 'absent', hasStakeGrant: false }];
        return [r.request_id, { existence: 'present', hasStakeGrant: seatHasStakeGrant(seat) }];
      } catch {
        // Resilient: a failed lookup is omitted → "unknown" → not blocked.
        return null;
      }
    }),
  );
  return Object.fromEntries(entries.filter((e): e is [string, SeatInfo] => e !== null));
}

export function QueuePanel({ stakeId, bundle, pending, remoteApply }: QueuePanelProps) {
  const { state, refreshing, refresh, dismiss } = pending;
  const [seatMap, setSeatMap] = useState<SeatMap>({});

  // Seat-existence is a best-effort overlay — never fails the queue.
  // `fetchSeatMap` catches per-lookup, so this never rejects. Re-runs
  // whenever the lifted queue yields a new ready list (load, refresh,
  // optimistic dismissal) and on remount after a tab switch.
  useEffect(() => {
    if (state.status !== 'ready') return;
    let cancelled = false;
    void fetchSeatMap(stakeId, state.requests).then((map) => {
      if (!cancelled) setSeatMap(map);
    });
    return () => {
      cancelled = true;
    };
  }, [stakeId, state]);

  // Requests a phone-initiated job has in hand, and how far along.
  // Threaded down to gate those cards' own provision buttons: both paths
  // run `applyRequest`, so two of them against one request can reach
  // `provisionAddOrChange` concurrently and write Kindoo twice. For a
  // member not yet in Kindoo the second write is a second `inviteUser` —
  // a consumed licence that `markRequestComplete` picking one winner does
  // nothing to undo.
  //
  // `running` is only this tab's own claim, and only for as long as that
  // claim ends cleanly — which is a fraction of the window.
  // `busyRequestIds` carries the rest: a job still sitting in the
  // mailbox, one another of the manager's tabs is running, and this tab's
  // own job whose terminal write never landed. So the button is gated
  // from the phone's tap through whichever tab finishes the work, and
  // past a run that finished without saying so. Gating on `running` alone
  // left it live for the whole of the flow the feature is named for.
  const remoteApplyBusy = useMemo(() => {
    const busy = new Map<string, RemoteApplyPhase>();
    for (const requestId of remoteApply?.busyRequestIds ?? EMPTY_IDS) {
      busy.set(requestId, 'elsewhere');
    }
    // After the elsewhere pass: this tab's own run is the stronger
    // claim, and the two overlap for the whole of it — the loop holds the
    // claimed `request_id` in the busy set until the terminal write
    // lands, so the card must not read "your desktop is handling it"
    // while this very tab is the desktop.
    if (remoteApply?.running) busy.set(remoteApply.running.requestId, 'this-tab');
    return busy;
  }, [remoteApply?.busyRequestIds, remoteApply?.running]);

  const requests = state.status === 'ready' ? state.requests : EMPTY_REQUESTS;
  // Compute "now" once per render; the day-level section boundary is
  // insensitive to sub-day drift within a session.
  const sections = useMemo(() => partitionPendingRequests(requests, new Date()), [requests]);

  return (
    <div className="sba-body" data-testid="sba-queue">
      <RemoteApplyToggleRow />
      {remoteApply?.running ? (
        <div
          role="status"
          className="sba-banner sba-banner-info"
          data-testid="sba-remote-apply-running"
        >
          <span>Applying a request you sent from your phone…</span>
        </div>
      ) : remoteApplyBusy.size > 0 ? (
        // Not this tab: the tap is either still in the mailbox or in a
        // sibling tab's hands. "Your desktop" rather than "this tab"
        // covers both, and "handling" covers both halves of it — a job
        // waiting to be claimed and one already being applied next door.
        <div
          role="status"
          className="sba-banner sba-banner-info"
          data-testid="sba-remote-apply-queued"
        >
          <span>Your desktop is handling a request you sent from your phone…</span>
        </div>
      ) : null}
      <div className="sba-request-actions">
        <button
          type="button"
          className="sba-btn"
          onClick={refresh}
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
            title="Emergency Requests"
            testid="sba-queue-section-urgent"
            requests={sections.urgent}
            stakeId={stakeId}
            bundle={bundle}
            seatMap={seatMap}
            remoteApplyBusy={remoteApplyBusy}
            onDismissed={dismiss}
          />
          <QueueSection
            title="Outstanding Requests"
            testid="sba-queue-section-outstanding"
            requests={sections.outstanding}
            stakeId={stakeId}
            bundle={bundle}
            seatMap={seatMap}
            remoteApplyBusy={remoteApplyBusy}
            onDismissed={dismiss}
          />
          <QueueSection
            title="Future Requests"
            testid="sba-queue-section-future"
            requests={sections.future}
            stakeId={stakeId}
            bundle={bundle}
            seatMap={seatMap}
            remoteApplyBusy={remoteApplyBusy}
            onDismissed={dismiss}
          />
        </div>
      ) : null}
    </div>
  );
}

const EMPTY_REQUESTS: readonly AccessRequest[] = [];
const EMPTY_IDS: readonly string[] = [];

/**
 * The remote-apply opt-in. Off by default and off for every profile
 * that predates the feature — it hands a second device the authority to
 * provision building access, so it has to be an explicit act.
 *
 * The checkbox only writes `chrome.storage.local`; the loop in
 * `TabbedShell` observes the same value and starts / stops itself,
 * clearing `remote_apply_enabled` on the presence doc as it goes so the
 * phone's button disappears at once rather than after the staleness
 * window.
 */
function RemoteApplyToggleRow() {
  const { enabled, loaded, setEnabled } = useRemoteApplyEnabled();
  const [error, setError] = useState<string | null>(null);

  const handleChange = (next: boolean) => {
    setError(null);
    void setEnabled(next).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div className="sba-remote-apply" data-testid="sba-remote-apply-row">
      <label className="sba-remote-apply-label">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!loaded}
          onChange={(e) => handleChange(e.target.checked)}
          data-testid="sba-remote-apply-toggle"
        />
        <span>Allow requests from my phone</span>
      </label>
      <p className="sba-muted sba-remote-apply-hint">
        Lets you tap <strong>Apply via extension</strong> in the SBA queue on your phone and have
        this Chrome tab do the Kindoo work. Only while this Kindoo tab is open and signed in.
      </p>
      {error ? (
        <p role="alert" className="sba-error" data-testid="sba-remote-apply-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface QueueSectionProps {
  title: string;
  testid: string;
  requests: QueueSections[keyof QueueSections];
  stakeId: string;
  bundle: StakeConfigBundle;
  seatMap: SeatMap;
  /** `request_id` → how far a phone-initiated job has got with it.
   * Absent from the map ⇒ no phone-initiated work on that request. */
  remoteApplyBusy: ReadonlyMap<string, RemoteApplyPhase>;
  onDismissed: (requestId: string) => void;
}

function QueueSection({
  title,
  testid,
  requests,
  stakeId,
  bundle,
  seatMap,
  remoteApplyBusy,
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
              memberHasSeat={seatMap[req.request_id]?.existence === 'present'}
              memberSeatAbsent={seatMap[req.request_id]?.existence === 'absent'}
              memberHasStakeGrant={seatMap[req.request_id]?.hasStakeGrant ?? false}
              remoteApplyBusy={remoteApplyBusy.get(req.request_id)}
              onDismissed={onDismissed}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
