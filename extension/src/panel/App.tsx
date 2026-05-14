// React root for the content-script slide-over panel. Routes between
// five states:
//   1. Auth loading (initial auth.getState round-trip in flight)
//   2. Signed-out — render the sign-in CTA
//   3. Signed-in non-manager — render NotAuthorized
//   4. Signed-in manager, needs-config — render ConfigurePanel
//   5. Signed-in manager, fully configured — render QueuePanel
//
// The "is this user a manager?" determination comes from the
// callable: if `getMyPendingRequests` returns `permission-denied`,
// the queue panel calls back into us to flip to NotAuthorized.
//
// The "needs-config?" determination comes from the v2.1
// `data.getStakeConfig` round-trip: if `stake.kindoo_config` is absent
// OR any building lacks `kindoo_rule`, we show ConfigurePanel until
// the operator finishes the wizard. The Queue panel exposes a
// `Configure Kindoo` link that drops us back into the wizard for
// reconfigure cases (new building, new rules).
//
// Auth state is round-tripped through the service worker via
// `chrome.runtime.sendMessage` (see `lib/extensionApi.ts`); the
// content script cannot touch chrome.identity or the Firebase SDK
// from the page context.

import { useCallback, useEffect, useState } from 'react';
import {
  ExtensionApiError,
  getStakeConfig,
  useAuthState,
  type StakeConfigBundle,
} from '../lib/extensionApi';
import { ConfigurePanel } from './ConfigurePanel';
import { NotAuthorizedPanel } from './NotAuthorizedPanel';
import { QueuePanel } from './QueuePanel';
import { SignedOutPanel } from './SignedOutPanel';
import { SyncPanel } from './SyncPanel';

type ConfigStatus =
  | { kind: 'loading' }
  | { kind: 'needs-config' }
  | { kind: 'configured'; bundle: StakeConfigBundle }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

function decideConfigStatus(bundle: StakeConfigBundle): ConfigStatus {
  if (!bundle.stake.kindoo_config) return { kind: 'needs-config' };
  const someBuildingMissingRule = bundle.buildings.some((b) => !b.kindoo_rule);
  if (someBuildingMissingRule) return { kind: 'needs-config' };
  return { kind: 'configured', bundle };
}

export function App() {
  const authState = useAuthState();
  const [notAuthorized, setNotAuthorized] = useState(false);
  const [configStatus, setConfigStatus] = useState<ConfigStatus>({ kind: 'loading' });
  const [reconfiguring, setReconfiguring] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const refreshConfig = useCallback(async () => {
    setConfigStatus({ kind: 'loading' });
    try {
      const bundle = await getStakeConfig();
      setConfigStatus(decideConfigStatus(bundle));
    } catch (err) {
      if (err instanceof ExtensionApiError && err.code === 'permission-denied') {
        setConfigStatus({ kind: 'denied' });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setConfigStatus({ kind: 'error', message });
    }
  }, []);

  useEffect(() => {
    if (authState.status !== 'signed-in') return;
    if (notAuthorized) return;
    void refreshConfig();
  }, [authState.status, notAuthorized, refreshConfig]);

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
    if (reconfiguring) setReconfiguring(false);
    if (syncing) setSyncing(false);
    return <SignedOutPanel />;
  }

  if (notAuthorized || configStatus.kind === 'denied') {
    return <NotAuthorizedPanel email={authState.email} />;
  }

  if (configStatus.kind === 'loading') {
    return (
      <main className="sba-panel" data-testid="sba-config-loading">
        <header className="sba-header">
          <h1>Stake Building Access</h1>
        </header>
        <div className="sba-body sba-body-center">
          <p className="sba-muted">Loading…</p>
        </div>
      </main>
    );
  }

  if (configStatus.kind === 'error') {
    return (
      <main className="sba-panel" data-testid="sba-config-error">
        <header className="sba-header">
          <h1>Stake Building Access</h1>
        </header>
        <div className="sba-body">
          <p className="sba-error">Could not load configuration: {configStatus.message}</p>
          <button
            type="button"
            className="sba-btn"
            onClick={() => void refreshConfig()}
            data-testid="sba-config-retry"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (configStatus.kind === 'needs-config' || reconfiguring) {
    const onComplete = () => {
      setReconfiguring(false);
      void refreshConfig();
    };
    if (reconfiguring) {
      return (
        <ConfigurePanel
          email={authState.email}
          onComplete={onComplete}
          onCancel={() => setReconfiguring(false)}
        />
      );
    }
    return <ConfigurePanel email={authState.email} onComplete={onComplete} />;
  }

  if (syncing) {
    return <SyncPanel email={authState.email} onBack={() => setSyncing(false)} />;
  }

  return (
    <QueuePanel
      email={authState.email}
      bundle={configStatus.bundle}
      onPermissionDenied={() => setNotAuthorized(true)}
      onReconfigure={() => setReconfiguring(true)}
      onOpenSync={() => setSyncing(true)}
    />
  );
}
