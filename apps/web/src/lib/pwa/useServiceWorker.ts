// Service-worker registration hook. Thin wrapper around vite-plugin-pwa's
// `useRegisterSW` so the rest of the app imports from one place and the
// virtual-module dependency is isolated for testing.
//
// `registerType: 'prompt'` in vite.config.ts means the SW does NOT
// auto-update — `needRefresh` flips to `true` when a new SW is waiting and
// the user clicks the surfaced prompt to call `update()`.
//
// Why we don't just call vite-plugin-pwa's `updateServiceWorker(true)`:
// its built `register.ts` (prompt mode) posts SKIP_WAITING and then relies
// ENTIRELY on a Workbox `controlling` event (a `controllerchange` wrapper)
// to fire `window.location.reload()`. That event only fires when a new SW
// takes control of an ALREADY-controlled page. Our generated `sw.js` does
// not call `clients.claim()`, so on desktop Chrome — where the open tab is
// frequently uncontrolled (a prior hard-reload), or where multiple tabs
// hold the old SW active, or simply because nothing claims the page — the
// `controlling` event never fires and the page never reloads. Mobile users
// typically open a fresh, already-controlled tab/PWA, so the swap-on-
// activate path does fire there, which is why "Update now" worked on mobile
// but did nothing on desktop.
//
// The fix below does NOT depend on `controllerchange`: we trigger
// skip-waiting on the waiting worker, await that worker's `statechange` to
// `activated` (with a short timeout fallback), then reload ourselves. After
// skip-waiting the new SW is active and a manual reload is served by the new
// bundle. We also set `clientsClaim: true` in the workbox config so the new
// SW takes control going forward, but the reload here is robust even if it
// does not.

import { useRegisterSW } from 'virtual:pwa-register/react';

export interface ServiceWorkerState {
  needRefresh: boolean;
  offlineReady: boolean;
  update: () => Promise<void>;
  dismissOfflineReady: () => void;
}

// Fallback delay (ms) before reloading if the waiting worker never reports
// `activated`. skip-waiting normally activates in tens of ms; this guards
// against a missed `statechange` (e.g. the worker activated before our
// listener attached) so the user is never stuck.
export const ACTIVATE_FALLBACK_MS = 2000;

/**
 * Drive a waiting service worker to activate and reload the page onto the
 * new bundle — without relying on a `controllerchange` / `controlling`
 * event, which does not reliably fire on desktop Chrome.
 *
 * Posts SKIP_WAITING to the waiting worker, resolves when that worker
 * reaches `activated` or after `timeoutMs`, then calls `reload()` exactly
 * once. Extracted from the hook so it is unit-testable with a stubbed
 * registration.
 *
 * Guards against double-reload: only one reload fires regardless of whether
 * `activated` and the timeout both occur. The post-reload page is served by
 * the new SW, so `needRefresh` is `false` and `update()` is not called
 * again.
 */
export async function activateAndReload(
  registration: ServiceWorkerRegistration | undefined,
  reload: () => void,
  timeoutMs: number = ACTIVATE_FALLBACK_MS,
): Promise<void> {
  const waiting = registration?.waiting;

  // No waiting worker to promote (already activated, or registration not
  // ready) — reload to pick up whatever is active now. Cheap and correct:
  // a manual reload is served by the active bundle.
  if (!waiting) {
    reload();
    return;
  }

  let reloaded = false;
  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    reload();
  };

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      waiting.removeEventListener('statechange', onStateChange);
      resolve();
    };

    const onStateChange = () => {
      if (waiting.state === 'activated') settle();
    };
    waiting.addEventListener('statechange', onStateChange);

    // Timeout fallback: reload anyway if `activated` never arrives (e.g. the
    // worker activated before the listener attached, or activation stalls).
    setTimeout(settle, timeoutMs);

    // Tell the waiting worker to skip waiting and activate. This drives the
    // `statechange` above (and, separately, may fire `controllerchange` if
    // the worker claims — we deliberately do not depend on that).
    waiting.postMessage({ type: 'SKIP_WAITING' });
  });

  reloadOnce();
}

export function useServiceWorker(): ServiceWorkerState {
  const {
    needRefresh: [needRefresh],
    offlineReady: [offlineReady, setOfflineReady],
  } = useRegisterSW({
    onRegisterError(error) {
      // eslint-disable-next-line no-console
      console.error('[pwa] service worker registration failed', error);
    },
  });

  return {
    needRefresh,
    offlineReady,
    update: async () => {
      const registration =
        'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
      await activateAndReload(registration, () => {
        window.location.reload();
      });
    },
    dismissOfflineReady: () => setOfflineReady(false),
  };
}
