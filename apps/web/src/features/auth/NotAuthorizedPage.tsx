// Shown to users who are signed in (Firebase Auth recognises them) but
// hold no role claims (`stakes[*]` empty AND `isPlatformSuperadmin` is
// false). This is the "valid token but no claims" arm of Phase 2's
// failure-mode matrix.
//
// Two common causes from spec.md:
//   1. New bishopric member, weekly LCR import hasn't run yet (the lag
//      called out in `docs/spec.md` §6 "Bishopric lag").
//   2. The sign-in email isn't matched to any stake/ward role at all —
//      typo, wrong account, or the user genuinely shouldn't have access.
//
// We give them both reasons + a sign-out button to switch accounts. The
// signed-in email is rendered prominently so support can triage from a
// screenshot — the original page omitted it, which made it impossible
// to tell which account the user actually used.
//
// Sign-out button routes through the shadcn `<Button>` primitive — same
// preflight regression as PR #12 (SignInPage). A bare `<button>` is
// zeroed by Tailwind v4's preflight reset (background, border, padding
// all collapsed) so it renders as plain text. The `<Button>` primitive
// carries the `.btn` class from `base.css`. Regression spec at
// `e2e/tests/auth/not-authorized-button-renders.spec.ts`.

import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { usePrincipal } from '../../lib/principal';
import { signOut } from './signOut';

export function NotAuthorizedPage() {
  const principal = usePrincipal();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setError(null);
    setPending(true);
    try {
      await signOut();
    } catch (err) {
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
        textAlign: 'center',
      }}
    >
      <h1>Not authorized</h1>
      {principal.email ? (
        <p style={{ maxWidth: '50ch' }}>
          You are signed in as <strong>{principal.email}</strong>.
        </p>
      ) : null}
      <p style={{ maxWidth: '50ch' }}>
        Your account isn&rsquo;t yet authorized to use Stake Building Access. Common reasons:
      </p>
      <ul
        style={{
          maxWidth: '50ch',
          textAlign: 'left',
          listStyle: 'disc',
          paddingLeft: '1.5rem',
        }}
      >
        <li>
          You&rsquo;re a newly-called bishopric member and the next weekly callings import
          hasn&rsquo;t run yet.
        </li>
        <li>The email you signed in with isn&rsquo;t matched to any stake or ward role.</li>
      </ul>
      <p style={{ maxWidth: '50ch' }}>
        Contact your stake&rsquo;s Kindoo Manager if you believe this is a mistake.
      </p>
      <Button onClick={handleSignOut} disabled={pending}>
        {pending ? 'Signing out…' : 'Sign out'}
      </Button>
      {error ? (
        <div role="alert" style={{ color: '#a40000' }}>
          Sign-out failed: {error}
        </div>
      ) : null}
    </main>
  );
}
