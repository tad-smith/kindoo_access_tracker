// Subscribes to Firebase Auth's `onIdTokenChanged` and triggers a
// re-render when the token rotates (initial sign-in, hourly auto-
// refresh, server-side `revokeRefreshTokens`, manual `getIdToken(true)`).
//
// Why this exists: reactfire's `useIdTokenResult(user)` caches by user
// reference. After `revokeRefreshTokens` fires server-side, the user
// reference is stable but the underlying token has new claims; without
// a re-render trigger, `usePrincipal()` would surface stale claims
// until the user took an action that re-rendered the tree. This hook
// bumps a counter on every `onIdTokenChanged` event so consumers
// re-evaluate.

import { onIdTokenChanged } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { auth } from '../../lib/firebase';

/**
 * Returns a monotonically-increasing counter that bumps whenever the
 * Firebase Auth ID token rotates. Components that derive state from
 * decoded claims should depend on this value (or simply call this
 * hook) so they re-render after a server-side claim change.
 */
export function useTokenRefresh(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const unsubscribe = onIdTokenChanged(auth, () => {
      setTick((prev) => prev + 1);
    });
    return unsubscribe;
  }, []);

  return tick;
}
