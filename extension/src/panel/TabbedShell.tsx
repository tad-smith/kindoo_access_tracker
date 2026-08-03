// Post-auth, post-config shell for the slide-over panel. Renders the
// gray toolbar (email + Sign out) above an underline tab bar (Request
// Queue / Sync / gear), and below that the active tab's body content.
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

import { useEffect, useState } from 'react';
import type { StakeConfigBundle } from '../lib/extensionApi';
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

  const pendingCount = pending.state.status === 'ready' ? pending.state.requests.length : null;
  useEffect(() => {
    onPendingCountChange?.(pendingCount);
    // Clear on unmount so the badge doesn't outlive the signed-in,
    // configured state (sign-out, permission-denied, reconfigure).
    return () => onPendingCountChange?.(null);
  }, [pendingCount, onPendingCountChange]);

  return (
    <main className="sba-panel" data-testid="sba-tabbed-shell">
      <Toolbar email={email} />
      <TabBar active={active} onChange={setActive} />
      <div
        className="sba-tabpanel"
        role="tabpanel"
        id={PANEL_IDS[active]}
        aria-labelledby={`sba-tab-${active}`}
      >
        {active === 'queue' ? (
          <QueuePanel stakeId={stakeId} bundle={bundle} pending={pending} />
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
