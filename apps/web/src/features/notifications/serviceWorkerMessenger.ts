// Bridge from the FCM service worker's `notificationclick` handler
// to TanStack Router. iOS standalone PWAs silently ignore
// `client.navigate()` from inside the SW (the PWA always relaunches
// at the manifest's `start_url`), so the SW posts the deep-link
// target to the page instead and the page does the routing on the
// main thread — which iOS does honor.
//
// Wire-up: called once from `main.tsx` after the router is created.
// Survives every route change because it lives at module scope, not
// inside a route component. Returns a teardown function for tests.
//
// Message contract (string-typed; the SW lives in a separate ES file
// and can't import this type, so the discriminator is a literal):
//
//   { type: 'kindoo:notification-click', target: string }
//
// `target` is a path-plus-query string like
// `/manager/queue?focus=<requestId>`. We hand it to
// `router.history.push(...)`, which parses + dispatches against the
// configured route tree. A malformed target (non-string, missing
// leading `/`) is silently dropped; the SW only ever sends the
// `data.deepLink` field that the Cloud Function trigger writes, so
// the validity is enforced at the source.

const MESSAGE_TYPE = 'kindoo:notification-click';

/** Minimal router shape we need — keeps the hook testable. */
export interface RouterLike {
  history: {
    push: (path: string) => void;
  };
}

/** Subset of the SW message payload that triggers a navigation. */
interface NotificationClickMessage {
  type: typeof MESSAGE_TYPE;
  target: string;
}

function isNotificationClickMessage(value: unknown): value is NotificationClickMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown; target?: unknown };
  return (
    v.type === MESSAGE_TYPE &&
    typeof v.target === 'string' &&
    v.target.length > 0 &&
    v.target.startsWith('/')
  );
}

/**
 * Register the SW → SPA bridge. No-op on environments without
 * `navigator.serviceWorker` (Safari pre-PWA-install flagged paths,
 * vitest jsdom default). Returns a teardown function so tests can
 * detach the listener; production callers can ignore the return.
 */
export function registerNotificationClickRouter(router: RouterLike): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {};
  }
  const handler = (event: MessageEvent) => {
    if (!isNotificationClickMessage(event.data)) return;
    router.history.push(event.data.target);
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => {
    navigator.serviceWorker.removeEventListener('message', handler);
  };
}
