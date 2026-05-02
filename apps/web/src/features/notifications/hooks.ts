// Push notification data hooks + mutations.
//
// Subscribe / unsubscribe lifecycle:
//   1. User clicks "Enable push" → `useEnablePushMutation`:
//        a. Call `Notification.requestPermission()` (must be inside the
//           click gesture — iOS Safari rejects otherwise).
//        b. Register the firebase-messaging-sw.js explicitly at its own
//           scope so vite-plugin-pwa's Workbox SW (scope `/`) doesn't
//           collide. Distinct scopes coexist cleanly per the
//           ServiceWorker spec.
//        c. Call `getToken(messaging, { vapidKey, serviceWorkerRegistration })`.
//        d. Write `userIndex/{canonical}` with merge:
//             - `fcmTokens[deviceId] = token`
//             - `notificationPrefs.push.newRequest = true`
//             - `lastActor: { email, canonical }`
//   2. User clicks "Disable push" → `useDisablePushMutation`:
//        a. Call `deleteToken(messaging)` (best-effort; ignored if it
//           rejects — the userIndex write below is the source of
//           truth).
//        b. Update `userIndex/{canonical}` removing `fcmTokens[deviceId]`
//           via `FieldValue.delete()` and setting
//           `notificationPrefs.push.newRequest = false`.
//   3. Toggle "New requests" pref while already subscribed →
//      `useUpdateNewRequestPrefMutation` flips the boolean only;
//      tokens stay in place.
//
// Defensive guarding everywhere — managers might not be the only ones
// with `userIndex` docs (every signed-in user has one), but rules
// permit self-update of `fcmTokens` + `notificationPrefs` regardless
// of role. Manager-only gating is enforced at the panel level (the
// panel doesn't render for non-managers); the hooks themselves work
// for any signed-in user.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { deleteField, setDoc } from 'firebase/firestore';
import { deleteToken, getMessaging, getToken } from 'firebase/messaging';
import type { UserIndexEntry } from '@kindoo/shared';
import { canonicalEmail } from '@kindoo/shared';
import { useFirestoreDoc } from '../../lib/data';
import { db, firebaseApp, firebaseConfig } from '../../lib/firebase';
import { userIndexRef } from '../../lib/docs';
import { usePrincipal } from '../../lib/principal';
import type { Principal } from '../../lib/principal';
import { getDeviceId, getVapidPublicKey } from './lib';

const FCM_SW_PATH = '/firebase-messaging-sw.js';
const FCM_SW_SCOPE = '/firebase-cloud-messaging-push-scope';

/**
 * Live `userIndex/{canonical}` doc for the signed-in user. Returns
 * `undefined` when not signed in or when the doc hasn't been written
 * yet (the bridge entry lands on first sign-in via `onAuthUserCreate`).
 */
export function useCurrentUserIndex() {
  const principal = usePrincipal();
  const ref = useMemo(() => {
    if (!principal.canonical) return null;
    return userIndexRef(db, principal.canonical);
  }, [principal.canonical]);
  return useFirestoreDoc<UserIndexEntry>(ref);
}

/**
 * Has this device subscribed to push (i.e., is its deviceId in the
 * `fcmTokens` map)? Stable across reloads because the deviceId is
 * persisted in localStorage.
 */
export function useIsThisDeviceSubscribed(entry: UserIndexEntry | undefined): boolean {
  return useMemo(() => {
    if (!entry?.fcmTokens) return false;
    const deviceId = getDeviceId();
    return typeof entry.fcmTokens[deviceId] === 'string';
  }, [entry]);
}

/** Ergonomic accessor for the `notificationPrefs.push.newRequest` flag. */
export function getNewRequestPref(entry: UserIndexEntry | undefined): boolean {
  return entry?.notificationPrefs?.push?.newRequest === true;
}

/**
 * Subscribe this device to push. Call from a click handler — browsers
 * reject `Notification.requestPermission()` outside a user gesture.
 *
 * Resolves to `'granted'` on success, `'denied'` if the user blocked
 * the prompt, or throws with a clear message for other failures
 * (VAPID unconfigured, SW registration failure, FCM token error).
 */
export function useEnablePushMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<'granted' | 'denied'> => {
      if (!principal.canonical) {
        throw new Error('Not signed in.');
      }
      const vapidKey = getVapidPublicKey();
      if (!vapidKey) {
        throw new Error(
          'VAPID key not configured. Set VITE_FCM_VAPID_PUBLIC_KEY in the deploy environment.',
        );
      }
      if (typeof Notification === 'undefined') {
        throw new Error('Push notifications not supported on this device.');
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        return 'denied';
      }

      // Register the firebase-messaging-sw.js explicitly at its own
      // scope to avoid the FCM SDK auto-registering at root and fighting
      // vite-plugin-pwa's Workbox SW (which claims scope `/`). Pass the
      // (public) firebase config as query params so the SW — which is
      // a static file at build time — can run `initializeApp()` without
      // hardcoded values per environment.
      const swUrl = withFirebaseConfigParams(FCM_SW_PATH);
      const swReg = await navigator.serviceWorker.register(swUrl, {
        scope: FCM_SW_SCOPE,
      });

      const messaging = getMessaging(firebaseApp);
      const token = await getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: swReg,
      });
      if (!token) {
        throw new Error('Failed to obtain FCM registration token.');
      }

      const deviceId = getDeviceId();
      const actor = actorOf(principal);
      // Merge-write. Rules permit only `fcmTokens`, `notificationPrefs`,
      // `lastActor` in `affectedKeys()` — anything else here would be
      // rejected. `uid` / `typedEmail` / `lastSignIn` stay server-only.
      await setDoc(
        userIndexRef(db, principal.canonical),
        {
          fcmTokens: { [deviceId]: token },
          notificationPrefs: { push: { newRequest: true } },
          lastActor: actor,
        } as Partial<UserIndexEntry> & { lastActor: typeof actor },
        { merge: true },
      );
      return 'granted';
    },
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

/**
 * Unsubscribe this device. Removes the deviceId slot from
 * `userIndex.fcmTokens` and flips `notificationPrefs.push.newRequest`
 * to false. Does NOT clear other devices' tokens — those slots stay
 * intact so push still fires on other browsers/phones.
 */
export function useDisablePushMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      if (!principal.canonical) {
        throw new Error('Not signed in.');
      }
      const deviceId = getDeviceId();
      // Best-effort: delete the FCM token registration on the SDK side.
      // If the SDK never had one (e.g., user unsubscribed via browser
      // settings then clicked Disable in the UI to sync state), this
      // throws; swallow so the userIndex write still happens.
      try {
        const messaging = getMessaging(firebaseApp);
        await deleteToken(messaging);
      } catch (err) {
        console.warn('[push] deleteToken failed; proceeding to clear userIndex slot', err);
      }
      const actor = actorOf(principal);
      await setDoc(
        userIndexRef(db, principal.canonical),
        {
          fcmTokens: { [deviceId]: deleteField() },
          notificationPrefs: { push: { newRequest: false } },
          lastActor: actor,
        } as unknown as Partial<UserIndexEntry> & { lastActor: typeof actor },
        { merge: true },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

/**
 * Toggle the "new request" push category on/off without changing the
 * subscription. Used by the per-category switch when the device is
 * already registered.
 */
export function useUpdateNewRequestPrefMutation() {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean): Promise<void> => {
      if (!principal.canonical) {
        throw new Error('Not signed in.');
      }
      const actor = actorOf(principal);
      await setDoc(
        userIndexRef(db, principal.canonical),
        {
          notificationPrefs: { push: { newRequest: enabled } },
          lastActor: actor,
        } as Partial<UserIndexEntry> & { lastActor: typeof actor },
        { merge: true },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

function actorOf(principal: Principal): { email: string; canonical: string } {
  return {
    email: principal.email ?? '',
    canonical: principal.canonical ?? canonicalEmail(principal.email ?? ''),
  };
}

/**
 * Append the public firebase config to the SW URL as query params so
 * the service worker (which is a static file at build time) can call
 * `firebase.initializeApp(...)` without each deployment shipping its
 * own committed copy.
 */
function withFirebaseConfigParams(path: string): string {
  const params = new URLSearchParams();
  if (firebaseConfig.apiKey) params.set('apiKey', firebaseConfig.apiKey);
  if (firebaseConfig.authDomain) params.set('authDomain', firebaseConfig.authDomain);
  if (firebaseConfig.projectId) params.set('projectId', firebaseConfig.projectId);
  if (firebaseConfig.messagingSenderId) {
    params.set('messagingSenderId', firebaseConfig.messagingSenderId);
  }
  if (firebaseConfig.appId) params.set('appId', firebaseConfig.appId);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
