// Persistent desktop rail (>=1024px). Hosts the full sectioned nav
// with text labels, plus a sign-out + version-stamp footer pinned to
// the bottom of the rail.

import { LogOut } from 'lucide-react';
import { Nav } from './Nav';
import type { Principal } from '../../lib/principal';

interface LeftRailProps {
  principal: Principal;
  signingOut: boolean;
  version: string;
  onSignOut: () => void;
}

export function LeftRail({ principal, signingOut, version, onSignOut }: LeftRailProps) {
  return (
    <aside className="kd-left-rail" aria-label="Primary navigation">
      <div className="kd-left-rail-scroll">
        <Nav principal={principal} ariaLabel="Primary" />
      </div>
      <div className="kd-left-rail-foot">
        <button type="button" className="kd-nav-logout" onClick={onSignOut} disabled={signingOut}>
          <LogOut size={18} aria-hidden="true" />
          <span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
        </button>
        <span className="kd-nav-version" aria-label="Build version">
          v{version}
        </span>
      </div>
    </aside>
  );
}
