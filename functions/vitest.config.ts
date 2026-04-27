// Minimal vitest config for @kindoo/functions. Cloud Functions code runs
// on Node 22 in production; tests run on whatever Node the developer's
// pnpm install picked. `node` environment is sufficient — there's no DOM
// to simulate.
//
// Phase 1: only the in-source unit tests (src/**/*.test.ts) exist.
// Phase 2+ adds tests/ for emulator-driven integration suites; the
// `test:integration` script in package.json scopes to that directory.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
