// Minimal vitest config for @kindoo/shared. Pure-function code; node
// environment is sufficient (no DOM, no jsdom). The default reporter is
// fine — keep this lean until a real reason to deviate appears.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
