// Push notification primitives. Pure helpers (no React) so the hooks
// in `./hooks.ts` stay focused on TanStack Query lifecycle.
//
// Three concerns:
//   1. `getDeviceId()` — stable per-browser-install identifier so the
//      same device keeps the same `userIndex.fcmTokens[deviceId]` slot
//      across permission re-grants, token rotations, and reloads.
//      Generated once via `crypto.randomUUID()`, persisted in
//      localStorage.
//   2. `pushSupportStatus()` — feature-detect what the current
//      environment supports. iOS Safari prior to 16.4 returns
//      `'unsupported'`; iOS Safari NOT in standalone mode returns
//      `'requires-install'`; everything else returns `'supported'`.
//   3. `getVapidPublicKey()` — read the env var, return null if
//      unconfigured so the UI can surface a clear error instead of
//      crashing inside the FCM SDK.

const DEVICE_ID_STORAGE_KEY = 'kindoo:fcmDeviceId';

/**
 * Stable per-browser-install identifier. Generated once via
 * `crypto.randomUUID()` and kept in localStorage. Surviving uninstall
 * is not a goal — a freshly-installed PWA gets a new id and a new
 * `fcmTokens` slot, which is correct (the old token is dead anyway).
 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
  }
  return id;
}

/**
 * Push-support classification. Distinguishes "no Notification API"
 * (Safari < 16.4, headless test env) from "Notification API present
 * but iOS Safari outside standalone mode" (push needs PWA install
 * first) from "good to go."
 */
export type PushSupportStatus =
  | 'supported'
  | 'unsupported' // no Notification API or no Service Worker support
  | 'requires-install'; // iOS Safari, Notification API present, not standalone

export function pushSupportStatus(): PushSupportStatus {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('Notification' in window)) return 'unsupported';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  // iOS Safari supports Notification only when launched from the home
  // screen (standalone). Detect via `navigator.standalone` (Safari-only
  // legacy bool) OR `display-mode: standalone` media query (PWA spec).
  const isIos = /iPad|iPhone|iPod/i.test(navigator.userAgent);
  if (isIos) {
    const standalone =
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia?.('(display-mode: standalone)').matches === true;
    if (!standalone) return 'requires-install';
  }
  return 'supported';
}

/** Public VAPID key from the build-time env. `null` if unconfigured. */
export function getVapidPublicKey(): string | null {
  const key = import.meta.env.VITE_FCM_VAPID_PUBLIC_KEY;
  if (typeof key !== 'string' || key.trim() === '') return null;
  return key;
}

/**
 * Resolve the current Notification permission state. Wrapped so tests
 * can stub a single function rather than the whole `Notification`
 * global; also normalises older Safari versions that lacked
 * `Notification.permission`.
 */
export function currentPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}
