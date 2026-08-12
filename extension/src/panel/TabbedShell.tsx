// Post-auth, post-config shell for the slide-over panel. Renders the
// gray toolbar (email + Sign out), then the active stake's name, then
// an underline tab bar (Request Queue / Sync / gear), and below that
// the active tab's body content.
//
// Active-tab state is local and ephemeral: every fresh mount of this
// component lands on the Queue tab. We do not persist last-tab across
// panel opens (operator chose no sticky in the brief — fresh mounts
// always default to the queue).
//
// The three body components (QueuePanel / SyncPanel / ConfigurePanel
// in 'tab' mode) render headerless `sba-body` divs; the shell wraps
// them in a single tabpanel container that matches the active tab's
// aria-controls.
//
// This shell hosts the two things that must outlive a tab switch: the
// queue fetch (`usePendingRequests`) and the remote-apply loop
// (`useRemoteApply`). QueuePanel unmounts whenever the operator parks
// on Sync or the gear tab, which would otherwise blank the handle's
// pending-count badge and make the manager unreachable from their phone.

import { useEffect, useRef, useState } from 'react';
import type { StakeConfigBundle } from '../lib/extensionApi';
import { useRemoteApply } from '../content/remoteApply/useRemoteApply';
import { ConfigurePanel } from './ConfigurePanel';
import { QueuePanel } from './QueuePanel';
import { SyncPanel } from './SyncPanel';
import { TabBar, type TabKey } from './TabBar';
import { Toolbar } from './Toolbar';
import { usePendingRequests } from './usePendingRequests';

interface TabbedShellProps {
  /** Active stake the shell's panels read / write against. Threaded
   * from App's stake resolution step (single-candidate auto-pick or the
   * picker's persisted choice). */
  stakeId: string;
  /** Active stake's display name, rendered above the tab strip. Always
   * shown, even for a manager with a single candidate stake: a line that
   * appeared only when the stake was ambiguous would make its own
   * absence carry meaning, which reads as "no stake". App resolves the
   * fallback, so this is never blank. */
  stakeLabel: string;
  /** Reopens the stake picker. Present only when the active Kindoo site
   * maps to more than one of the manager's stakes — the same condition
   * that raises the picker in the first place — so the chevron is never
   * offered where there is no choice to make. Absent means no chevron. */
  onChangeStake?: (() => void) | undefined;
  email: string | null | undefined;
  bundle: StakeConfigBundle;
  /** Called when the queue fetch returns permission-denied — App flips
   * to NotAuthorizedPanel. */
  onPermissionDenied: () => void;
  /** Called when a save inside ConfigurePanel ('tab' mode) succeeds —
   * App refreshes the stake config bundle. */
  onConfigComplete: () => void;
  /** Reports the pending-request count out to the slide-over handle's
   * badge. `null` clears it (queue still loading, or the fetch failed).
   * Must be referentially stable. */
  onPendingCountChange?: ((count: number | null) => void) | undefined;
}

const PANEL_IDS: Record<TabKey, string> = {
  queue: 'sba-tabpanel-queue',
  sync: 'sba-tabpanel-sync',
  configure: 'sba-tabpanel-configure',
};

export function TabbedShell({
  stakeId,
  stakeLabel,
  onChangeStake,
  email,
  bundle,
  onPermissionDenied,
  onConfigComplete,
  onPendingCountChange,
}: TabbedShellProps) {
  const [active, setActive] = useState<TabKey>('queue');
  // Hosted here rather than in QueuePanel: the queue tab unmounts on
  // every tab switch, and the handle's badge must not blank when it does.
  const pending = usePendingRequests(stakeId, onPermissionDenied);
  // Same reason, plus one more: the panel mounts on every Kindoo page
  // load whether or not the slide-over is open, so hosting the loop in
  // the React tree gets us a background worker with the panel shut.
  const remoteApply = useRemoteApply({ stakeId, bundle });

  const pendingCount = pending.state.status === 'ready' ? pending.state.requests.length : null;
  useEffect(() => {
    onPendingCountChange?.(pendingCount);
    // Clear on unmount so the badge doesn't outlive the signed-in,
    // configured state (sign-out, permission-denied, reconfigure).
    return () => onPendingCountChange?.(null);
  }, [pendingCount, onPendingCountChange]);

  // A job the manager ran from their phone just finished a request that
  // may still be sitting in the queue. Refetch so the desktop and the
  // phone don't disagree about what happened. Watched HERE, not in
  // QueuePanel: the normal case for phone-initiated work is the Queue
  // tab unmounted and the slide-over shut, and the handle's badge would
  // otherwise keep counting a request the phone already completed.
  const { finishedCount } = remoteApply;
  const { refresh } = pending;
  const lastFinishedCount = useRef(finishedCount);
  useEffect(() => {
    if (finishedCount === lastFinishedCount.current) return;
    lastFinishedCount.current = finishedCount;
    refresh();
  }, [finishedCount, refresh]);

  return (
    <main className="sba-panel" data-testid="sba-tabbed-shell">
      <Toolbar email={email} />
      <div className="sba-stake-row" data-testid="sba-stake-row">
        {/* Reads as "go backwards", which is literal: the picker is the
            screen this one replaced. */}
        {onChangeStake ? (
          <button
            type="button"
            className="sba-stake-change"
            onClick={onChangeStake}
            aria-label="Change stake"
            title="Change stake"
            data-testid="sba-change-stake"
          >
            ‹
          </button>
        ) : null}
        {/* `title` carries the untruncated name, which the CSS ellipsis
            can hide on a narrow slide-over. */}
        <span className="sba-stake-label" data-testid="sba-stake-label" title={stakeLabel}>
          {stakeLabel}
        </span>
      </div>
      <TabBar active={active} onChange={setActive} />
      <div
        className="sba-tabpanel"
        role="tabpanel"
        id={PANEL_IDS[active]}
        aria-labelledby={`sba-tab-${active}`}
      >
        {active === 'queue' ? (
          <QueuePanel
            stakeId={stakeId}
            bundle={bundle}
            pending={pending}
            remoteApply={remoteApply}
          />
        ) : null}
        {active === 'sync' ? <SyncPanel stakeId={stakeId} /> : null}
        {active === 'configure' ? (
          <ConfigurePanel
            stakeId={stakeId}
            mode="tab"
            email={email}
            onComplete={onConfigComplete}
          />
        ) : null}
      </div>
    </main>
  );
}
