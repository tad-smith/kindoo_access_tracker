// Playwright config for the Stake Building Access e2e suite.
//
// Phase 1: one smoke spec under `tests/smoke.spec.ts`. The webServer
// block boots `vite preview` against the production-style build so we
// catch issues that wouldn't surface in `vite dev`. Headless in CI; set
// `PWDEBUG=1` or run `pnpm test:e2e:headed` for local debugging.
//
// Workers serialised. Every test's `beforeEach` calls `clearAuth()` and
// `clearFirestore()` against the local emulator. Those calls are
// project-scoped, not per-worker — under `fullyParallel`, worker B's
// clearAuth deletes the user worker A just created, surfacing as
// USER_NOT_FOUND / EMAIL_EXISTS / auth/user-not-found flakes.
// `workers: 1` in CI serialises the suite end-to-end at the cost of
// ~30s wall-clock; preferable to flake. Local dev keeps default
// parallelism since the operator typically runs one spec at a time.

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const baseURL = `http://localhost:${PORT}`;

const isCI = !!process.env.CI;

// Must track the default in `fixtures/emulator.ts` — the bundle and the
// fixtures have to address the same emulator namespace. Honours the same
// `E2E_FIREBASE_PROJECT` override, so pointing a run at an isolated
// project still moves both halves together.
const PROJECT_ID = process.env['E2E_FIREBASE_PROJECT'] ?? 'kindoo-staging';

export default defineConfig({
  testDir: './tests',
  // The user-guide capture utility (`tests/screenshots.capture.ts`) is
  // deliberately excluded from the regression suite by its filename —
  // Playwright's default `testMatch` only collects `*.spec.ts` /
  // `*.test.ts`. A positional path argument filters the collected set
  // rather than widening it, so without this opt-in the documented
  // capture command collects zero tests. `CAPTURE_SCREENSHOTS=1` swaps
  // collection over to the capture file alone; unset, nothing changes.
  ...(process.env['CAPTURE_SCREENSHOTS'] ? { testMatch: '**/screenshots.capture.ts' } : {}),
  // Tests within a file run sequentially; files run sequentially in CI
  // (workers: 1) to keep the auth-emulator clearAuth races out of CI
  // signal. Locally, defaults still apply for fast iteration.
  fullyParallel: false,
  // `workers: 1` in CI — omit the key locally so Playwright picks its
  // default (one worker per CPU core). Spread-conditional satisfies
  // `exactOptionalPropertyTypes` from `tsconfig.base.json`.
  ...(isCI ? { workers: 1 } : {}),
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
    // to talk to the local emulator. `VITE_USE_AUTH_EMULATOR=true`
    // flips Firebase Auth to the local emulator the same way (Phase 2).
    // `VITE_USE_FUNCTIONS_EMULATOR=true` does the same for callables
    // (T-25 / Phase 8 §1094). Without these, the production bundle
    // would try to reach real Firebase and the page would throw before
    // the heading rendered. The smoke test does NOT require an emulator
    // be running — the SDK reaches out lazily on the first read; the
    // page heading is rendered synchronously on mount. The auth-flow,
    // import-now, and install-scheduled-jobs specs DO require all three
    // emulators to be running at test time (CI launches them via
    // `firebase emulators:exec --only firestore,auth,functions,hosting`).
    //
    // `VITE_FIREBASE_PROJECT_ID` is pinned to the namespace the fixtures
    // seed (`fixtures/emulator.ts`). `vite build` runs in mode
    // `production`, so it picks up `apps/web/.env.production` — which is
    // gitignored, and on an operator's machine pins `kindoo-prod`. The
    // bundle then queries a namespace nothing seeded and every spec
    // fails against an empty database. CI and fresh worktrees have no
    // such file and fall through to the same default, so the breakage is
    // local-only and invisible on PRs.
    command: `VITE_USE_FIRESTORE_EMULATOR=true VITE_USE_AUTH_EMULATOR=true VITE_USE_FUNCTIONS_EMULATOR=true VITE_FIREBASE_PROJECT_ID=${PROJECT_ID} pnpm --filter @kindoo/web build && pnpm --filter @kindoo/web preview`,
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    cwd: '..',
  },
});
