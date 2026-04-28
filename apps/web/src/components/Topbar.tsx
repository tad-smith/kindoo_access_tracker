// Light persistent shell rendered above the route outlet.
//
// Phase 2 ships the bare minimum: app name + signed-in email + sign-out
// button + version stamp. Phase 4 grows this into the real shell with
// nav tabs, role-aware menu, etc.
//
// Uses `usePrincipal()` to decide whether to render the email + sign-out
// pair. Unauthenticated visitors see only the app name + version (the
// SignInPage itself shows the call-to-action).

import { useState } from 'react';
import { signOut } from '../features/auth/signOut';
import { usePrincipal } from '../lib/principal';
import { KINDOO_WEB_VERSION } from '../version';

export function Topbar() {
  const principal = usePrincipal();
  const [signingOut, setSigningOut] = useState(false);

  const version = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? KINDOO_WEB_VERSION;

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.5rem 1rem',
        borderBottom: '1px solid #ddd',
        gap: '0.5rem',
      }}
    >
      <strong>Kindoo</strong>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        {principal.isAuthenticated ? (
          <>
            <span style={{ fontSize: '0.9rem' }}>{principal.email}</span>
            <button type="button" onClick={handleSignOut} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </>
        ) : null}
        <span style={{ fontSize: '0.75rem', color: '#666' }} aria-label="Build version">
          v{version}
        </span>
      </div>
    </header>
  );
}
