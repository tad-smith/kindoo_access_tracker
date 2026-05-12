// React root for the content-script slide-over panel. Routes between
// four states:
//   1. Auth loading (initial auth.getState round-trip in flight)
//   2. Signed-out — render the sign-in CTA
//   3. Signed-in manager — render the pending-request queue
//   4. Signed-in non-manager — render NotAuthorized
//
// The "is this user a manager?" determination comes from the
// callable: if `getMyPendingRequests` returns `permission-denied`,
// the queue panel calls back into us to flip to NotAuthorized.
//
// Auth state is round-tripped through the service worker via
// `chrome.runtime.sendMessage` (see `lib/extensionApi.ts`); the
// content script cannot touch chrome.identity or the Firebase SDK
// from the page context.

import { useState } from 'react';
import { useAuthState } from '../lib/extensionApi';
import { NotAuthorizedPanel } from './NotAuthorizedPanel';
import { QueuePanel } from './QueuePanel';
import { SignedOutPanel } from './SignedOutPanel';

export function App() {
  const authState = useAuthState();
  const [notAuthorized, setNotAuthorized] = useState(false);

  if (authState.status === 'loading') {
    return (
      <main className="sba-panel" data-testid="sba-loading">
        <header className="sba-header">
          <h1>Stake Building Access</h1>
        </header>
        <div className="sba-body sba-body-center">
          <p className="sba-muted">Loading…</p>
        </div>
      </main>
    );
  }

  if (authState.status === 'signed-out') {
    // Reset the NotAuthorized flag on sign-out so a fresh sign-in
    // re-runs the manager probe.
    if (notAuthorized) setNotAuthorized(false);
    return <SignedOutPanel />;
  }

  if (notAuthorized) {
    return <NotAuthorizedPanel email={authState.email} />;
  }

  return <QueuePanel email={authState.email} onPermissionDenied={() => setNotAuthorized(true)} />;
}
