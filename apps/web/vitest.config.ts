// Vitest config for the Stake Building Access SPA.
//
// jsdom for component-style tests. The `virtual:pwa-register/react`
// alias points at a hand-rolled stub because vite-plugin-pwa only
// synthesises that module during a real Vite build/dev — under vitest
// we substitute a pass-through hook so SW-aware components mount.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'virtual:pwa-register/react': resolve(__dirname, 'test/stubs/pwa-register-react.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
