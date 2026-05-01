// Persistent app shell. Brand bar (always visible) + breakpoint-gated
// nav surfaces + content slot. The shell stays mounted across route
// transitions; TanStack Router's `<Outlet />` swaps the page below.
//
// Layout per breakpoint (per `docs/navigation-redesign.md` §5–§7):
//   - Phone (<640px): brand bar shows hamburger + brand icon + stake
//     name. Content fills the viewport. A drawer slides in from the
//     left when the hamburger is tapped; the drawer carries the full
//     nav + email + sign-out + version stamp.
//   - Tablet (640–1023px): brand bar shows brand icon + stake name +
//     user email. A 64px icons-only rail sits below the brand bar.
//     Tapping an icon opens a floating panel with the full nav.
//   - Desktop (>=1024px): brand bar same as tablet. A 240–280px wide
//     rail with full text labels lives below the brand bar; logout +
//     version pinned to the rail's foot.
//
// Brand text. Authenticated principals see their stake's `stake_name`
// (live from `stakes/{STAKE_ID}`). The product name "Stake Building
// Access" is the fallback while the stake doc loads.

import { useEffect, useState, type ReactNode } from 'react';
import { Menu, X } from 'lucide-react';
import { signOut } from '../../features/auth/signOut';
import { usePrincipal } from '../../lib/principal';
import { KINDOO_WEB_VERSION } from '../../version';
import { useFirestoreDoc } from '../../lib/data';
import { stakeRef } from '../../lib/docs';
import { db } from '../../lib/firebase';
import { STAKE_ID } from '../../lib/constants';
import { useOnlineStatus } from '../../lib/pwa/useOnlineStatus';
import { useBreakpoint } from '../../lib/useBreakpoint';
import { BrandIcon } from './BrandIcon';
import { PwaInstallButton } from './PwaInstallButton';
import { LeftRail } from './LeftRail';
import { IconRail } from './IconRail';
import { NavOverlay } from './NavOverlay';
import { ToastHost } from '../ui/Toast';
import './Shell.css';

const PRODUCT_NAME = 'Stake Building Access';

interface ShellProps {
  children: ReactNode;
}

export function Shell({ children }: ShellProps) {
  const principal = usePrincipal();
  const [signingOut, setSigningOut] = useState(false);
  const online = useOnlineStatus();
  const breakpoint = useBreakpoint();

  // Drawer (phone) and panel (tablet) open-state. Both are kept
  // separate so they don't share state across breakpoints — a single
  // boolean would survive a phone→tablet crossing as the panel.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  // Crossing a breakpoint closes any open nav UI per §13.
  useEffect(() => {
    setDrawerOpen(false);
    setPanelOpen(false);
  }, [breakpoint]);

  const version = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? KINDOO_WEB_VERSION;

  const stakeDocResult = useFirestoreDoc(principal.isAuthenticated ? stakeRef(db, STAKE_ID) : null);
  const brandText =
    principal.isAuthenticated && stakeDocResult.data?.stake_name
      ? stakeDocResult.data.stake_name
      : PRODUCT_NAME;

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  // Closing the drawer / panel after a nav-item tap. Same handler
  // either way — only one is open at a time given the breakpoint
  // scoping above.
  function handleNavigate() {
    setDrawerOpen(false);
    setPanelOpen(false);
  }

  const showHamburger = principal.isAuthenticated && breakpoint === 'phone';
  const showEmailInBar = principal.isAuthenticated && breakpoint !== 'phone';

  return (
    <div className="kd-shell" data-breakpoint={breakpoint}>
      <header className="kd-brandbar">
        <div className="kd-brandbar-inner">
          <div className="kd-brandbar-left">
            {showHamburger ? (
              <button
                type="button"
                className="kd-brandbar-hamburger"
                aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
                aria-expanded={drawerOpen}
                onClick={() => {
                  setDrawerOpen((v) => !v);
                }}
              >
                {drawerOpen ? (
                  <X size={22} aria-hidden="true" />
                ) : (
                  <Menu size={22} aria-hidden="true" />
                )}
              </button>
            ) : null}
            <div className="kd-brandbar-brand">
              <BrandIcon size={28} />
              <strong className="kd-brandbar-stake">{brandText}</strong>
            </div>
          </div>
          <div className="kd-brandbar-meta">
            {!online ? (
              <span
                className="kd-brandbar-offline"
                role="status"
                aria-live="polite"
                data-testid="offline-indicator"
              >
                Offline
              </span>
            ) : null}
            <div className="kd-brandbar-stake-slot" data-testid="stake-selector-slot">
              {/* Phase 12 stake selector lands here. Empty in v1. */}
            </div>
            {showEmailInBar ? (
              <span className="kd-brandbar-email" title={principal.email}>
                {principal.email}
              </span>
            ) : null}
            {principal.isAuthenticated ? <PwaInstallButton /> : null}
          </div>
        </div>
      </header>

      <div className="kd-shell-body">
        {principal.isAuthenticated && breakpoint === 'desktop' ? (
          <LeftRail
            principal={principal}
            signingOut={signingOut}
            version={version}
            onSignOut={handleSignOut}
          />
        ) : null}
        {principal.isAuthenticated && breakpoint === 'tablet' ? (
          <IconRail
            principal={principal}
            onActivate={() => {
              setPanelOpen((v) => !v);
            }}
            onSignOut={handleSignOut}
            signingOut={signingOut}
            version={version}
          />
        ) : null}

        <main className="kd-main">{children}</main>
      </div>

      {/* Tablet floating panel (full nav). */}
      {principal.isAuthenticated && breakpoint === 'tablet' ? (
        <NavOverlay
          open={panelOpen}
          variant="panel"
          principal={principal}
          email={principal.email}
          version={version}
          signingOut={signingOut}
          onDismiss={() => setPanelOpen(false)}
          onSignOut={handleSignOut}
          onNavigate={handleNavigate}
        />
      ) : null}

      {/* Phone drawer. */}
      {principal.isAuthenticated && breakpoint === 'phone' ? (
        <NavOverlay
          open={drawerOpen}
          variant="drawer"
          principal={principal}
          email={principal.email}
          version={version}
          signingOut={signingOut}
          onDismiss={() => setDrawerOpen(false)}
          onSignOut={handleSignOut}
          onNavigate={handleNavigate}
        />
      ) : null}

      <ToastHost />
    </div>
  );
}
