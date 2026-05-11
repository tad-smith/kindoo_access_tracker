// Tablet icons-only rail. 64px wide, fixed-position column to the
// left of `<main>`. Three interaction patterns (per Phase 10.1
// follow-up #3):
//
//   1. Tap an icon (link or action) → directly navigates / runs the
//      action (sign out). No expansion step. Link items are
//      `<Link>`s so middle-click / cmd-click open in a new tab as
//      expected; action items are `<button>`s.
//   2. Tap the rail in any non-icon area → invokes `onActivate`,
//      which expands the rail (floating overlay; see `NavOverlay`).
//   3. Drag the rail rightward past 32px → invokes `onActivate`. The
//      drag works for both touch and pointer (mouse).
//
// Section headers (including the new "Account" section) are replaced
// with a horizontal divider plus a height-preserving spacer per
// `docs/navigation-redesign.md` §14, so nav-item Y-coordinates align
// with the desktop rail. Active state for link items: vertical-bar
// + tint treatment as desktop. Action items don't carry active state.
//
// The foot below the rail body holds only the version stamp now;
// Logout moved into the Account section per Phase 10.1 follow-up #4.

import { useRef } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { navSectionsForPrincipal, type NavItem, type NavSection } from './navModel';
import type { Principal } from '../../lib/principal';

/** Horizontal drag distance that triggers expansion. */
const DRAG_THRESHOLD_PX = 32;

interface IconRailProps {
  principal: Principal;
  /** Open the expanded floating rail (called by tap-on-gap and drag-past-threshold). */
  onActivate: () => void;
  /** Sign-out side-effect for action items. */
  onSignOut: () => void;
  signingOut: boolean;
  version: string;
}

export function IconRail({ principal, onActivate, onSignOut, signingOut, version }: IconRailProps) {
  const sections = navSectionsForPrincipal(principal);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Drag tracking. Starts on `pointerdown`, latches `expanded` when
  // the pointer moves rightward past the threshold; emits onActivate
  // exactly once per drag.
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

  // Rail-level click. Fires for any click that wasn't
  // `stopPropagation`'d by the icon items inside (i.e., gaps,
  // dividers, area below items, foot).
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
            onSignOut={onSignOut}
            signingOut={signingOut}
          />
        ))}
      </div>
      <div className="kd-icon-rail-foot">
        <span className="kd-icon-rail-version" aria-label="Build version">
          v{version}
        </span>
        {/* Stacked under the version stamp at this 64px rail width.
            stopPropagation keeps a tap on the link from bubbling to
            the rail-level onClick that opens the floating panel. */}
        <a
          href="/THIRD_PARTY_LICENSES.txt"
          target="_blank"
          rel="noopener noreferrer"
          className="kd-icon-rail-licenses-link kd-nav-licenses-link"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          Licenses
        </a>
      </div>
    </aside>
  );
}

interface IconRailSectionProps {
  section: NavSection;
  isFirst: boolean;
  pathname: string;
  onSignOut: () => void;
  signingOut: boolean;
}

function IconRailSection({
  section,
  isFirst,
  pathname,
  onSignOut,
  signingOut,
}: IconRailSectionProps) {
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
            item={item}
            isActive={item.kind === 'link' && pathname === item.to}
            onSignOut={onSignOut}
            signingOut={signingOut}
          />
        ))}
      </ul>
    </div>
  );
}

interface IconRailItemProps {
  item: NavItem;
  isActive: boolean;
  onSignOut: () => void;
  signingOut: boolean;
}

function IconRailItem({ item, isActive, onSignOut, signingOut }: IconRailItemProps) {
  const Icon = item.icon;
  if (item.kind === 'link') {
    return (
      <li>
        <Link
          to={item.to}
          className={`kd-icon-rail-link${isActive ? ' active' : ''}`}
          title={item.label}
          aria-label={item.label}
          aria-current={isActive ? 'page' : undefined}
          onClick={(e) => {
            // Direct icon taps go straight to navigation; don't bubble
            // to the rail's open-panel handler.
            e.stopPropagation();
          }}
        >
          <Icon size={22} aria-hidden="true" />
        </Link>
      </li>
    );
  }
  // Action item — currently only `sign-out`.
  const busy = item.action === 'sign-out' && signingOut;
  return (
    <li>
      <button
        type="button"
        className="kd-icon-rail-link kd-icon-rail-action"
        title={busy ? 'Signing out…' : item.label}
        aria-label={busy ? 'Signing out' : item.label}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          if (item.action === 'sign-out') onSignOut();
        }}
      >
        <Icon size={22} aria-hidden="true" />
      </button>
    </li>
  );
}
