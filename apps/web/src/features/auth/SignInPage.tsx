// Sign-in landing page. Shown to anyone visiting the app while signed
// out. Renders a single "Sign in with Google" button that drives the
// Firebase Auth popup flow (`signIn()` from `./signIn.ts`).
//
// Phase 2 originally shipped a bare `<button>` with no styling. Phase 5
// (T-18) added Tailwind v4 + its preflight reset, which silently
// stripped the browser-default button chrome (background, border,
// padding) — leaving "Sign in with Google" rendered as plain text. The
// rest of Phase 5 routed past the SignInPage on auth'd users so the
// regression slipped past manual review. Fixed here by consuming the
// shadcn `<Button>` primitive (variant="default" → `.btn` class from
// `base.css`), matching the rest of the app's design system. See the
// Playwright regression spec at
// `e2e/tests/auth/sign-in-button-renders.spec.ts`.

import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { signIn } from './signIn';

export function SignInPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setError(null);
    setPending(true);
    try {
      await signIn();
    } catch (err) {
      // `signInWithPopup` rejects with `FirebaseError` for popup-blocked,
      // user-cancelled, network failure, etc. We surface the message
      // verbatim so the operator can debug without opening devtools.
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        gap: '1rem',
      }}
    >
      <h1>Kindoo Access Tracker</h1>
      <p>Sign in to manage building access for your stake.</p>
      <Button onClick={handleClick} disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in with Google'}
      </Button>
      {error ? (
        <div role="alert" style={{ color: '#a40000', maxWidth: '40ch', textAlign: 'center' }}>
          Sign-in failed: {error}
        </div>
      ) : null}
    </main>
  );
}
