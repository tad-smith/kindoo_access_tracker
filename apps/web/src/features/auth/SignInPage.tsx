// Sign-in landing page. Shown to anyone visiting the app while signed
// out. Renders a single "Sign in with Google" button that drives the
// Firebase Auth popup flow (`signIn()` from `./signIn.ts`).
//
// Phase 2 keeps the styling intentionally bare — no Tailwind, no
// shadcn-ui yet (those land in Phase 4). The layout is a centred
// full-viewport flex container so it reads acceptably on mobile (375px)
// and desktop until the design system arrives.

import { useState } from 'react';
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
      <button type="button" onClick={handleClick} disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in with Google'}
      </button>
      {error ? (
        <div role="alert" style={{ color: '#a40000', maxWidth: '40ch', textAlign: 'center' }}>
          Sign-in failed: {error}
        </div>
      ) : null}
    </main>
  );
}
