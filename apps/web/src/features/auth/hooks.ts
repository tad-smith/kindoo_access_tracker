// Auth-feature hooks: the extension-token mint mutation and the
// auth-persistence-ready gate that guards it.

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { httpsCallable } from 'firebase/functions';
import { auth, functions } from '../../lib/firebase';

/**
 * Whether Firebase Auth has finished rehydrating its persisted session
 * from IndexedDB.
 *
 * `usePrincipal()` reports "signed out" until that rehydration lands,
 * which is fine on pages that render the same either way. The
 * extension-auth route is not one: it acts on the signed-out branch by
 * showing sign-in affordances, so without this gate a returning
 * manager sees the sign-in form flash and can start a second sign-in
 * against a session that was about to resolve on its own.
 */
export function useAuthReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    auth
      .authStateReady()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        // Persistence read failed (private-mode IndexedDB block, etc.).
        // Treat it as resolved-signed-out rather than hanging on a
        // spinner forever — the user can still sign in by hand.
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

/**
 * Mint a Firebase custom token for the signed-in user, for the Chrome
 * extension to exchange via `signInWithCustomToken`. Takes no payload —
 * the callable derives everything from the caller's ID token.
 *
 * The response is one field, so it is typed inline here rather than in
 * `packages/shared/`.
 */
export function useMintExtensionToken() {
  return useMutation<string, Error, void>({
    mutationFn: async () => {
      const fn = httpsCallable<void, { token: string }>(functions, 'mintExtensionToken');
      const res = await fn();
      return res.data.token;
    },
  });
}
