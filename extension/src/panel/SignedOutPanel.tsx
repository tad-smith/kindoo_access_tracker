// Signed-out view. Offers both sign-in paths — Google via
// chrome.identity, and a handoff to the SPA for everything else
// (magic link included), which is the only path open to a manager
// with no Google account. Renders a friendly inline message when the
// manager backs out of either flow (the `consent_dismissed` code).

import { useState } from 'react';
import { ExtensionApiError, signIn, signInViaWeb } from '../lib/extensionApi';

interface SignedOutPanelProps {
  onSignedIn?: () => void;
}

/** Which button is mid-flight; both are disabled while either runs. */
type PendingPath = 'google' | 'web' | null;

export function SignedOutPanel({ onSignedIn }: SignedOutPanelProps) {
  const [pending, setPending] = useState<PendingPath>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(path: Exclude<PendingPath, null>, start: () => Promise<unknown>) {
    setPending(path);
    setError(null);
    try {
      await start();
      onSignedIn?.();
    } catch (err) {
      if (err instanceof ExtensionApiError && err.code === 'consent_dismissed') {
        setError('Sign-in cancelled. Click again to retry.');
      } else if (err instanceof ExtensionApiError) {
        setError(`Sign-in failed: ${err.message}`);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Sign-in failed: ${message}`);
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="sba-panel" data-testid="sba-signed-out">
      <header className="sba-header">
        <h1>Stake Building Access</h1>
      </header>
      <div className="sba-body sba-body-center">
        <p>Sign in as a Kindoo Manager to see pending requests. Either way works.</p>
        <button
          type="button"
          className="sba-btn sba-btn-primary"
          onClick={() => void run('google', signIn)}
          disabled={pending !== null}
          data-testid="sba-sign-in"
        >
          {pending === 'google' ? 'Signing in…' : 'Sign in with Google'}
        </button>
        <button
          type="button"
          className="sba-btn"
          onClick={() => void run('web', signInViaWeb)}
          disabled={pending !== null}
          data-testid="sba-sign-in-email"
        >
          {pending === 'web' ? 'Signing in…' : 'Sign in with email'}
        </button>
        {error ? (
          <p role="alert" className="sba-error" data-testid="sba-sign-in-error">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
