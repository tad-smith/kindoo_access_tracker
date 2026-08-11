// Signed-out view. Offers both sign-in paths — Google via
// chrome.identity, and a handoff to the SPA for everything else
// (magic link included), which is the only path open to a manager
// with no Google account. The inline `consent_dismissed` message is
// worded per path; see `dismissedCopy` for why the two differ.

import { useState } from 'react';
import { ExtensionApiError, signIn, signInViaWeb } from '../lib/extensionApi';

interface SignedOutPanelProps {
  onSignedIn?: () => void;
}

type SignInPath = 'google' | 'web';

/** Which button is mid-flight; both are disabled while either runs. */
type PendingPath = SignInPath | null;

/**
 * `consent_dismissed` means different things on the two paths, so the
 * copy does too.
 *
 * Google: Chrome's own consent dialog has no failure state to explain,
 * so a dismissal really is a dismissal and retry is the right nudge.
 *
 * Web: Chrome reports a manager who closed the window and a handoff the
 * SPA refused with the identical bare `lastError` — there is nothing
 * here to branch on. So this must not assert that a cancellation
 * happened, and must not promise a retry will work. The SPA renders the
 * refusal reason inside the auth window, and by the time this copy
 * shows, that window is gone — so wording that ordered a retry would
 * overwrite the one explanation the manager was given, and send them
 * looping on the single action that cannot succeed.
 *
 * "configuration error" is shared wording with the SPA's refusal card,
 * which names the same phrase. The rest of this sentence is free to
 * change; that phrase is not, because it is what the manager scans the
 * card for. Both sides pin it with a test.
 */
function dismissedCopy(path: SignInPath): string {
  if (path === 'google') return 'Sign-in cancelled. Click again to retry.';
  return (
    'Sign-in didn’t finish. Click again to retry — unless that window showed a ' +
    'configuration error, in which case retrying won’t help.'
  );
}

export function SignedOutPanel({ onSignedIn }: SignedOutPanelProps) {
  const [pending, setPending] = useState<PendingPath>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(path: SignInPath, start: () => Promise<unknown>) {
    setPending(path);
    setError(null);
    try {
      await start();
      onSignedIn?.();
    } catch (err) {
      if (err instanceof ExtensionApiError && err.code === 'consent_dismissed') {
        setError(dismissedCopy(path));
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
