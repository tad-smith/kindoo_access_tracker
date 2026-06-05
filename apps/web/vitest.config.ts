// Vitest config for the Stake Building Access SPA.
//
// jsdom for component-style tests. The only `virtual:pwa-register` importer
// is `src/lib/pwa/registerServiceWorker.ts`, which is imported solely by the
// `main.tsx` entrypoint — and no test loads `main.tsx`. So vitest never has
// to resolve that build-only virtual module, and needs no alias/stub for it.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
