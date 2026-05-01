// Service-worker registration hook. Thin wrapper around vite-plugin-pwa's
// `useRegisterSW` so the rest of the app imports from one place and the
// virtual-module dependency is isolated for testing.
//
// `registerType: 'prompt'` in vite.config.ts means the SW does NOT
// auto-update — `needRefresh` flips to `true` when a new SW is waiting
// and the user clicks the surfaced toast to call `updateServiceWorker()`,
// which posts SKIP_WAITING and reloads.

import { useRegisterSW } from 'virtual:pwa-register/react';

export interface ServiceWorkerState {
  needRefresh: boolean;
  offlineReady: boolean;
  update: () => Promise<void>;
  dismissNeedRefresh: () => void;
  dismissOfflineReady: () => void;
}

export function useServiceWorker(): ServiceWorkerState {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      // eslint-disable-next-line no-console
      console.error('[pwa] service worker registration failed', error);
    },
  });

  return {
    needRefresh,
    offlineReady,
    update: () => updateServiceWorker(true),
    dismissNeedRefresh: () => setNeedRefresh(false),
    dismissOfflineReady: () => setOfflineReady(false),
  };
}
