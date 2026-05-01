// Sectioned nav. Renders a vertical list of section headers + nav
// items. Used as the body of:
//   - Desktop: persistent left rail (full labels visible).
//   - Tablet:  floating overlay panel (full labels, opened from the
//              icons-only rail).
//   - Phone:   slide-in drawer (full labels).
//
// The icons-only tablet rail uses a separate `<IconRail>` component;
// see `IconRail.tsx`.

import { Link, useRouterState } from '@tanstack/react-router';
import type { Principal } from '../../lib/principal';
import { navSectionsForPrincipal, type NavSection } from './navModel';
import './Nav.css';

export { navSectionsForPrincipal, wardRosterPathFor } from './navModel';
export type { NavItem, NavSection } from './navModel';

interface NavProps {
  principal: Principal;
  /** Called when a nav item is activated. Lets parents close panels / drawers. */
  onNavigate?: () => void;
  /** ARIA label for the nav landmark. */
  ariaLabel?: string;
}

export function Nav({ principal, onNavigate, ariaLabel = 'Primary' }: NavProps) {
  const sections = navSectionsForPrincipal(principal);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (sections.length === 0) return null;

  return (
    <nav className="kd-nav" aria-label={ariaLabel}>
      {sections.map((section, idx) => (
        <NavSectionRender
          key={section.key}
          section={section}
          isFirst={idx === 0}
          pathname={pathname}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

interface NavSectionRenderProps {
  section: NavSection;
  isFirst: boolean;
  pathname: string;
  onNavigate: (() => void) | undefined;
}

function NavSectionRender({ section, isFirst, pathname, onNavigate }: NavSectionRenderProps) {
  return (
    <div
      className={`kd-nav-section${isFirst ? ' is-first' : ''}`}
      aria-labelledby={`kd-nav-header-${section.key}`}
    >
      <h2 id={`kd-nav-header-${section.key}`} className="kd-nav-section-header">
        {section.label}
      </h2>
      <ul className="kd-nav-list">
        {section.items.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.to;
          return (
            <li key={item.key}>
              <Link
                to={item.to}
                className={`kd-nav-link${isActive ? ' active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                onClick={onNavigate}
              >
                <Icon className="kd-nav-icon" size={20} aria-hidden="true" />
                <span className="kd-nav-label">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
