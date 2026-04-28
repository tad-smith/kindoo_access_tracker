// Persistent app shell. Topbar (brand + email + version + sign-out) +
// Nav + content slot. Stable across navigation — TanStack Router's
// `<Outlet />` renders the matched route into the content area.
//
// Replaces Phase-2's `components/Topbar.tsx` + bare `<RouterProvider>`
// composition. The Topbar code path here is a superset of the Phase-2
// component: same email + version + sign-out trio, plus a Nav layer
// below for role-aware page links and a stake-selector slot reserved
// for Phase 12.
//
// Stake selector (Phase 12). A placeholder slot exists in the topbar
// so Phase 12 can drop the multi-stake `<StakeSelector />` in without
// reflowing siblings. v1 single-stake users see the slot empty.

import { useState, type ReactNode } from 'react';
import { signOut } from '../../features/auth/signOut';
import { usePrincipal } from '../../lib/principal';
import { KINDOO_WEB_VERSION } from '../../version';
import { Nav } from './Nav';
import { ToastHost } from '../ui/Toast';
import './Shell.css';

interface ShellProps {
  children: ReactNode;
}

export function Shell({ children }: ShellProps) {
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
    <div className="kd-shell">
      <header className="kd-topbar">
        <div className="kd-topbar-inner">
          <div className="kd-topbar-brand">
            <strong>Kindoo</strong>
          </div>
          <div className="kd-topbar-meta">
            <div className="kd-topbar-stake-slot" data-testid="stake-selector-slot">
              {/* Phase 12 stake selector lands here. Empty in v1. */}
            </div>
            {principal.isAuthenticated ? (
              <>
                <span className="kd-topbar-email" title={principal.email}>
                  {principal.email}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleSignOut}
                  disabled={signingOut}
                >
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </>
            ) : null}
            <span className="kd-topbar-version" aria-label="Build version">
              v{version}
            </span>
          </div>
        </div>
      </header>
      {principal.isAuthenticated ? <Nav principal={principal} /> : null}
      <main className="kd-main">{children}</main>
      <ToastHost />
    </div>
  );
}
