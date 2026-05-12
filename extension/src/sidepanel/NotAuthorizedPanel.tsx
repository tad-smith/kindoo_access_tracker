// Signed-in-but-not-a-manager view. Shown when the callable returns
// `permission-denied`. Mirrors the SPA's NotAuthorizedPage pattern
// (B-4 era) by rendering the signed-in email prominently so the user
// can tell which Google account they used and switch if needed.

import { useState } from 'react';
import { signOut } from '../lib/auth';

interface NotAuthorizedPanelProps {
  email: string | null | undefined;
  reason?: string | null;
}

export function NotAuthorizedPanel({ email, reason }: NotAuthorizedPanelProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setPending(true);
    setError(null);
    try {
      await signOut();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Sign-out failed: ${message}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="sba-panel" data-testid="sba-not-authorized">
      <header className="sba-header">
        <h1>Not authorized</h1>
      </header>
      <div className="sba-body">
        {email ? (
          <p>
            You are signed in as <strong>{email}</strong>.
          </p>
        ) : null}
        <p>
          Your account is not a Kindoo Manager for this stake. Sign out and try a different Google
          account if you have one that is.
        </p>
        {reason ? <p className="sba-muted">{reason}</p> : null}
        <div className="sba-request-actions">
          <button
            type="button"
            className="sba-btn"
            onClick={handleSignOut}
            disabled={pending}
            data-testid="sba-sign-out"
          >
            {pending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
        {error ? (
          <p role="alert" className="sba-error">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
