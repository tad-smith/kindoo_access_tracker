// Tablet icons-only rail. Fixed 64px wide. Section headers are
// replaced with a horizontal divider plus a spacer matching the
// desktop section header's height so individual nav items sit at the
// same Y-coordinate across desktop / tablet (per
// `docs/navigation-redesign.md` §14).
//
// Tap → invokes `onIconActivate` so the parent can open the floating
// panel. Hover surfaces the `<title>`-attribute tooltip with the label
// (mouse-only; touch devices skip the tooltip and go straight to the
// panel).
//
// Active item gets the same vertical-bar + tint treatment as the
// desktop rail.

import { useRouterState } from '@tanstack/react-router';
import { LogOut, type LucideIcon } from 'lucide-react';
import { navSectionsForPrincipal, type NavSection } from './navModel';
import type { Principal } from '../../lib/principal';

interface IconRailProps {
  principal: Principal;
  /** Called with no args when the user taps an icon (no specific item — the rail just opens the panel). */
  onActivate: () => void;
  /** Called when the user clicks the logout icon at the foot. */
  onSignOut: () => void;
  signingOut: boolean;
  version: string;
}

export function IconRail({ principal, onActivate, onSignOut, signingOut, version }: IconRailProps) {
  const sections = navSectionsForPrincipal(principal);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <aside className="kd-icon-rail" aria-label="Primary navigation (icons)">
      <div className="kd-icon-rail-scroll">
        {sections.map((section, idx) => (
          <IconRailSection
            key={section.key}
            section={section}
            isFirst={idx === 0}
            pathname={pathname}
            onActivate={onActivate}
          />
        ))}
      </div>
      <div className="kd-icon-rail-foot">
        <button
          type="button"
          className="kd-icon-rail-logout"
          onClick={onSignOut}
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
  onActivate: () => void;
}

function IconRailSection({ section, isFirst, pathname, onActivate }: IconRailSectionProps) {
  return (
    <div className={`kd-icon-rail-section${isFirst ? ' is-first' : ''}`}>
      {/* Divider + height-preserving gap stand in for the section header.
          Hidden from a11y tree because the floating panel exposes the
          header proper. */}
      <div className="kd-icon-rail-divider" aria-hidden="true" />
      <ul className="kd-icon-rail-list">
        {section.items.map((item) => (
          <IconRailItem
            key={item.key}
            label={item.label}
            icon={item.icon}
            isActive={pathname === item.to}
            onActivate={onActivate}
          />
        ))}
      </ul>
    </div>
  );
}

interface IconRailItemProps {
  label: string;
  icon: LucideIcon;
  isActive: boolean;
  onActivate: () => void;
}

function IconRailItem({ label, icon: Icon, isActive, onActivate }: IconRailItemProps) {
  return (
    <li>
      <button
        type="button"
        className={`kd-icon-rail-link${isActive ? ' active' : ''}`}
        title={label}
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        onClick={onActivate}
      >
        <Icon size={22} aria-hidden="true" />
      </button>
    </li>
  );
}
