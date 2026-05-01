// Dismissible overlay that hosts the full sectioned `<Nav>` plus a
// minimal footer. Powers two surfaces:
//
//   - Tablet expanded rail (`variant="panel"`): anchored to the left
//     viewport edge (x=0), 248px wide. Visually replaces the 64px
//     icons rail when open — the icons rail stays rendered beneath
//     and reappears on dismiss. Backdrop covers the rest of the
//     viewport. Footer: version stamp only.
//   - Phone drawer (`variant="drawer"`): slides from the left edge,
//     fixed width (~300px), backdrop covers everything to the right.
//     The user email renders inside the Account section just below
//     the Logout item; the drawer footer holds only the version
//     stamp.
//
// Logout lives inside the nav body now (Account section, per
// Phase 10.1 follow-up #4). The Nav renders the action item as a
// `<button>` and runs `onSignOut` on click.
//
// Dismissal handlers (per `docs/navigation-redesign.md` §6 + §7):
//   - Tap a nav item / action → `onNavigate` (parent closes).
//   - Tap the backdrop        → `onDismiss`.
//   - Press Escape            → `onDismiss`.

import { useEffect, useRef, useId } from 'react';
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

  // Flex container click = backdrop click. Any tap that doesn't land
  // on the surface (which stops propagation) dismisses.
  return (
    <div className={`${className} is-open`} onClick={onDismiss}>
      <div
        className="kd-nav-overlay-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2 id={labelId} className="kd-visually-hidden">
          Navigation
        </h2>
        <div className="kd-nav-overlay-scroll">
          <Nav
            principal={principal}
            onNavigate={onNavigate}
            onSignOut={onSignOut}
            signingOut={signingOut}
            ariaLabel="Primary"
            userEmail={variant === 'drawer' ? email : undefined}
          />
        </div>
        <div className="kd-nav-overlay-foot">
          <span className="kd-nav-version" aria-label="Build version">
            v{version}
          </span>
        </div>
      </div>
      <div
        className="kd-nav-overlay-backdrop"
        data-testid="nav-overlay-backdrop"
        aria-hidden="true"
      />
    </div>
  );
}
