// Role-aware nav. Generates the link set from the active principal's
// claims per the page map in `docs/spec.md` §5.
//
// Manager ship-set (post-Phase-7 swap; read-only pages + admin pages):
//   - Bishopric: Roster (own ward), My Requests
//   - Stake:     Roster, Ward Rosters, My Requests
//   - Manager:   Dashboard, All Seats, Audit Log, Access, Configuration,
//                Import, My Requests
//
// The request-lifecycle phase will re-add New Kindoo Request
// (bishopric + stake) and the manager Requests Queue. Until they ship
// the corresponding nav links don't appear at all (rather than
// shipping disabled placeholders) — keeping the nav truthful about
// what works today.
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
  /** Matches a route path. */
  to: string;
}

function managerLinks(): NavLinkSpec[] {
  return [
    { key: 'mgr/dashboard', label: 'Dashboard', to: '/manager/dashboard' },
    { key: 'mgr/seats', label: 'All Seats', to: '/manager/seats' },
    { key: 'mgr/audit', label: 'Audit Log', to: '/manager/audit' },
    { key: 'mgr/access', label: 'Access', to: '/manager/access' },
    { key: 'mgr/configuration', label: 'Configuration', to: '/manager/configuration' },
    { key: 'mgr/import', label: 'Import', to: '/manager/import' },
    { key: 'myreq', label: 'My Requests', to: '/my-requests' },
  ];
}

function stakeLinks(): NavLinkSpec[] {
  return [
    { key: 'stake/roster', label: 'Roster', to: '/stake/roster' },
    { key: 'stake/wards', label: 'Ward Rosters', to: '/stake/wards' },
    { key: 'myreq', label: 'My Requests', to: '/my-requests' },
  ];
}

function bishopricLinks(): NavLinkSpec[] {
  return [
    { key: 'bish/roster', label: 'Roster', to: '/bishopric/roster' },
    { key: 'myreq', label: 'My Requests', to: '/my-requests' },
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
          const isActive = pathname === link.to;
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
