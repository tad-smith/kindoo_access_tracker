// Signed-out view. Shows the sign-in button and renders a friendly
// inline message when the user dismisses the Chrome consent dialog
// (the `consent_dismissed` AuthError code).

import { useState } from 'react';
import { ExtensionApiError, signIn } from '../lib/extensionApi';

interface SignedOutPanelProps {
  onSignedIn?: () => void;
}

export function SignedOutPanel({ onSignedIn }: SignedOutPanelProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setPending(true);
    setError(null);
    try {
      await signIn();
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
      setPending(false);
    }
  }

  return (
    <main className="sba-panel" data-testid="sba-signed-out">
      <header className="sba-header">
        <h1>Stake Building Access</h1>
      </header>
      <div className="sba-body sba-body-center">
        <p>Sign in with your Kindoo Manager Google account to see pending requests.</p>
        <button
          type="button"
          className="sba-btn sba-btn-primary"
          onClick={handleSignIn}
          disabled={pending}
          data-testid="sba-sign-in"
        >
          {pending ? 'Signing in…' : 'Sign in with Google'}
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
