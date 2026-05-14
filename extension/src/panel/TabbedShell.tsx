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

import { useState } from 'react';
import type { StakeConfigBundle } from '../lib/extensionApi';
import { ConfigurePanel } from './ConfigurePanel';
import { QueuePanel } from './QueuePanel';
import { SyncPanel } from './SyncPanel';
import { TabBar, type TabKey } from './TabBar';
import { Toolbar } from './Toolbar';

interface TabbedShellProps {
  email: string | null | undefined;
  bundle: StakeConfigBundle;
  /** Called when the queue fetch returns permission-denied — App flips
   * to NotAuthorizedPanel. */
  onPermissionDenied: () => void;
  /** Called when a save inside ConfigurePanel ('tab' mode) succeeds —
   * App refreshes the stake config bundle. */
  onConfigComplete: () => void;
}

const PANEL_IDS: Record<TabKey, string> = {
  queue: 'sba-tabpanel-queue',
  sync: 'sba-tabpanel-sync',
  configure: 'sba-tabpanel-configure',
};

export function TabbedShell({
  email,
  bundle,
  onPermissionDenied,
  onConfigComplete,
}: TabbedShellProps) {
  const [active, setActive] = useState<TabKey>('queue');

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
          <QueuePanel bundle={bundle} onPermissionDenied={onPermissionDenied} />
        ) : null}
        {active === 'sync' ? <SyncPanel /> : null}
        {active === 'configure' ? (
          <ConfigurePanel mode="tab" email={email} onComplete={onConfigComplete} />
        ) : null}
      </div>
    </main>
  );
}
