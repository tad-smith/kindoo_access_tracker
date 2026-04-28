// Subscribes to Firebase Auth's `onIdTokenChanged` and triggers a
// re-render when the token rotates (initial sign-in, hourly auto-
// refresh, server-side `revokeRefreshTokens`, manual `getIdToken(true)`).
//
// Why this exists: `usePrincipal()` reads decoded claims from the
// current `User` via `getIdTokenResult()`. The `User` reference is
// stable across token rotations, so without an external re-render
// trigger, server-side claim updates (`revokeRefreshTokens` fans the
// next refresh; the SDK rotates the token) would not flow into the
// React tree until something else caused a re-render. This hook
// bumps a counter on every `onIdTokenChanged` event so consumers
// re-evaluate their decoded claims.

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
