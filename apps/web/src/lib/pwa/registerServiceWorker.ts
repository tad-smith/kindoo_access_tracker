// Service-worker registration for autoUpdate mode.
//
// `registerType: 'autoUpdate'` (vite.config.ts) means there is no update
// prompt: a new deploy's worker installs, skip-waits, claims clients, and
// the page silently reloads onto the new bundle. The reload is driven by
// vite-plugin-pwa's `registerSW()` (from `virtual:pwa-register`), which in
// autoUpdate mode attaches a Workbox `activated` listener that calls
// `window.location.reload()` when `event.isUpdate` (a new worker replacing
// an old one) is true.
//
// Why `registerSW()` and not `injectRegister: 'auto'`: the plugin's own
// `registerSW.js` script injection only calls
// `navigator.serviceWorker.register` — it does NOT wire the autoUpdate
// reload handler. Only this `registerSW()` call does. Without it an open
// desktop tab would take a new SW (skipWaiting/clientsClaim) but keep its
// stale in-memory JS until a manual navigation — the version-thrash this
// change exists to fix.
//
// Why this is reliable where the old prompt path was not: the old path
// (registerType: 'prompt') reloaded on a `controllerchange` / `controlling`
// event, which only fires when a new SW takes control of an
// already-controlled page — it never fired for the frequently-uncontrolled
// desktop tabs. The `activated`/`isUpdate` event used here fires whenever
// the new worker activates, regardless of whether the page was controlled.
//
// When an open tab picks up a deploy: vite-plugin-pwa runs an update check
// on registration and Workbox re-checks `sw.js` on load/navigation
// (navigations are frequent in this app). Paired with the no-cache Hosting
// headers on `index.html` / `sw.js`, an open tab discovers and reloads onto
// a fresh deploy on its next navigation or reload — typically within
// seconds. We deliberately do NOT add a short-interval
// `registration.update()` poll: that risks reloading a user mid-form.
//
// No-op in environments without a service worker (jsdom unit tests, dev
// server where the SW is disabled). `registerSW` is provided by
// vite-plugin-pwa's virtual module; under vitest the import is never
// reached because this module is only imported from `main.tsx`.

import { registerSW } from 'virtual:pwa-register';

export function registerServiceWorker(): void {
  // `immediate: true` registers on script execution rather than waiting for
  // the `load` event, so the update check starts as early as possible.
  registerSW({
    immediate: true,
    onRegisterError(error) {
      // eslint-disable-next-line no-console
      console.error('[pwa] service worker registration failed', error);
    },
  });
}
