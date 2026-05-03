// Firebase Cloud Messaging service worker — TEMPLATE.
//
// NOT served as-is. The `firebaseMessagingSwPlugin` in `vite.config.ts`
// substitutes the `__VITE_FIREBASE_*__` placeholders below with literal
// values from the build env (`VITE_FIREBASE_*`) and emits the result to
// `/firebase-messaging-sw.js` in `dist/` (and serves the templated copy
// at the same path during `pnpm dev`).
//
// Why baked-in literals instead of URL query params: the FCM SDK calls
// `getToken` / `deleteToken` against the SW registration at the bare
// path. The browser treats `/firebase-messaging-sw.js` and
// `/firebase-messaging-sw.js?apiKey=...` as different scripts, so a
// query-param register-time config would never reach the SDK's
// internal SW lookup. Build-time substitution keeps both the
// SPA-driven subscribe AND the SDK-driven deleteToken / token refresh
// paths pointed at the same fully-configured SW.
//
// Coexists with vite-plugin-pwa's Workbox SW: the FCM SDK auto-
// registers this script at scope `/firebase-cloud-messaging-push-scope`;
// Workbox owns `/`. Distinct scopes are independent SWs per the spec.

/* global importScripts, firebase, self, clients */

// Firebase compat SDK — the modular SDK does not currently support
// background-message handlers in service workers cleanly; FCM docs
// canonicalise the compat path here.
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: '__VITE_FIREBASE_API_KEY__',
  authDomain: '__VITE_FIREBASE_AUTH_DOMAIN__',
  projectId: '__VITE_FIREBASE_PROJECT_ID__',
  messagingSenderId: '__VITE_FIREBASE_MESSAGING_SENDER_ID__',
  appId: '__VITE_FIREBASE_APP_ID__',
});

const messaging = firebase.messaging();

// Background message handler. The trigger at functions/src/triggers/
// pushOnRequestSubmit.ts uses a data-only payload so we render the
// notification explicitly here.
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = data.title || 'New request';
  const body = data.body || 'A new access request has been submitted.';
  const deepLink = data.deepLink || '/manager/queue';
  self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { deepLink },
    tag: data.requestId || 'kindoo-new-request',
  });
});

// Notification click → focus an existing app window if one is open at
// any path; otherwise open a new one at the deep-link target.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.deepLink) || '/manager/queue';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(target);
          return;
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(target);
      }
      return undefined;
    }),
  );
});
