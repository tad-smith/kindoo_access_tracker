// Side-panel React root. Routes between four states:
//   1. Auth loading (initial onAuthStateChanged hasn't fired)
//   2. Signed-out — render the sign-in CTA
//   3. Signed-in manager — render the pending-request queue
//   4. Signed-in non-manager — render NotAuthorized
//
// The "is this user a manager?" determination comes from the
// callable: if `getMyPendingRequests` returns `permission-denied`,
// the queue panel calls back into us to flip to NotAuthorized.

import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useAuthState } from '../lib/auth';
import { NotAuthorizedPanel } from './NotAuthorizedPanel';
import { QueuePanel } from './QueuePanel';
import { SignedOutPanel } from './SignedOutPanel';
import './sidepanel.css';

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
    return <NotAuthorizedPanel email={authState.user.email} />;
  }

  return (
    <QueuePanel email={authState.user.email} onPermissionDenied={() => setNotAuthorized(true)} />
  );
}

// Side-effect bootstrap. Guarded so module imports (e.g. from vitest)
// do not crash when there is no `#root` element to mount into.
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
