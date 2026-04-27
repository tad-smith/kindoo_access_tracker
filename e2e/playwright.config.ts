// Playwright config for the Kindoo e2e suite.
//
// Phase 1: one smoke spec under `tests/smoke.spec.ts`. The webServer
// block boots `vite preview` against the production-style build so we
// catch issues that wouldn't surface in `vite dev`. Headless in CI; set
// `PWDEBUG=1` or run `pnpm test:e2e:headed` for local debugging.

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const baseURL = `http://localhost:${PORT}`;

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    headless: !process.env.PW_HEADED,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Build then preview the SPA. `pnpm --filter @kindoo/web build`
    // produces `apps/web/dist/`; preview serves that on PORT. Phase 4+
    // adds an emulator pre-boot step (auth + firestore); Phase 1 only
    // needs the static bundle to come up.
    //
    // `VITE_USE_FIRESTORE_EMULATOR=true` flips the SPA's Firestore SDK
    // to talk to the local emulator. Without it, the production bundle
    // would try to reach real Firestore and the page would throw before
    // the heading rendered. The smoke test does NOT require an emulator
    // be running — the SDK reaches out lazily on the first read; the
    // page heading is rendered synchronously on mount.
    command:
      'VITE_USE_FIRESTORE_EMULATOR=true pnpm --filter @kindoo/web build && pnpm --filter @kindoo/web preview',
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    cwd: '..',
  },
});
