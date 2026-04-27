// Vitest config for the Kindoo SPA.
//
// jsdom for component-style tests; the smoketest unit test for
// `version.ts` is environment-agnostic but jsdom is the default everything
// else will need from Phase 4 onwards.

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
