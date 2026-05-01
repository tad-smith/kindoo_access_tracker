// Dismissible overlay that hosts the full sectioned `<Nav>` plus a
// footer (sign-out + version stamp; optionally the user email on
// phone). Powers two surfaces:
//
//   - Tablet floating panel (`variant="panel"`): anchored to the left
//     rail, narrow (~280px), backdrop covers the rest of the viewport.
//     No user email — the brand bar already shows it on tablet.
//   - Phone drawer (`variant="drawer"`): slides from the left edge,
//     fixed width (~300px), backdrop covers everything to the right.
//     Footer carries email + logout + version.
//
// Dismissal handlers (per `docs/navigation-redesign.md` §6 + §7):
//   - Tap a nav item   → `onNavigate` (parent closes).
//   - Tap the backdrop → `onDismiss`.
//   - Press Escape     → `onDismiss`.
// Tablet's "tap the icon that opened the panel" toggle is handled by
// the parent (`Shell`) flipping the `open` flag back to false.

import { useEffect, useRef, useId } from 'react';
import { LogOut } from 'lucide-react';
import { Nav } from './Nav';
import type { Principal } from '../../lib/principal';

interface NavOverlayProps {
  open: boolean;
  variant: 'panel' | 'drawer';
  principal: Principal;
  email: string;
  version: string;
  signingOut: boolean;
  onDismiss: () => void;
  onSignOut: () => void;
  onNavigate: () => void;
}

export function NavOverlay({
  open,
  variant,
  principal,
  email,
  version,
  signingOut,
  onDismiss,
  onSignOut,
  onNavigate,
}: NavOverlayProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [open, onDismiss]);

  // When opening, move focus into the panel for keyboard users.
  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const className =
    variant === 'panel'
      ? 'kd-nav-overlay kd-nav-overlay-panel'
      : 'kd-nav-overlay kd-nav-overlay-drawer';

  return (
    <div className={`${className} is-open`}>
      <div
        className="kd-nav-overlay-backdrop"
        data-testid="nav-overlay-backdrop"
        onClick={onDismiss}
        aria-hidden="true"
      />
      <div
        className="kd-nav-overlay-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        ref={panelRef}
        tabIndex={-1}
      >
        <h2 id={labelId} className="kd-visually-hidden">
          Navigation
        </h2>
        <div className="kd-nav-overlay-scroll">
          <Nav principal={principal} onNavigate={onNavigate} ariaLabel="Primary" />
        </div>
        <div className="kd-nav-overlay-foot">
          {variant === 'drawer' && email ? (
            <div className="kd-nav-overlay-email" title={email}>
              {email}
            </div>
          ) : null}
          <button type="button" className="kd-nav-logout" onClick={onSignOut} disabled={signingOut}>
            <LogOut size={18} aria-hidden="true" />
            <span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
          </button>
          <span className="kd-nav-version" aria-label="Build version">
            v{version}
          </span>
        </div>
      </div>
    </div>
  );
}
