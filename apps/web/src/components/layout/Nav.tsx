// Sectioned nav. Renders a vertical list of section headers + nav
// items. Used as the body of:
//   - Desktop: persistent left rail (full labels visible).
//   - Tablet:  floating overlay panel (full labels, opened from the
//              icons-only rail).
//   - Phone:   slide-in drawer (full labels).
//
// Items come in two kinds (per `navModel.ts`):
//   - `kind: 'link'` — renders as a TanStack `<Link>`. Standard
//     navigation; `aria-current="page"` when active.
//   - `kind: 'action'` — renders as a `<button>` that runs a side
//     effect (currently just `sign-out`). No active state.
//
// The icons-only tablet rail uses a separate `<IconRail>` component;
// see `IconRail.tsx`.

import { Link, useRouterState } from '@tanstack/react-router';
import type { Principal } from '../../lib/principal';
import { navSectionsForPrincipal, type NavItem, type NavSection } from './navModel';
import './Nav.css';

export { navSectionsForPrincipal, wardRosterPathFor } from './navModel';
export type { NavItem, NavSection, NavLinkItem, NavActionItem } from './navModel';

interface NavProps {
  principal: Principal;
  /** Called when a nav item is activated (link click or action click). */
  onNavigate?: () => void;
  /** Called when an action item with `action: 'sign-out'` is clicked. */
  onSignOut?: () => void;
  signingOut?: boolean;
  /** ARIA label for the nav landmark. */
  ariaLabel?: string;
}

export function Nav({
  principal,
  onNavigate,
  onSignOut,
  signingOut = false,
  ariaLabel = 'Primary',
}: NavProps) {
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
          onSignOut={onSignOut}
          signingOut={signingOut}
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
  onSignOut: (() => void) | undefined;
  signingOut: boolean;
}

function NavSectionRender({
  section,
  isFirst,
  pathname,
  onNavigate,
  onSignOut,
  signingOut,
}: NavSectionRenderProps) {
  return (
    <div
      className={`kd-nav-section${isFirst ? ' is-first' : ''}`}
      aria-labelledby={`kd-nav-header-${section.key}`}
    >
      <h2 id={`kd-nav-header-${section.key}`} className="kd-nav-section-header">
        {section.label}
      </h2>
      <ul className="kd-nav-list">
        {section.items.map((item) => (
          <li key={item.key}>
            <NavItemRender
              item={item}
              pathname={pathname}
              onNavigate={onNavigate}
              onSignOut={onSignOut}
              signingOut={signingOut}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface NavItemRenderProps {
  item: NavItem;
  pathname: string;
  onNavigate: (() => void) | undefined;
  onSignOut: (() => void) | undefined;
  signingOut: boolean;
}

function NavItemRender({ item, pathname, onNavigate, onSignOut, signingOut }: NavItemRenderProps) {
  const Icon = item.icon;
  if (item.kind === 'link') {
    const isActive = pathname === item.to;
    return (
      <Link
        to={item.to}
        className={`kd-nav-link${isActive ? ' active' : ''}`}
        aria-current={isActive ? 'page' : undefined}
        onClick={onNavigate}
      >
        <Icon className="kd-nav-icon" size={20} aria-hidden="true" />
        <span className="kd-nav-label">{item.label}</span>
      </Link>
    );
  }
  // Action item — currently only `sign-out`.
  const handleClick = () => {
    if (item.action === 'sign-out') {
      onSignOut?.();
      onNavigate?.();
    }
  };
  const busy = item.action === 'sign-out' && signingOut;
  return (
    <button
      type="button"
      className="kd-nav-link kd-nav-action"
      onClick={handleClick}
      disabled={busy}
    >
      <Icon className="kd-nav-icon" size={20} aria-hidden="true" />
      <span className="kd-nav-label">{busy ? 'Signing out…' : item.label}</span>
    </button>
  );
}
