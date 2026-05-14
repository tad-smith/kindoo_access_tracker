// Gray toolbar shown above the tab bar in the tabbed shell. Owns the
// signed-in email (left) and the Sign out button (right). Extracted
// from the individual panel headers so all three primary surfaces
// share one chrome.

import { useState } from 'react';
import { signOut } from '../lib/extensionApi';

interface ToolbarProps {
  email: string | null | undefined;
}

export function Toolbar({ email }: ToolbarProps) {
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    try {
      await signOut();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="sba-toolbar" data-testid="sba-toolbar">
      <span className="sba-toolbar-email" data-testid="sba-toolbar-email">
        {email ?? ''}
      </span>
      <button
        type="button"
        className="sba-btn"
        onClick={() => void handleSignOut()}
        disabled={pending}
        data-testid="sba-sign-out"
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
