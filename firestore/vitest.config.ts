// Minimal vitest config for @kindoo/firestore-tests. Rules tests run
// against the Firestore emulator; the operator must have it running
// (`firebase emulators:start --only firestore`) before invoking
// `pnpm --filter @kindoo/firestore-tests test:rules`.
//
// Serial execution is intentional: rules emulator state is shared
// across tests, and parallel suites racing on the same emulator
// instance produce flakes that look like real rule failures.
//
// Vitest 4 dropped `poolOptions.threads.singleThread`; the equivalent
// is now top-level `maxWorkers: 1` (paired with `fileParallelism:
// false` to disable cross-file parallelism). See the Vitest 4
// migration guide ("Pool rework").
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
