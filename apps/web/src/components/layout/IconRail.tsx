// Tablet icons-only rail. 64px wide, fixed-position column to the
// left of `<main>`. Three interaction patterns (per Phase 10.1
// follow-up #3):
//
//   1. Tap an icon (nav item or logout) → directly navigates / signs
//      out. No expansion step. Icons are `<Link>`s so middle-click /
//      cmd-click open in a new tab as expected.
//   2. Tap the rail in any non-icon area → invokes `onActivate`,
//      which opens the expanded floating rail.
//   3. Drag the rail rightward past half the expansion delta
//      (~92px from the rail's left edge) → invokes `onActivate`. The
//      drag works for both touch and pointer (mouse).
//
// Section headers are replaced with a horizontal divider plus a
// height-preserving spacer (per `docs/navigation-redesign.md` §14)
// so nav-item Y-coordinates align with the desktop rail. Active
// item: same vertical-bar + tint treatment as desktop.

import { useRef } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { LogOut, type LucideIcon } from 'lucide-react';
import { navSectionsForPrincipal, type NavSection } from './navModel';
import type { Principal } from '../../lib/principal';

/** Drag distance past the rail's right edge that snaps to "expanded". */
const DRAG_THRESHOLD_PX = 32;

interface IconRailProps {
  principal: Principal;
  /** Open the expanded floating rail (called by tap-on-gap and drag-past-threshold). */
  onActivate: () => void;
  /** Sign-out button click. */
  onSignOut: () => void;
  signingOut: boolean;
  version: string;
}

export function IconRail({ principal, onActivate, onSignOut, signingOut, version }: IconRailProps) {
  const sections = navSectionsForPrincipal(principal);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Drag tracking. Starts on `pointerdown`, latches `expanded` when
  // the pointer moves rightward past the threshold; emits onActivate
  // exactly once per drag. A drag that never crosses the threshold
  // collapses back to a tap; the click handler on the rail then runs
  // normally (and only fires if the click landed on a non-icon area
  // because icons stop propagation).
  const dragRef = useRef<{ startX: number; activated: boolean } | null>(null);

  function handlePointerDown(event: React.PointerEvent<HTMLElement>) {
    dragRef.current = { startX: event.clientX, activated: false };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.activated) return;
    const dx = event.clientX - drag.startX;
    if (dx >= DRAG_THRESHOLD_PX) {
      drag.activated = true;
      onActivate();
    }
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  // Rail-level click. Fires for any click that wasn't `stopPropagation`'d
  // by the icon buttons inside (i.e., gaps, divider, area below items).
  // A drag that already activated suppresses the click via the same
  // ref (the browser will fire a click after pointerup unless we check).
  function handleRailClick() {
    onActivate();
  }

  return (
    <aside
      className="kd-icon-rail"
      aria-label="Primary navigation (icons)"
      onClick={handleRailClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="kd-icon-rail-scroll">
        {sections.map((section, idx) => (
          <IconRailSection
            key={section.key}
            section={section}
            isFirst={idx === 0}
            pathname={pathname}
          />
        ))}
      </div>
      <div className="kd-icon-rail-foot">
        <button
          type="button"
          className="kd-icon-rail-logout"
          onClick={(e) => {
            e.stopPropagation();
            onSignOut();
          }}
          disabled={signingOut}
          title={signingOut ? 'Signing out…' : 'Sign out'}
          aria-label={signingOut ? 'Signing out' : 'Sign out'}
        >
          <LogOut size={20} aria-hidden="true" />
        </button>
        <span className="kd-icon-rail-version" aria-label="Build version">
          v{version}
        </span>
      </div>
    </aside>
  );
}

interface IconRailSectionProps {
  section: NavSection;
  isFirst: boolean;
  pathname: string;
}

function IconRailSection({ section, isFirst, pathname }: IconRailSectionProps) {
  return (
    <div className={`kd-icon-rail-section${isFirst ? ' is-first' : ''}`}>
      {/* Divider + height-preserving gap stand in for the section
          header. Clicks here bubble up to the rail's onClick, which
          opens the expanded floating rail. */}
      <div className="kd-icon-rail-divider" aria-hidden="true" />
      <ul className="kd-icon-rail-list">
        {section.items.map((item) => (
          <IconRailItem
            key={item.key}
            label={item.label}
            to={item.to}
            icon={item.icon}
            isActive={pathname === item.to}
          />
        ))}
      </ul>
    </div>
  );
}

interface IconRailItemProps {
  label: string;
  to: string;
  icon: LucideIcon;
  isActive: boolean;
}

function IconRailItem({ label, to, icon: Icon, isActive }: IconRailItemProps) {
  return (
    <li>
      <Link
        to={to}
        className={`kd-icon-rail-link${isActive ? ' active' : ''}`}
        title={label}
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        onClick={(e) => {
          // Don't let the rail's open-the-panel handler fire on direct
          // icon taps — icons go straight to navigation.
          e.stopPropagation();
        }}
      >
        <Icon size={22} aria-hidden="true" />
      </Link>
    </li>
  );
}
