// Minimal vitest config for @kindoo/functions. Cloud Functions code runs
// on Node 22 in production; tests run on whatever Node the developer's
// pnpm install picked. `node` environment is sufficient — there's no DOM
// to simulate.
//
// Phase 1: only the in-source unit tests (src/**/*.test.ts) exist.
// Phase 2+ adds tests/ for emulator-driven integration suites; the
// `test:integration` script in package.json scopes to that directory.
//
// Serial execution is intentional for the integration tests — the
// Firebase Auth + Firestore emulators are shared singletons, and
// parallel workers' afterEach cleanups will trip each other (a
// `clearEmulators` in worker A wipes worker B's just-created user
// before worker B reads it back). Single-thread is the simple fix at
// our test count.
//
// Vitest 4 dropped `poolOptions.threads.singleThread`; the equivalent
// is now top-level `maxWorkers: 1` (combined with `fileParallelism:
// false` to disable cross-file parallelism). See the Vitest 4
// migration guide ("Pool rework").
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
