// Vitest config for the Chrome extension. jsdom environment so React
// component tests can mount; Chrome and Firebase APIs are mocked at
// the wrapper level via vi.mock().

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
