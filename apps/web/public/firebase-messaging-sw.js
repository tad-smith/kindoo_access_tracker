// Firebase Cloud Messaging service worker — handles background pushes
// when the SPA is closed or backgrounded. Foreground pushes are
// handled by the SPA via `onMessage()` (not implemented here in v1;
// foreground UI relies on the live Firestore subscription).
//
// Coexists with vite-plugin-pwa's Workbox SW: this file registers at
// scope `/firebase-cloud-messaging-push-scope`; Workbox owns scope
// `/`. Distinct scopes are independent SWs per the spec.
//
// Config injection strategy: we receive the firebase config as URL
// query params from the SPA-side `navigator.serviceWorker.register()`
// call. This avoids hardcoding staging vs prod values into a
// committed file (the config is public-by-design but having two
// deployments share one committed file is brittle). All required
// fields are public — `apiKey`, `projectId`, `messagingSenderId`,
// `appId`. The query-param approach mirrors common FCM examples and
// keeps this file environment-agnostic.

/* global importScripts, firebase, self, clients */

// Firebase compat SDK — the modular SDK does not currently support
// background-message handlers in service workers cleanly; FCM docs
// canonicalise the compat path here.
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

const params = new URL(self.location).searchParams;
const firebaseConfig = {
  apiKey: params.get('apiKey') || 'fake-api-key',
  authDomain: params.get('authDomain') || undefined,
  projectId: params.get('projectId') || 'kindoo-staging',
  messagingSenderId: params.get('messagingSenderId') || undefined,
  appId: params.get('appId') || undefined,
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// Background message handler. Falls through to the browser's default
// notification rendering when the FCM payload includes a
// `notification` block (the trigger at functions/src/triggers/
// pushOnRequestSubmit.ts uses the data-only path so we render
// explicitly here).
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
