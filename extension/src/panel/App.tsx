// React root for the content-script slide-over panel. Routes between
// the following top-level states:
//   1. Auth loading (initial auth.getState round-trip in flight)
//   2. Signed-out — render the sign-in CTA (full takeover)
//   3. Signed-in, no Kindoo session / unknown active EID — render the
//      "open a specific Kindoo site" recovery copy (full takeover)
//   4. Signed-in, active EID maps to ≥ 2 managed-stake candidates with
//      no stored choice — render StakePicker (full takeover)
//   5. Signed-in, active stake resolved, signed-in non-manager — render
//      NotAuthorized (full takeover)
//   6. Signed-in, active stake resolved, needs-config — render
//      ConfigurePanel in 'wizard' mode (full takeover, no tab chrome)
//   7. Signed-in, fully configured — render TabbedShell (toolbar + tab
//      bar + active-tab body, default Queue)
//
// Stake resolution priority: stored `eidStakeChoice[<eid>]` (when it
// names a live candidate) → single live candidate (auto-picked, no
// storage write) → picker. Stored choices that no longer match the
// candidate set get cleared and the picker re-runs.
//
// The "is this user a manager?" determination still comes from the
// callable: if `getMyPendingRequests` returns `permission-denied`, the
// queue panel calls back into us to flip to NotAuthorized.

import { useCallback, useEffect, useState } from 'react';
import {
  ExtensionApiError,
  clearEidStakeChoice,
  getStakeConfig,
  readEidStakeChoice,
  resolveEidStakes,
  useAuthState,
  writeEidStakeChoice,
  type EidStakeCandidate,
  type StakeConfigBundle,
} from '../lib/extensionApi';
import { readKindooSession, type KindooSessionError } from '../content/kindoo/auth';
import { ConfigurePanel } from './ConfigurePanel';
import { NotAuthorizedPanel } from './NotAuthorizedPanel';
import { SignedOutPanel } from './SignedOutPanel';
import { StakePicker } from './StakePicker';
import { TabbedShell } from './TabbedShell';

type StakeResolution =
  | { kind: 'loading' }
  | { kind: 'no-session'; error: KindooSessionError }
  | { kind: 'wire-error'; message: string }
  | { kind: 'no-candidates'; eid: number }
  | { kind: 'pick'; eid: number; candidates: EidStakeCandidate[] }
  | { kind: 'resolved'; eid: number; stakeId: string };

type ConfigStatus =
  | { kind: 'loading' }
  | { kind: 'needs-config' }
  | { kind: 'configured'; bundle: StakeConfigBundle }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

function decideConfigStatus(bundle: StakeConfigBundle): ConfigStatus {
  // First-run gate: until home identity is captured we force the
  // wizard takeover. Foreign-site rule mappings happen on a later
  // wizard run while the operator's Kindoo session is on that foreign
  // site — checking foreign buildings here would loop the wizard
  // forever for any home session.
  if (!bundle.stake.kindoo_config) return { kind: 'needs-config' };
  const someHomeBuildingMissingRule = bundle.buildings.some(
    (b) => (b.kindoo_site_id === null || b.kindoo_site_id === undefined) && !b.kindoo_rule,
  );
  if (someHomeBuildingMissingRule) return { kind: 'needs-config' };
  return { kind: 'configured', bundle };
}

export function App() {
  const authState = useAuthState();
  const [notAuthorized, setNotAuthorized] = useState(false);
  const [stake, setStake] = useState<StakeResolution>({ kind: 'loading' });
  const [configStatus, setConfigStatus] = useState<ConfigStatus>({ kind: 'loading' });

  const resolveStake = useCallback(async () => {
    setStake({ kind: 'loading' });
    const sessionResult = readKindooSession();
    if (!sessionResult.ok) {
      setStake({ kind: 'no-session', error: sessionResult.error });
      return;
    }
    const eid = sessionResult.session.eid;
    let payload: Awaited<ReturnType<typeof resolveEidStakes>>;
    try {
      payload = await resolveEidStakes(eid);
    } catch (err) {
      // Wire / SW failure — keep distinct from "no candidates" so the
      // retry copy reads "Couldn't reach SBA" instead of telling the
      // operator to reconfigure SBA. A token-refresh blip is the
      // common trigger.
      const message = err instanceof Error ? err.message : String(err);
      setStake({ kind: 'wire-error', message });
      return;
    }
    if (payload.managedStakeCount === 0) {
      // Signed-in user holds no manager role anywhere. Route to the
      // same NotAuthorized state the old queue-callable
      // permission-denied path landed in; the reconfigure copy on
      // no-candidates would be misleading here.
      setNotAuthorized(true);
      return;
    }
    if (payload.candidates.length === 0 && payload.partialFailure) {
      // Every per-stake read failed (transient Firestore-wide outage
      // or sweeping rules-denial). The no-candidates copy would tell
      // the operator to reconfigure SBA — misleading. Surface as
      // wire-error so the retry button gets the right framing.
      setStake({
        kind: 'wire-error',
        message: 'Some stake reads failed.',
      });
      return;
    }
    if (payload.candidates.length === 0) {
      setStake({ kind: 'no-candidates', eid });
      return;
    }
    const stored = await readEidStakeChoice(eid);
    if (stored !== null && payload.candidates.some((c) => c.stakeId === stored)) {
      setStake({ kind: 'resolved', eid, stakeId: stored });
      return;
    }
    if (stored !== null) {
      // Stored value is no longer a candidate — drop it before the
      // picker reasserts. The operator may have lost their role on
      // that stake, or the EID was un-configured from that stake.
      await clearEidStakeChoice(eid).catch(() => undefined);
    }
    if (payload.candidates.length === 1) {
      // Single candidate — auto-resolve. Don't persist; the resolution
      // is structural, not a remembered choice.
      const only = payload.candidates[0]!;
      setStake({ kind: 'resolved', eid, stakeId: only.stakeId });
      return;
    }
    setStake({ kind: 'pick', eid, candidates: payload.candidates });
  }, []);

  const refreshConfig = useCallback(async (stakeId: string) => {
    setConfigStatus({ kind: 'loading' });
    try {
      const bundle = await getStakeConfig(stakeId);
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

  // Re-run stake resolution whenever auth flips to signed-in. Resetting
  // `notAuthorized` on sign-out is handled in the render branch below.
  useEffect(() => {
    if (authState.status !== 'signed-in') return;
    if (notAuthorized) return;
    void resolveStake();
  }, [authState.status, notAuthorized, resolveStake]);

  // Once a stake is resolved, fetch its config. Re-runs when the
  // operator picks a different stake.
  useEffect(() => {
    if (stake.kind !== 'resolved') return;
    void refreshConfig(stake.stakeId);
  }, [stake, refreshConfig]);

  const handlePick = useCallback(
    async (stakeId: string) => {
      if (stake.kind !== 'pick') return;
      await writeEidStakeChoice(stake.eid, stakeId);
      setStake({ kind: 'resolved', eid: stake.eid, stakeId });
    },
    [stake],
  );

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

  if (notAuthorized || configStatus.kind === 'denied') {
    return <NotAuthorizedPanel email={authState.email} />;
  }

  if (stake.kind === 'loading') {
    return (
      <main className="sba-panel" data-testid="sba-stake-loading">
        <header className="sba-header">
          <h1>Stake Building Access</h1>
        </header>
        <div className="sba-body sba-body-center">
          <p className="sba-muted">Resolving stake…</p>
        </div>
      </main>
    );
  }

  if (stake.kind === 'no-session') {
    return (
      <main className="sba-panel" data-testid="sba-no-kindoo">
        <header className="sba-header">
          <h1>Stake Building Access</h1>
        </header>
        <div className="sba-body">
          <p className="sba-error">
            {stake.error === 'no-token'
              ? 'Sign into Kindoo first, then reopen the panel.'
              : "Open a specific Kindoo site (click into one from the My Sites list) and reopen the panel. SBA can't tell which Kindoo site you're working on otherwise."}
          </p>
          <button
            type="button"
            className="sba-btn"
            onClick={() => void resolveStake()}
            data-testid="sba-no-kindoo-retry"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (stake.kind === 'wire-error') {
    return (
      <main className="sba-panel" data-testid="sba-wire-error">
        <header className="sba-header">
          <h1>Stake Building Access</h1>
        </header>
        <div className="sba-body">
          <p className="sba-error" data-testid="sba-wire-error-message">
            Couldn&rsquo;t reach SBA. {stake.message}
          </p>
          <button
            type="button"
            className="sba-btn"
            onClick={() => void resolveStake()}
            data-testid="sba-wire-error-retry"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (stake.kind === 'no-candidates') {
    return (
      <main className="sba-panel" data-testid="sba-no-candidates">
        <header className="sba-header">
          <h1>Stake Building Access</h1>
        </header>
        <div className="sba-body">
          <p className="sba-error" data-testid="sba-no-candidates-message">
            This Kindoo site (EID {stake.eid}) is not configured under any SBA stake you manage.
            Switch to a configured Kindoo site, or add this one in Configuration → Kindoo Sites on
            the SBA web app.
          </p>
          <button
            type="button"
            className="sba-btn"
            onClick={() => void resolveStake()}
            data-testid="sba-no-candidates-retry"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (stake.kind === 'pick') {
    return (
      <StakePicker
        email={authState.email}
        eid={stake.eid}
        candidates={stake.candidates}
        onPick={handlePick}
      />
    );
  }

  // stake.kind === 'resolved' — render the rest of the existing flow.
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
            onClick={() => void refreshConfig(stake.stakeId)}
            data-testid="sba-config-retry"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (configStatus.kind === 'needs-config') {
    // First-run wizard: full takeover, no tab chrome.
    return (
      <ConfigurePanel
        stakeId={stake.stakeId}
        email={authState.email}
        mode="wizard"
        onComplete={() => void refreshConfig(stake.stakeId)}
      />
    );
  }

  return (
    <TabbedShell
      stakeId={stake.stakeId}
      email={authState.email}
      bundle={configStatus.bundle}
      onPermissionDenied={() => setNotAuthorized(true)}
      onConfigComplete={() => void refreshConfig(stake.stakeId)}
    />
  );
}
