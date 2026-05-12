// Persistent desktop rail (>=1024px). Hosts the full sectioned nav
// with text labels (including the Account section's Logout item).
// The foot carries only the version stamp.

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
        <Nav
          principal={principal}
          onSignOut={onSignOut}
          signingOut={signingOut}
          ariaLabel="Primary"
        />
      </div>
      <div className="kd-left-rail-foot">
        <span className="kd-nav-version" aria-label="Build version">
          v{version}
          {' · '}
          <a
            href="/THIRD_PARTY_LICENSES.txt"
            target="_blank"
            rel="noopener noreferrer"
            className="kd-nav-licenses-link"
          >
            Licenses
          </a>
        </span>
      </div>
    </aside>
  );
}
