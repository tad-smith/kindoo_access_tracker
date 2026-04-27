# e2e — Claude Code guidance

End-to-end tests via Playwright against the local emulator stack + locally-built `apps/web/`. The slowest, most expensive test layer; reserve it for user-facing workflows.

**Owner agent:** `web-engineer` (same agent owns `apps/web/`).

## Stack

- Playwright (Chromium primary; Firefox + WebKit on the smoke matrix)
- TypeScript
- Targets local emulators (Firestore + Auth) + Vite preview build of `apps/web/`
- Headless in CI; headed via `pnpm test:e2e:headed` for local debugging

## File layout

```
e2e/
├── tests/
│   ├── auth/                  # sign-in, sign-out, NotAuthorized
│   ├── requests/              # full request lifecycle workflows
│   ├── seats/                 # roster + manager all-seats workflows
│   ├── manager-admin/         # configuration + bootstrap wizard + import
│   ├── pwa/                   # install + offline + push (Phase 10)
│   └── smoke.spec.ts          # one cross-cutting smoke for CI
├── fixtures/                  # seed-data factories (makeStake, makePendingRequest, etc.)
├── playwright.config.ts
└── package.json
```

## Conventions

- **Tests organized by user flow**, not by page. A flow can span multiple pages (submit → queue → complete → roster).
- **Tests describe user-visible behaviour.** No implementation references; if the test reads "click the button labeled Mark Complete" rather than "find element with class `.btn-complete`", you're on the right track.
- **Each test seeds its own data** via factories from `fixtures/`. No shared mutable state between tests.
- **Reset emulators between tests** via `clearFirestoreData` in `beforeEach`.
- **Auth via Auth-emulator's `signInWithCustomToken`** with synthetic claims — don't go through the real Google popup in tests.

## Don't

- **Don't write E2E tests for things unit/component tests cover.** E2E is the slowest layer; reserve it for true workflows.
- **Don't depend on real external services.** No real SendGrid (mocked in functions/), no real Sheets API (mocked), no real FCM.
- **Don't share state across tests.** Test order should not matter; verify with `playwright --shuffle`.
- **Don't write tests against staging/prod.** E2E tests run against emulators only; smoke tests against staging are a separate (manual) Phase 11 step.

## Boundaries

- **New page in `apps/web/`** → matching E2E test in the same PR.
- **New Cloud Function workflow** → matching E2E test (the function is mocked at the wrapper level; the user-visible effect is what's tested).
- **All bug fixes that aren't pure-unit-testable** add an E2E regression spec.
- **PWA-specific tests** (install, offline, push) live under `tests/pwa/` — Phase 10 onward.
