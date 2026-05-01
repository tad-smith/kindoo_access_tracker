// Stub for the `virtual:pwa-register/react` module that vite-plugin-pwa
// only synthesises during a real Vite build/dev. Vitest doesn't load
// the plugin, so we alias the virtual specifier to this file. Tests
// that need to drive specific SW state still mock this hook via
// `vi.mock('virtual:pwa-register/react', ...)`.

export function useRegisterSW() {
  return {
    needRefresh: [false, () => {}] as [boolean, (next: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (next: boolean) => void],
    updateServiceWorker: async (_reload?: boolean) => {},
  };
}
