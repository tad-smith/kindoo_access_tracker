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
//
// `refreshIdToken()` is the sibling half: a mutation that just changed
// the signed-in user's own custom claims needs those claims to show up
// in `usePrincipal()` without waiting for the SDK's hourly auto-refresh.
// Calling it fires `onIdTokenChanged` once the new token lands, which
// is exactly the signal this hook already listens to — so every
// mounted `usePrincipal()` consumer re-derives for free. Callers
// should not hand-roll their own `getIdToken(true)`; go through this
// function so the "how do we force a refresh" logic stays in one
// place. See its own doc comment before adding a new caller — whether
// this is safe depends entirely on whether the claim you need is
// already minted server-side, not just on wanting fresher data.

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

/**
 * Force the signed-in user's Firebase Auth ID token to refresh
 * immediately, rather than waiting for the SDK's hourly auto-refresh.
 * Fires `onIdTokenChanged` once the new token lands, which every
 * mounted `useTokenRefresh()` (and therefore `usePrincipal()`) consumer
 * already listens to.
 *
 * No-op when no user is signed in. Callers that don't need to await the
 * round-trip can fire-and-forget with `.catch()`.
 *
 * **Only call this when the claim you need is already minted
 * server-side** — this function fetches whatever the server currently
 * has, it does not wait for anything to land. It previously had a
 * caller (`CreateStakeForm`, post-`createStake`) that called it while
 * `syncBootstrapClaims` — an async Firestore trigger on the very write
 * that was supposed to produce the claim — was still in flight; the
 * refresh lost that race almost every time and re-cached a claimless
 * token for ~1h, which was worse than not refreshing at all. That
 * caller was removed (architecture.md D28(d)). `useCompleteSetupMutation`
 * (`features/bootstrap/hooks.ts`) is the current caller and is not a
 * repeat of that mistake — see the comment there for why the claim it
 * needs is already settled by the time it calls this.
 */
export async function refreshIdToken(): Promise<void> {
  await auth.currentUser?.getIdToken(true);
}
