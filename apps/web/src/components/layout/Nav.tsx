// Role-aware nav. Generates the link set from the active principal's
// claims per the page map in `docs/spec.md` §5.
//
// Apps Script reality (until Phase 11):
//   - Bishopric: Roster (own ward), New Kindoo Request, My Requests
//   - Stake:     Roster, New Kindoo Request, My Requests, Ward Rosters
//   - Manager:   Dashboard, Requests Queue, All Seats, Configuration,
//                Access, Import, Audit Log
//
// Phase 4 surfaces all the links a role *will* have once Phase 5–7 ship
// the pages. Routes that don't yet exist render as `<span>` placeholders
// styled like a disabled link so the visual structure reads correctly
// during incremental phase delivery (and the e2e Nav test exercises the
// label set rather than the active link state).
//
// "Highest-role priority" mirrors `Router_defaultPageFor_` from the
// Apps Script Router: manager > stake > bishopric. Multi-role users
// see the union of links (manager + stake + bishopric all visible).

import { Link, useRouterState } from '@tanstack/react-router';
import type { Principal } from '../../lib/principal';
import { STAKE_ID } from '../../lib/constants';
import './Nav.css';

interface NavLinkSpec {
  key: string;
  label: string;
  /** Matches a route path. `undefined` renders a disabled placeholder. */
  to?: string;
}

function managerLinks(): NavLinkSpec[] {
  return [
    { key: 'mgr/dashboard', label: 'Dashboard', to: '/manager/dashboard' },
    { key: 'mgr/queue', label: 'Requests Queue', to: '/manager/queue' },
    { key: 'mgr/seats', label: 'All Seats', to: '/manager/seats' },
    { key: 'mgr/config', label: 'Configuration', to: '/manager/config' },
    { key: 'mgr/access', label: 'Access', to: '/manager/access' },
    { key: 'mgr/import', label: 'Import', to: '/manager/import' },
    { key: 'mgr/audit', label: 'Audit Log', to: '/manager/audit' },
  ];
}

function stakeLinks(): NavLinkSpec[] {
  return [
    { key: 'stake/roster', label: 'Roster', to: '/stake/roster' },
    { key: 'new', label: 'New Kindoo Request', to: '/stake/new' },
    { key: 'myreq', label: 'My Requests', to: '/myrequests' },
    { key: 'stake/wards', label: 'Ward Rosters', to: '/stake/wards' },
  ];
}

function bishopricLinks(): NavLinkSpec[] {
  return [
    { key: 'bish/roster', label: 'Roster', to: '/bishopric/roster' },
    { key: 'bish/new', label: 'New Kindoo Request', to: '/bishopric/new' },
    { key: 'bish/myreq', label: 'My Requests', to: '/myrequests' },
  ];
}

/** Build the link list for a principal in priority-merge order. */
export function navLinksForPrincipal(principal: Principal): NavLinkSpec[] {
  const out: NavLinkSpec[] = [];
  const seen = new Set<string>();
  const push = (links: NavLinkSpec[]) => {
    for (const link of links) {
      if (seen.has(link.key)) continue;
      seen.add(link.key);
      out.push(link);
    }
  };

  if (principal.managerStakes.includes(STAKE_ID)) {
    push(managerLinks());
  }
  if (principal.stakeMemberStakes.includes(STAKE_ID)) {
    push(stakeLinks());
  }
  const wards = principal.bishopricWards[STAKE_ID];
  if (Array.isArray(wards) && wards.length > 0) {
    push(bishopricLinks());
  }

  return out;
}

interface NavProps {
  principal: Principal;
}

export function Nav({ principal }: NavProps) {
  const links = navLinksForPrincipal(principal);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (links.length === 0) return null;

  return (
    <nav className="kd-nav" aria-label="Primary">
      <ul>
        {links.map((link) => {
          const isActive = link.to !== undefined && pathname === link.to;
          if (link.to === undefined) {
            return (
              <li key={link.key}>
                <span className="kd-nav-link kd-nav-disabled" aria-disabled="true">
                  {link.label}
                </span>
              </li>
            );
          }
          return (
            <li key={link.key}>
              <Link
                to={link.to}
                className={`kd-nav-link${isActive ? ' active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
