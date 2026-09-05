// Push notification data hooks + mutations.
//
// Subscribe / unsubscribe lifecycle:
//   1. User clicks "Enable push" → `useEnablePushMutation`:
//        a. Call `Notification.requestPermission()` (must be inside the
//           click gesture — iOS Safari rejects otherwise).
//        b. Call `getToken(messaging, { vapidKey })`. The FCM SDK
//           auto-registers the bare `/firebase-messaging-sw.js` URL
//           at its default scope `/firebase-cloud-messaging-push-scope`.
//           That scope is distinct from vite-plugin-pwa's Workbox SW
//           (scope `/`), so the two coexist cleanly per the
//           ServiceWorker spec.
//        c. Write `userIndex/{canonical}` with merge:
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
//   3. Toggle a push category while already subscribed →
//      `useUpdatePushPrefMutation(category)` flips that one boolean;
//      tokens and the sibling category stay in place.
//
// Subscribing opts you into `newRequest` only — that is what the
// Enable button's copy promises. `syncReminder` is opt-in on its own
// switch, so it stays absent (and reads false) until asked for.
//
// Why no explicit `navigator.serviceWorker.register(...)` call: the
// initial implementation registered the SW with config-as-query-params
// so the static SW could `firebase.initializeApp({...})` against the
// right project. The browser treats `/firebase-messaging-sw.js` and
// `/firebase-messaging-sw.js?apiKey=X` as different scripts, so the
// FCM SDK's internal `getToken`/`deleteToken` paths — which look up
// the registration at the bare URL — saw an unconfigured (or never-
// registered) SW and threw `messaging/failed-service-worker-
// registration`. Build-time substitution (see
// `vite.config.ts:firebaseMessagingSwPlugin`) bakes the public Firebase
// config into the SW directly, so subscribe AND deleteToken hit the
// same fully-configured SW at the bare path.
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
import { db, firebaseApp } from '../../lib/firebase';
import { userIndexRef } from '../../lib/docs';
import { usePrincipal } from '../../lib/principal';
import type { Principal } from '../../lib/principal';
import { getDeviceId, getVapidPublicKey } from './lib';

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

type PushPrefs = NonNullable<NonNullable<UserIndexEntry['notificationPrefs']>['push']>;

/**
 * A push notification category. Derived from the shared type so a new
 * category is a one-line schema change, not a second union to keep in
 * step.
 */
export type PushCategory = keyof PushPrefs;

/**
 * Ergonomic accessor for one `notificationPrefs.push.*` flag.
 *
 * An absent key reads as OFF: every category is opted into
 * individually, so a manager already subscribed for `newRequest` does
 * not silently start receiving `syncReminder` pushes. The server-side
 * fanout gates on `=== true` to match.
 */
export function getPushPref(entry: UserIndexEntry | undefined, category: PushCategory): boolean {
  return entry?.notificationPrefs?.push?.[category] === true;
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
          'Push notifications are not configured for this site. Contact your administrator.',
        );
      }
      if (typeof Notification === 'undefined') {
        throw new Error('Push notifications not supported on this device.');
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        return 'denied';
      }

      // Let the FCM SDK auto-register the bare `/firebase-messaging-sw.js`
      // at its default scope (`/firebase-cloud-messaging-push-scope`).
      // The SW already has Firebase config baked in at build time
      // (see vite.config.ts:firebaseMessagingSwPlugin), so no
      // serviceWorkerRegistration arg is required and subscribe +
      // deleteToken both target the same registration.
      const messaging = getMessaging(firebaseApp);
      const token = await getToken(messaging, { vapidKey });
      if (!token) {
        throw new Error('Could not register this device for push notifications.');
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
 * Toggle one push category on/off without changing the subscription.
 * Used by the per-category switches when the device is already
 * registered. One hook per category so each switch keeps its own
 * `isPending` — a shared mutation would grey out both.
 *
 * The write names only `category`, so a merge leaves every sibling
 * category as it was.
 */
export function useUpdatePushPrefMutation(category: PushCategory) {
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean): Promise<void> => {
      if (!principal.canonical) {
        throw new Error('Not signed in.');
      }
      const actor = actorOf(principal);
      const push: Partial<Record<PushCategory, boolean>> = { [category]: enabled };
      await setDoc(
        userIndexRef(db, principal.canonical),
        {
          notificationPrefs: { push },
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
