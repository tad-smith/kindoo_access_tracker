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

/** An inline message plus how loudly to say it. */
type MessageTone = 'info' | 'error';

interface PanelMessage {
  tone: MessageTone;
  text: string;
}

/**
 * `consent_dismissed` means different things on the two paths, so the
 * copy does too.
 *
 * Google: Chrome's own consent dialog has no failure state to explain,
 * so a dismissal really is a dismissal and retry is the right nudge.
 *
 * Web: this one code is the terminus for EVERY way the flow can end
 * without a redirect, and they are not distinguishable here (see the
 * funnel comment in `lib/auth.ts`). The list now includes the feature's
 * PRIMARY journey: the manager asks for a magic link, the SPA swaps to
 * "check your email", and they close the window — which is exactly
 * right, and lands here. So this copy leads with that, and must not
 * read as a failure, must not assert a cause, and must not order a
 * bare retry:
 *   - magic-link first pass → open the email, THEN click again. A bare
 *     "click again" reopens the same form and gets them nowhere.
 *   - manager changed their mind → "then click again" covers it.
 *   - SPA refused the redirect_uri → the refusal card explained it
 *     inside the window that just closed, so retrying is pointless.
 *
 * "configuration error" is shared wording with that refusal card, which
 * names the same phrase. The rest of this sentence is free to change;
 * that phrase is not, because it is what the manager scans the card
 * for. Both sides pin it with a test.
 */
function dismissedCopy(path: SignInPath): string {
  if (path === 'google') return 'Sign-in cancelled. Click again to retry.';
  return (
    'Sign-in isn’t complete yet. If you asked for a sign-in link, open it from your ' +
    'email first. Then click again — unless that window showed a configuration ' +
    'error, in which case retrying won’t help.'
  );
}

export function SignedOutPanel({ onSignedIn }: SignedOutPanelProps) {
  const [pending, setPending] = useState<PendingPath>(null);
  const [message, setMessage] = useState<PanelMessage | null>(null);

  async function run(path: SignInPath, start: () => Promise<unknown>) {
    setPending(path);
    setMessage(null);
    try {
      await start();
      onSignedIn?.();
    } catch (err) {
      if (err instanceof ExtensionApiError && err.code === 'consent_dismissed') {
        // Not an error on either path. On Google it is a deliberate
        // choice; on web the likeliest cause is a manager mid-way
        // through the magic-link journey, doing the right thing.
        // Styling it red tells someone who just followed the
        // instructions that they broke something.
        setMessage({ tone: 'info', text: dismissedCopy(path) });
      } else if (err instanceof ExtensionApiError) {
        setMessage({ tone: 'error', text: `Sign-in failed: ${err.message}` });
      } else {
        const text = err instanceof Error ? err.message : String(err);
        setMessage({ tone: 'error', text: `Sign-in failed: ${text}` });
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
        {message ? (
          <p
            // `alert` interrupts a screen reader assertively, which is
            // right for a genuine failure and wrong for "here is your
            // next step". `status` is the polite equivalent.
            role={message.tone === 'error' ? 'alert' : 'status'}
            className={message.tone === 'error' ? 'sba-error' : 'sba-note'}
            data-testid="sba-sign-in-message"
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </main>
  );
}
