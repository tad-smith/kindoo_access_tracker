// Minimal vitest config for @kindoo/firestore-tests. Rules tests run
// against the Firestore emulator; the operator must have it running
// (`firebase emulators:start --only firestore`) before invoking
// `pnpm --filter @kindoo/firestore-tests test:rules`.
//
// `singleThread: true` (poolOptions.threads) is intentional: rules
// emulator state is shared across tests, and parallel suites racing on
// the same emulator instance produce flakes that look like real rule
// failures. Phase 3 may revisit this if test count climbs.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
