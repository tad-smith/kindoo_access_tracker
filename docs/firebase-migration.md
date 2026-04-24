# Firebase migration plan

12 phases, each independently reviewable and shippable. Migrates the Apps Script implementation to Firebase **and** lifts the data model to multi-tenant in one continuous arc — Phases 1–10 port the existing single-stake app to Firebase (with the data already shaped for multi-tenancy), Phases 11–12 expose the multi-tenant surface so additional stakes can be onboarded. The Apps Script app stays in production through the end of Phase 10; cutover is a single maintenance window in Phase 10. Phase B (11+12) lands after cutover.

`docs/build-plan.md` is the build trail for the Apps Script implementation and stays as historical record. `docs/spec.md` describes behaviour and is updated in lockstep with each phase that changes it (the auth and routing sections take the biggest hits, in Phases 2, 5, and 11). `docs/architecture.md` gets substantially rewritten across Phases 1–4; sections that survive verbatim (request lifecycle state machine, audit-log shape, role union model, email policy) are explicitly left untouched.

## Locked-in decisions

| # | Decision | Rationale |
| --- | --- | --- |
| F1 | **Cloud Run + Express, single container.** ~50 endpoints all served from one Express app behind a Cloud Run service. | Shared middleware (auth, transactions, logging, error handling) is a one-line `app.use`; per-endpoint Cloud Functions would be 50× the boilerplate with no benefit at this scale. Free quota covers it. |
| F2 | **Vanilla TypeScript + Vite on the client.** TS modules with a small `render(html)` helper; per-page `init(model, queryParams)` / optional `teardown()` functions; client-side nav with History API (preserves Chunk 10.6's UX). No React/Svelte/Solid. | Today's `ClientUtils.html` is already template-string rendering with shared helpers. Porting to TS modules + render helpers is a short step; adding a framework rewrites every page for ergonomic wins that don't justify the cost at 14 pages with no complex state. |
| F3 | **TypeScript on both sides.** Shared `types/` package between client and server; Firestore Admin SDK has excellent type support; rpc layer end-to-end-typed. | Replaces the column-header-tuple / header-drift safety net (which TS types subsume). Catches schema drift at build time instead of first read. |
| F4 | **Domain stays `kindoo.csnorth.org` for now.** Multi-stake URLs will read awkwardly (`kindoo.csnorth.org/csnorth/mgr/seats`), but switching to a tenant-neutral domain later is one DNS change + one Firebase Hosting custom-domain swap — no code change. | User accepted this trade-off explicitly. Re-evaluate before onboarding the second real stake. |
| F5 | **Big-bang cutover during a maintenance window.** Migration script Saturday morning; sanity-check; flip DNS Saturday afternoon; monitor Sunday. Apps Script stays live as rollback for ~one week, then retires. | 1–2 requests/week; no dual-writes worth the complexity. |
| F6 | **`users/{uid}` collection** alongside Firebase Auth's built-in user record. Minimal `{email, lastSignIn, displayName?}` doc; Cloud Function trigger refreshes contents on every sign-in. | Stable per-user record we can extend (custom claims trigger, future per-user prefs). The built-in `auth().getUser(uid)` record alone is fine but isn't queryable from Firestore. |
| F7 | **Per-request role resolution; no custom claims for v1.** Read `kindooManagers` + `access` per request. Cache layer (deferred from Apps Script Chunk 10.5) added later only if measured need. | Custom claims add a 1-hour-staleness footnote on role removals plus extra plumbing (a Cloud Function on role-change events). Per-request lookup against doc-keyed collections is a single Firestore read; not a bottleneck at this scale. |
| F8 | **Two Firebase projects: `kindoo-staging` and `kindoo-prod`.** Cloud Run, Firestore, and Hosting deploy to either based on `FIREBASE_PROJECT` env; same code, different data. | Standard practice; lets the migration script rehearse against a snapshot in staging without risking production. |
| F9 | **Repo layout side-by-side during migration.** New code under `firebase/` (subdirs `client/`, `server/`, `shared/`, `functions/`, `scripts/`); existing `src/` and `identity-project/` untouched until Phase 10's cutover. | Keeps the live app deployable for rollback throughout. Phase 10 retires `src/` and `identity-project/`; their git history is preserved. |
| F10 | **Security rules at stake-scope only; API enforces roles.** Rules ensure an authenticated user has *some* membership in `stakeId` to read `stakes/{stakeId}/{document=**}`. Fine-grained role enforcement (bishopric-only-own-ward, etc.) lives in the API layer, as today. | Defense-in-depth via duplicated rule logic isn't worth the maintenance burden when the only Firestore client is the Cloud Run server (also enforced by rules: client SDK reads from Firestore are not used). Revisit if a direct-Firestore client is ever introduced. |
| F11 | **Tests are non-negotiable; CI gates every PR.** Every phase ships with unit + integration tests (and E2E where applicable) covering the phase's acceptance criteria. No phase merges without green CI. Vitest for unit + integration, `@firebase/rules-unit-testing` for rules, supertest for HTTP, Playwright for E2E. Apps Script's loose `Utils_test_*` discipline is explicitly *not* the model. | Past pain on the Apps Script side: integration bugs surfaced only at user-facing-flow time, when context was warm but the bug was several chunks old. Testing rigor up front makes each phase independently shippable, which is what makes the 12-phase migration tractable. |

## Testing strategy

The Apps Script version's testing was loose — a handful of `Utils_test_*` functions plus manual walkthroughs at the end of each chunk. The Firebase port runs much tighter. Every phase ships with tests covering its acceptance criteria; no phase ships without green CI. The migration is long and sequential; tests are how we catch regressions a phase later instead of three phases later.

### Test stack

| Layer | Tooling | Lands in | What it covers |
| --- | --- | --- | --- |
| Unit | **vitest** | Phase 1 onward | Pure functions: email canon, hashing, principal helpers, render helpers, validation, error mapping. Run in milliseconds; constant feedback. |
| Repo / data layer | **vitest + Firestore emulator** | Phase 3 onward | Each repo's CRUD against a real emulator (cleared between tests); transactions; composite-key uniqueness; audit-row-in-same-tx invariant; canonical-email lookup. |
| Security rules | **`@firebase/rules-unit-testing`** | Phase 3 onward | Authenticated / anon scenarios against `firestore.rules`; cross-stake denial; client-side write denial. |
| HTTP integration | **vitest + supertest + emulators** | Phase 4 onward | Per endpoint: happy-path, forbidden (wrong role), validation error, self-approval, R-1 race, audit-row emission. Express mounted in-process — no port binding. |
| Frontend unit | **vitest + jsdom** | Phase 5 onward | Render helpers, form validation, rpc client (URL building, auth header injection, retry-on-401, warning surfacing). |
| End-to-end | **Playwright** | Phase 5 onward | Browser drives the locally-running app against the emulator suite. One smoke per role per phase, expanded as new flows land. |
| Migration script | **vitest + emulator + Sheets fixture** | Phase 10 | Per-collection transformation, determinism, idempotency, diff-helper detection of synthetic mismatches. |

### Conventions

- **One test file per source file** under `test/` mirroring `src/` paths. (`server/src/services/Importer.ts` → `server/test/services/Importer.test.ts`.)
- **Test names describe behaviour, not implementation**. `it('rejects a remove when only an auto seat exists for the member')`, not `it('throws on auto type')`.
- **Each test sets up its own state**. No shared mutable fixtures. Use factories in `test/fixtures/` (`makeStake()`, `makeKindooManager()`, `makePendingRequest()`).
- **Emulator state cleared between tests** via `clearFirestoreData` in `beforeEach`. Test runs are completely isolated; order-independence verified by `vitest --shuffle`.
- **No mocks for Firestore.** The emulator is the test database. Mocks lie about transaction semantics, batched-write atomicity, and rule evaluation; the emulator doesn't.
- **Supertest hits the real Express app** mounted in-process (not bound to a port) — full middleware stack including auth, error mapping, transaction wrappers.
- **Auth tokens in tests** generated via the Auth emulator's `signInWithCustomToken` for tests, or via test helpers that mint emulator-signed tokens for any email.
- **E2E uses Playwright headless** in CI; headed for local debugging via `npm run test:e2e:headed`.
- **Coverage measured by vitest's built-in c8** (line + branch). Reported per phase. **No fixed numeric threshold** — coverage targets are gameable; the per-phase `**Tests**` subsection is the actual gate.
- **Test data builders, not fixtures-on-disk.** Programmatic construction via factories beats JSON files for refactor resilience.

### CI

GitHub Actions workflow (`.github/workflows/test.yml`) runs on every push and every PR:

1. `npm ci` — workspace install.
2. `npm run lint` — eslint + prettier --check.
3. `npm run typecheck` — `tsc --noEmit` across all packages.
4. `npm run test:unit` — vitest, no emulators.
5. `npm run test:integration` — vitest + emulators (`firebase emulators:exec --only firestore,auth -- npm run test:integration:run`).
6. `npm run test:rules` — rules-unit-testing.
7. `npm run test:e2e` — Playwright against emulators + locally-built Cloud Run image + Vite preview.
8. `npm run build` — production builds verify.

A failing step blocks the PR. No `--no-verify`, no skipping; if a test is wrong, fix the test, don't bypass the gate.

### Per-phase test discipline

Each phase below has a **Tests** subsection enumerating the specific test cases that prove the phase's acceptance criteria. The subsection is **non-exhaustive** — it lists the must-haves; additional tests are welcome where useful. Acceptance criteria implicitly include "all tests in this phase's Tests subsection pass" and "no prior-phase tests regress."

A phase is not shippable if any of its enumerated tests are missing or failing, even if the feature works manually. The `**Tests**` subsection is part of the contract.

## Dependency overview

```
1 Project skeleton + emulators
 └─ 2 Firebase Auth + principal resolution
     └─ 3 Firestore repos + security rules
         └─ 4 API layer (Express)
             └─ 5 Frontend SPA shell + auth flow
                 └─ 6 Page ports — read-side
                     └─ 7 Page ports — write-side
                         ├─ 8 Importer + Expiry on Cloud Scheduler
                         └─ 9 Email via SendGrid
                              └─ 10 Data migration + cutover  ◄─── end of Phase A
                                   └─ 11 Stake routing
                                        └─ 12 Platform superadmin + stake picker
```

Phases 4 and 5 can develop in parallel if you have two devs (server endpoints + client shell are independent). Phases 8 and 9 are independent and can develop in parallel after 7. Everything else is strictly sequential.

---

## Phase 1 — Project skeleton + emulators

**Goal:** A deployable Firebase project that responds to "hello, world" through the full stack: Vite-built TS client served by Hosting, calling an Express endpoint on Cloud Run, which reads a single doc from Firestore. Local development via emulators works end-to-end.

**Dependencies:** none.

**Sub-tasks**

_GCP / Firebase project setup_

- [ ] Create two Firebase projects: `kindoo-staging` and `kindoo-prod`. Both enable Blaze (pay-as-you-go) with a $1/month budget alert.
- [ ] Enable required services on both projects: Firestore (Native mode), Authentication, Hosting, Cloud Run, Cloud Scheduler, Sheets API, Secret Manager.
- [ ] Create one service account per project (`kindoo-app@<project>.iam.gserviceaccount.com`) with roles: Firestore Service Agent, Secret Manager Secret Accessor, Cloud Run Invoker (for Scheduler → Cloud Run auth in Phase 8). Grant Cloud Run service account permission to invoke itself for internal endpoint calls.
- [ ] Reserve Firestore database in the lowest-latency region (`us-central1` matches existing script timezone bias).

_Repo layout_

- [ ] Create `firebase/` at repo root, alongside the unchanged `src/` and `identity-project/` (per F9).
- [ ] Subdirectory shape:
  ```
  firebase/
  ├── client/         # Vite + TS frontend
  ├── server/         # Express + TS backend (Cloud Run)
  ├── shared/         # types and pure functions shared between client and server
  ├── functions/      # Cloud Scheduler-invoked endpoints (lives inside server/ or split — TBD in this phase)
  ├── scripts/        # one-off scripts (data migration, custom-claims helpers, etc.)
  ├── firebase.json   # Hosting + emulator config + rewrites
  ├── firestore.rules # security rules (stub in this phase, real in Phase 3)
  ├── firestore.indexes.json
  └── package.json    # workspace root
  ```
- [ ] Use npm workspaces (or pnpm) to keep `client`, `server`, `shared` as one install. `shared` is a workspace dependency of both client and server.
- [ ] TS strict mode in every package; one shared `tsconfig.base.json`.

_Server skeleton (Cloud Run)_

- [ ] Express + TS app with one endpoint: `GET /api/health` → `{ version, builtAt, env }`.
- [ ] Dockerfile (multi-stage: build TS, copy `dist/` to slim Node runtime image). Node 22 LTS.
- [ ] `npm run dev:server` runs locally on port 8080 against the Firestore emulator.
- [ ] Stamp build version (`firebase/server/src/version.ts`) at build time via a script (mirrors `scripts/stamp-version.js`).

_Client skeleton (Vite)_

- [ ] Vite + TS app with one page: index.html with a `<script type="module">` that fetches `/api/health` and renders the JSON.
- [ ] `npm run dev:client` runs Vite dev server on port 5173.
- [ ] Build output goes to `firebase/client/dist/` for Hosting to serve.

_Hosting + rewrite_

- [ ] `firebase.json` rewrites: `/api/**` → Cloud Run service `kindoo-server`; everything else → `index.html` (SPA fallback).
- [ ] Hosting site name aligned to the project (`kindoo-prod.web.app` is the default URL pre-domain-flip).

_Local emulators_

- [ ] `firebase emulators:start` brings up Firestore + Auth + Hosting emulators.
- [ ] Add a top-level `npm run dev` that runs (in parallel): Firebase emulators, Cloud Run server (against emulator Firestore), and Vite dev server. One command, all green.
- [ ] `.env.local` template documenting the env vars (`FIREBASE_PROJECT`, `FIRESTORE_EMULATOR_HOST`, etc.).

_Test infrastructure (per F11)_

- [ ] Vitest configured for `client`, `server`, `shared`; shared base config (`vitest.base.ts`).
- [ ] Test scripts: `test:unit`, `test:integration`, `test:rules`, `test:e2e`, `test:all`. Top-level `npm test` runs all five.
- [ ] `@firebase/rules-unit-testing` installed; helper module `firebase/test/lib/rules.ts` for mounting `firestore.rules` in tests (consumed in Phase 3; scaffolded here).
- [ ] supertest installed; helper `firebase/test/lib/app.ts` mounts the Express app in-process for tests (consumed in Phase 4; scaffolded here).
- [ ] Auth emulator helper `firebase/test/lib/auth.ts`: `signInAs(email, claims?)` returns a token usable by supertest; cleanup helper.
- [ ] Firestore emulator helper `firebase/test/lib/firestore.ts`: `clearAll()`, `seed(stakeId, fixtures)`, factory functions stubbed.
- [ ] Playwright installed; one smoke spec under `firebase/test/e2e/smoke.spec.ts` proving the Vite + Express + emulator stack runs end-to-end headless.
- [ ] `firebase emulators:exec` wrapper for CI: starts emulators, runs the test command, tears down.
- [ ] Coverage reporter: vitest c8 → `coverage/` (gitignored). Per-suite report on every run (no fixed threshold; per F11).
- [ ] `.github/workflows/test.yml`: runs lint + typecheck + test:unit + test:integration + test:rules + test:e2e + build on every push and PR. Failing step blocks the workflow.

_Deploy pipeline_

- [ ] `npm run deploy:staging` and `npm run deploy:prod` scripts that: build server image → push to Artifact Registry → deploy Cloud Run → build client → deploy Hosting.
- [ ] CI runs tests on every PR (see Test infrastructure above); deploys are still operator-triggered (`npm run deploy:*`) for now.

**Tests**

This phase establishes the test infrastructure that every later phase consumes; the tests here are smoke-level proof the framework works end-to-end.

_Unit_

- [ ] `version.ts` returns the stamped build timestamp in ISO format.
- [ ] Trivial pure-fn import test (e.g. `shared/email.ts`'s skeleton) — proves vitest + workspace TS imports resolve correctly.

_Integration_

- [ ] `GET /api/health` returns `{ version, builtAt, env }` with the expected shape (supertest against the in-process Express app).
- [ ] Firestore Admin SDK reads a seeded doc (`stakes/_smoketest/hello`) from the emulator inside a supertest call.

_E2E_

- [ ] Playwright smoke: Vite-served `index.html` loads at `localhost:5173`, fetches `/api/health` (proxied to local Express against the emulator), and renders the JSON. Headless Chromium.

_CI_

- [ ] `.github/workflows/test.yml` runs lint + typecheck + test:unit + test:integration + test:e2e + build on push; a contrived failing test in any layer blocks the workflow (verified before merging Phase 1).

**Acceptance criteria**

- `npm run dev` starts emulators, Vite, and Express; opening localhost:5173 fetches `/api/health` from the local Express and renders the JSON.
- `npm run deploy:staging` deploys both Hosting and Cloud Run; the staging URL responds to `/api/health` with the correct version stamp.
- A test doc seeded into the staging Firestore (`stakes/csnorth/_smoketest/hello`) is readable from Express via the Admin SDK.
- `tsc --noEmit` clean across `client`, `server`, `shared`.
- Emulator state directory is gitignored; no production credentials in the repo.
- `kindoo-prod` Firestore is empty (no data until Phase 10).

**Out of scope (deferred to later phases)**

- Authentication — Phase 2.
- Real Firestore data model — Phase 3.
- Any actual API endpoints beyond `/api/health` — Phase 4.
- Frontend beyond the smoketest page — Phase 5.
- Cloudflare Worker — Firebase Hosting will handle the custom domain natively in Phase 10. `build-plan.md` Chunk 11 is superseded.
- CI / GitHub Actions — local scripts work for the migration timeframe; CI is post-cutover polish.

---

## Phase 2 — Firebase Auth + principal resolution

**Goal:** Sign-in works end-to-end. After clicking "Sign in with Google," the user's verified identity reaches the server, the server resolves their roles against Firestore, and they land on a "Hello, [email] — you are role X" page (or `NotAuthorized`).

**Dependencies:** Phase 1.

**Six proofs (mirroring `build-plan.md` Chunk 1's structure)**

1. **Login page loads.** Visiting the app while signed out shows a "Sign in with Google" button. No errors.
2. **Sign-in produces a Firebase ID token.** Clicking the button triggers `signInWithPopup`; the client receives an ID token via `onIdTokenChanged`. The token is a real Firebase JWT (3 segments, signed by Google).
3. **Server verifies the token.** Every request to `/api/*` carries `Authorization: Bearer <id_token>`; Express middleware calls `admin.auth().verifyIdToken(token)`. Tampered tokens reject with 401; expired tokens reject (the client SDK auto-refreshes, so this should be rare).
4. **Role resolver against Firestore.** `Auth_resolveRoles(stakeId, email)` reads `stakes/csnorth/kindooManagers` and `stakes/csnorth/access` and returns the union of roles for the verified email. Email canonicalization (D4) preserved — `Utils_emailsEqual` ported to TS.
5. **Hello page renders with email + roles.** A Phase-2-only `pages/hello.ts` shows email + roles. Deleted in Phase 6 when real roster pages land. (Mirrors Chunk 1's disposable `Hello.html`.)
6. **Failure modes correct.** No token → login. Token valid but no roles → `NotAuthorized`. Token tampered or signed by wrong key → 401, client clears stored token and shows login.

**Sub-tasks**

- [ ] Enable Google sign-in provider in Firebase Auth console (both projects).
- [ ] Authorized domains: `localhost`, `kindoo-staging.web.app`, `kindoo-prod.web.app`, eventually `kindoo.csnorth.org` (Phase 10).
- [ ] Client: Firebase SDK setup (`initializeApp` with project config); `auth.ts` module exporting `signIn()`, `signOut()`, `getIdToken()`, `onIdTokenChanged(cb)`.
- [ ] Client: `rpc.ts` typed fetch wrapper. Auto-injects `Authorization: Bearer <token>`. Auto-retries once on 401 by forcing a token refresh via `getIdToken(true)`. Surfaces server-side error messages as toasts (preserves the existing pattern).
- [ ] Server: Express auth middleware that calls `admin.auth().verifyIdToken(token)`; injects `req.principal`; throws 401 on bad token.
- [ ] Server: `Auth_resolveRoles(stakeId, email)` — reads `stakes/{stakeId}/kindooManagers` and `stakes/{stakeId}/access` with email-as-doc-ID lookups (one round-trip per collection at the canonical email).
- [ ] Server: minimal `kindooManagersRepo` and `accessRepo` with `getAll()` and `getByEmail(email)` only — full CRUD lands in Phase 3.
- [ ] Shared: port `Utils_emailsEqual`, `Utils_normaliseEmail`, `Utils_canonicalEmail`, `Utils_cleanEmail` to TS in `shared/email.ts`. Unit tests carry over from `Utils_test_*` (port to vitest or jest).
- [ ] Shared: port `Auth_requireRole`, `Auth_requireWardScope`, `Auth_findBishopricRole`, `Auth_requestableScopes` to TS in `shared/principal.ts`.
- [ ] Server: Cloud Function trigger on `auth.user().onCreate` (and a fallback first-API-call check) that writes `users/{uid}` with `{email, displayName, lastSignIn}`. Updates `lastSignIn` on every authenticated request (cheap; debounced if needed).
- [ ] Client: `pages/login.ts`, `pages/hello.ts`, `pages/notAuthorized.ts`. Topbar shell with email + sign-out button.
- [ ] Seed staging Firestore manually via the Firebase console or a small script: one `stakes/csnorth` doc + one `stakes/csnorth/kindooManagers/<your-canonical-email>` doc. Just enough to prove role resolution.

**Tests**

The six proofs from `build-plan.md` Chunk 1 are restated here as automated tests, not manual walkthroughs. Plus middleware coverage and email-canonicalization regressions ported from `Utils_test_*`.

_Unit_

- [ ] `Utils_normaliseEmail`: cases ported from existing Apps Script tests — `Alice.Smith@Gmail.com`, `alicesmith+church@googlemail.com`, `alice@csnorth.org` (dots retained on non-Gmail), `  Bob@Foo.COM  `, googlemail.com → gmail.com folding.
- [ ] `Utils_emailsEqual`: typed-form variants → equal; different addresses → not equal; case + whitespace boundary cases.
- [ ] `Utils_canonicalEmail`: round-trip is one-way (canonical doesn't reverse to typed — intentional).
- [ ] `Auth_requireRole`: matcher hits → returns; no match → throws `Forbidden`.
- [ ] `Auth_requireWardScope`: bishopric of own ward → ok; manager → ok; stake → ok; bishopric of other ward → `Forbidden`; no roles → `Forbidden`.
- [ ] `Auth_findBishopricRole`, `Auth_requestableScopes`: per their existing Apps Script behaviour.

_Integration (Auth + Firestore emulators + supertest)_

- [ ] Auth middleware:
  - Valid token → `req.principal` populated; pass-through to handler.
  - Missing `Authorization` header → 401.
  - Tampered token → 401.
  - Token signed by wrong project → 401.
  - Expired token → 401 (with the documented refresh-then-retry behaviour at the rpc layer).
- [ ] `Auth_resolveRoles(stakeId, email)`:
  - Email in `kindooManagers` only → `[{type:'manager'}]`.
  - Email in `access` with `scope='stake'` only → `[{type:'stake'}]`.
  - Email in `access` with `scope='CO'` only → `[{type:'bishopric', wardId:'CO'}]`.
  - Email in all three → union (3 roles).
  - Email canonicalization variant (`a.b+x@gmail.com` registered, lookup with `ab@gmail.com`) → resolves identically.
  - No matches → empty array.
- [ ] `users/{uid}` write:
  - First sign-in writes `{email, lastSignIn, displayName?}`.
  - Second sign-in updates `lastSignIn` only.
  - Doc is keyed on `auth.uid`, not email (verified via emulator inspection).

_E2E (Playwright)_

- [ ] Sign in via Auth emulator → bootstrap call succeeds → Hello page renders email + roles.
- [ ] Sign out → returns to login; subsequent rpc call → 401.
- [ ] Hand-invalidated token in browser storage → next rpc → 401 → client clears state, returns to login (Proof 6).

The six Phase-2 proofs each map to one or more tests above; no proof is "verified manually" — every one is a passing `it()` block.

**Acceptance criteria**

- All six proofs pass against the staging Firebase project.
- `stakeId='csnorth'` is hardcoded in the API layer (passed to repos as first arg). The constant is consolidated in one place (`server/src/constants.ts`) so Phase 11 can grep-and-fix.
- Email canonicalization tests pass (the existing `Utils_test_*` cases ported).
- Sign-out clears the client-side Firebase Auth state and returns to the login page.
- Refreshing the page mid-session keeps you signed in (Firebase Auth persists in IndexedDB by default).
- The `users/{uid}` doc gets written on first sign-in and updated on subsequent sign-ins.
- A user not in `kindooManagers` and not in `access` lands on `NotAuthorized`.
- Apps Script Identity project is **NOT** yet deleted — it stays as the prod auth source until Phase 10. The Firebase auth flow runs only against staging.

**Out of scope**

- Real role-based pages — Phase 6/7.
- Multi-stake principal shape (`memberships` map) — Phase 11.
- Platform superadmin — Phase 12.
- Firestore writes — Phase 3.
- Custom claims — deferred indefinitely per F7.
- Production cutover — Phase 10. Staging only in this phase.

**Non-obvious concerns to watch**

- `signInWithPopup` is blocked by some browsers in incognito mode and by some popup blockers. Acceptable for v1; document in the user-facing FAQ. `signInWithRedirect` is the fallback if it becomes a real issue.
- `verifyIdToken` makes a network call to fetch Google's signing keys — cached internally by the Admin SDK with the right TTL, so subsequent calls are cheap. No need to add our own cache.
- The `onIdTokenChanged` listener fires not only on sign-in/sign-out but also every hour on auto-refresh. Make sure the rpc layer reads the *current* token via `getIdToken()` rather than a stale captured value.

---

## Phase 3 — Firestore repos + security rules

**Goal:** All ten collections exist under `stakes/csnorth/` with the multi-tenant shape locked in. Every repo has full CRUD with TS types. Every write wraps in a Firestore transaction. AuditLog discipline is preserved (caller passes `actor_email`; one audit row inside the same transaction). Security rules enforce stake-scope at the rule layer.

**Dependencies:** Phase 2.

**Document-ID conventions** (locked in here, used everywhere downstream)

| Collection | Doc ID | Notes |
| --- | --- | --- |
| `stakes/{stakeId}` | human-readable slug | `csnorth`, `someother` |
| `stakes/{stakeId}/wards/{wardCode}` | natural key (2-letter `ward_code`) | matches LCR tab name; same as today |
| `stakes/{stakeId}/buildings/{buildingId}` | URL-safe slug derived from `building_name` | one-time slugify; `building_name` field carries display form |
| `stakes/{stakeId}/kindooManagers/{canonicalEmail}` | canonical email | lookup is a doc-get, not a query |
| `stakes/{stakeId}/access/{canonicalEmail}__{scope}__{calling}` | composite key, `__`-separated, calling URL-encoded | enforces composite-PK uniqueness via doc existence |
| `stakes/{stakeId}/seats/{seatId}` | UUID (Firestore-auto) | `seat_id` field carries the same value for client compat |
| `stakes/{stakeId}/requests/{requestId}` | UUID | same as seats |
| `stakes/{stakeId}/auditLog/{ts_uuid}` | `<ISO ts>_<uuid suffix>` | sortable by ID; eliminates need for a `timestamp` index for newest-first |
| `stakes/{stakeId}/templates/ward/callings/{callingName}` | natural key, URL-encoded | `*` wildcard in the name preserved verbatim |
| `stakes/{stakeId}/templates/stake/callings/{callingName}` | same | |

The `Config` tab collapses into the `stakes/{stakeId}` document's fields — `stake_name`, `callings_sheet_id`, `stake_seat_cap`, `bootstrap_admin_email`, `setup_complete`, `expiry_hour`, `import_day`, `import_hour`, `notifications_enabled`, `last_over_caps_json`, `last_import_at`, `last_import_summary`, `last_expiry_at`, `last_expiry_summary`. Read access becomes a single doc-get instead of a tab scan.

**Sub-tasks**

_Transaction helper (replaces `Lock_withLock`)_

- [ ] `server/src/db/withTransaction.ts` — wraps `db.runTransaction(async (tx) => {...})` with logging, error normalization, and a uniform retry policy. Inside the transaction the caller does reads then writes; AuditLog write is one of the writes.
- [ ] Provide a `TransactionContext` type that bundles `tx`, the principal, and the stakeId so repos don't need to thread args three deep.
- [ ] Document the read-then-write contract in a README — Firestore transactions require reads before any write, and writes are buffered until commit. This is structurally different from `LockService.getScriptLock` and worth a dedicated short doc.

_Repos (one TS module per collection)_

- [ ] `server/src/repos/stakeRepo.ts` — read/update the parent stake doc (replaces `ConfigRepo`).
- [ ] `wardsRepo.ts`, `buildingsRepo.ts`, `kindooManagersRepo.ts`, `accessRepo.ts`, `seatsRepo.ts`, `requestsRepo.ts`, `auditRepo.ts`, `templatesRepo.ts`.
- [ ] Each repo exports typed read functions (`getAll(stakeId)`, `getById(stakeId, id)`, `getByScope(stakeId, scope)`, etc.) and typed write functions (`insert(tx, stakeId, row)`, `update(tx, stakeId, id, patch)`, `delete(tx, stakeId, id)`).
- [ ] Read functions take an optional `tx?` argument so they can compose inside a transaction.
- [ ] All types in `shared/types/<entity>.ts` so client and server share the wire shape.

_AuditLog discipline preserved_

- [ ] `auditRepo.ts#write(tx, stakeId, {actor_email, action, entity_type, entity_id, before, after})` — caller passes `actor_email` explicitly; no environment fallback (preserves architecture.md §5 invariant).
- [ ] Automated actors `"Importer"` and `"ExpiryTrigger"` preserved as literal strings.
- [ ] `before_json` / `after_json` are stored as Firestore objects (not JSON strings) since Firestore handles nested objects natively. The `_json` suffix is dropped from field names; the new field names are `before` and `after`.
- [ ] AuditLog read uses ID-based ordering (newest-first by reverse ID lex sort) so the manager Audit Log page doesn't need a separate timestamp index.

_Composite-key uniqueness on Access_

- [ ] `accessRepo.makeId(canonical_email, scope, calling)` → URL-encoded composite key. Insert is a transactional `tx.create(docRef)` which throws `ALREADY_EXISTS` on collision — preserves the architecture.md / TASKS.md #1 rule that any insert (importer or manual) blocks any other insert at the composite key.
- [ ] Source field (`importer` | `manual`) preserved exactly; importer's delete-not-seen step scopes to `source='importer'` only.

_Cross-tab invariants_

- [ ] Stay at the API layer (Phase 4), not the repo. Repo files have zero cross-collection awareness — same discipline as `architecture.md` §7.

_Email canonicalization (D4) preserved_

- [ ] All repos that touch emails (kindooManagers, access, seats, requests) accept emails as-typed and canonicalize internally for lookups + composite-key construction. The typed form lands in fields; the canonical form lands in doc IDs (where applicable).

_Source-row hashing (D5) preserved_

- [ ] `shared/hash.ts#hashRow(scope, calling, canonical_email)` — port the existing `Utils_hashRow` to TS using `crypto.createHash('sha256')`.

_Security rules_

- [ ] `firestore.rules`:
  ```
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      function isAuthed() { return request.auth != null; }
      function hasMembership(stakeId) {
        return isAuthed() && (
          exists(/databases/$(database)/documents/stakes/$(stakeId)/kindooManagers/$(canonical(request.auth.token.email)))
          || existsAccessForUser(stakeId)
        );
      }
      // ... helpers ...
      match /stakes/{stakeId} {
        allow read:  if hasMembership(stakeId);
        allow write: if false;  // server-only via Admin SDK
      }
      match /stakes/{stakeId}/{document=**} {
        allow read:  if hasMembership(stakeId);
        allow write: if false;
      }
      match /users/{uid} {
        allow read, write: if request.auth.uid == uid;
      }
    }
  }
  ```
- [ ] All writes are forbidden at the rules layer — only the Cloud Run server (using Admin SDK) can write. This matches the F10 stance.
- [ ] Rules tests via `@firebase/rules-unit-testing` + vitest. At minimum: authenticated non-member can't read; member can read own stake's docs; non-server can't write.

_Per-request memo (replaces `Sheet_getTab`)_

- [ ] Not needed in the same form — Firestore reads aren't expensive enough to memoize per-request. Skip.

**Tests**

Per-repo coverage plus rules-emulator scenarios. The composite-key uniqueness on Access is the main correctness invariant and gets explicit tests across multiple paths.

_Unit_

- [ ] `accessRepo.makeId(canonical, scope, calling)`: deterministic; URL-encoded; collisions impossible across distinct inputs.
- [ ] `shared/hash.ts#hashRow(scope, calling, canonical_email)`: matches Apps Script's `Utils_hashRow` for ten known fixture inputs (regression guard for importer stability across the migration).
- [ ] `Utils_todayIso(tz)`: returns the same string the Apps Script version returned for fixed Date inputs (regression guard for expiry).
- [ ] Building-name slugifier: `Cordera Building` → `cordera-building`; deterministic; collision detection where applicable.

_Repo (Firestore emulator, one suite per repo)_

For each repo (stakeRepo, wardsRepo, buildingsRepo, kindooManagersRepo, accessRepo, seatsRepo, requestsRepo, auditRepo, templatesRepo):
- [ ] CRUD round-trip: insert → read → update → read → delete → read-empty.
- [ ] Insert wraps a transaction; verified by checking AuditLog row written in the same `runTransaction` callback.
- [ ] Update is partial (only specified fields change; other fields preserved).
- [ ] Delete removes only the targeted doc.

Repo-specific:
- [ ] `accessRepo`: composite-key insert collision throws; second insert with `source='manual'` against existing `source='importer'` row blocks (B1 invariant); insert with email variant (`a.b+x@gmail.com`) collides with `ab@gmail.com` row (canonical-key D4).
- [ ] `seatsRepo`: `bulkInsertAuto` ordering preserved; `getActiveByScopeAndEmail` returns only `manual`/`temp` for that scope+email; immutable fields (`scope`, `type`, `seat_id`, `member_email`) rejected on update.
- [ ] `requestsRepo`: status transition guard (only listed fields mutable); `pending` is the only legal starting state.
- [ ] `auditRepo`: doc IDs sortable by reverse lex (newest-first); `before`/`after` stored as nested objects (not JSON strings).
- [ ] `kindooManagersRepo`: lookup by typed-form variant resolves to the canonical-keyed doc.
- [ ] `stakeRepo`: partial `update` of any single field doesn't clobber peer fields; `setup_complete=true` audit row written by the API layer (verified end-to-end in Phase 4).

_Rules (rules-unit-testing)_

- [ ] Anonymous read of `stakes/csnorth/seats/{any}` → denied.
- [ ] Authenticated user with no `kindooManagers` or `access` membership → read denied.
- [ ] Authenticated stake member → reads succeed across every subcollection.
- [ ] Authenticated user signed into stake A, attempting read of stake B → denied.
- [ ] Authenticated client-side write to any stake doc or subcollection → denied (server-only).
- [ ] User reads own `users/{uid}` → ok.
- [ ] User reads other `users/{otherUid}` → denied.
- [ ] Both `get` and `list` operations covered (Firestore evaluates rules separately per operation).

Coverage gate: every repo function listed in `firebase/server/src/repos/index.ts` has at least one passing test.

**Acceptance criteria**

- All ten collections defined; each repo passes its unit-test suite.
- Every write wraps in a Firestore transaction.
- Every write emits an AuditLog doc inside the same transaction.
- Composite-key uniqueness on Access verified by emulator test (insert collision throws).
- Email canonicalization: dot/`+suffix` variants resolve to the same `kindooManagers` doc (verified via test against staging).
- Security-rule tests pass: anon can't read; cross-stake reads forbidden; client-side writes forbidden.
- All staging data still empty except for the seed from Phase 2.
- Type-check clean; no `any` in repo signatures.

**Out of scope**

- API layer wiring — Phase 4.
- Cache layer (the equivalent of Apps Script Chunk 10.5) — defer until measured need on Firebase.
- Real data — Phase 10.
- Frontend integration — Phase 6/7.

**Open question to resolve before starting Phase 3**

- **Buildings doc-ID slugging.** Today `building_name` is the natural PK and is referenced verbatim from `wards.building_name`, `seats.building_names`, etc. As a Firestore doc ID, `building_name` may contain spaces or punctuation that need encoding. Two options: (a) slugify on write (`Cordera Building` → `cordera-building`) and add a `building_name` display field; or (b) URL-encode the natural key as the doc ID. (a) is cleaner; (b) requires zero refactor of cross-references. Recommend (a). Confirm with user before starting.

---

## Phase 4 — API layer (Express)

**Goal:** Every Apps Script API endpoint has an Express equivalent. The HTTP shape mirrors the current `google.script.run` shape closely enough that the frontend port (Phases 5–7) is mechanical.

**Dependencies:** Phase 3.

**Sub-tasks**

_Express app structure_

- [ ] `server/src/app.ts` — Express setup: JSON body parsing, CORS (allow Hosting origin), global middleware stack.
- [ ] `server/src/middleware/auth.ts` — verifies Firebase ID token; resolves `Auth_principalFrom(stakeId, token)`; attaches `req.principal` and `req.stakeId`.
- [ ] `server/src/middleware/error.ts` — converts thrown errors to JSON responses. Mapping: `Forbidden` → 403, `NotFound` → 404, `BadRequest` → 400, `Conflict` → 409, anything else → 500 with logged stack.
- [ ] `server/src/middleware/log.ts` — request log line per endpoint with elapsed ms, principal email, status code.
- [ ] One Express router per `api/` namespace: `apiShared`, `apiBishopric`, `apiStake`, `apiRequests`, `apiManager`.

_URL convention_

- [ ] `POST /api/stakes/:stakeId/<resource>/<action>` for action-style endpoints (`POST /api/stakes/csnorth/manager/requests/complete`).
- [ ] `GET /api/stakes/:stakeId/<resource>` for reads.
- [ ] Body for inputs (replaces positional rpc args).
- [ ] JSON for everything; no form posts.
- [ ] `:stakeId` is `csnorth` everywhere from the client until Phase 11; the path param exists from day 1 so Phase 11 doesn't have to refactor every route.

_Endpoint port (one section per existing API file)_

- [ ] **ApiShared**: `POST /api/stakes/:stakeId/shared/bootstrap` (returns `{principal, pageBundle?, currentPageModel}`). Page bundle is JSON page-models, not HTML strings (client owns rendering — see Phase 5).
- [ ] **ApiBishopric**: `GET /api/stakes/:stakeId/bishopric/roster`. Scope derived from `principal`, not from a request param (preserves the spoof guard).
- [ ] **ApiStake**: `GET /api/stakes/:stakeId/stake/roster`, `GET /api/stakes/:stakeId/stake/wardRoster?wardCode=X`, `GET /api/stakes/:stakeId/stake/wards`.
- [ ] **ApiRequests** (consolidated, bishopric OR stake): `POST /api/stakes/:stakeId/requests/submit`, `GET /api/stakes/:stakeId/requests/listMy?scope?`, `POST /api/stakes/:stakeId/requests/cancel`, `GET /api/stakes/:stakeId/requests/checkDuplicate?memberEmail=&scope=`.
- [ ] **ApiManager**: every `ApiManager_*` endpoint from `src/api/ApiManager.gs` gets a route. ~30 endpoints — list maintained in `firebase/server/src/routes/manager.ts`.

_Service-layer port_

- [ ] `server/src/services/RequestsService.ts` — `submit`, `complete`, `reject`, `cancel`. Logic preserved verbatim from `RequestsService.gs`; transaction wraps each.
- [ ] `server/src/services/Rosters.ts` — shared row mapper + per-scope utilization math.
- [ ] `server/src/services/Bootstrap.ts` — wizard state machine endpoints. Logic preserved.
- [ ] `server/src/services/Importer.ts`, `Expiry.ts` — skeleton only this phase; real implementations Phase 8.
- [ ] `server/src/services/EmailService.ts` — stubbed (logs `[EmailService] would send: {to, subject, body}` to stdout); real SendGrid integration Phase 9. The function signatures match the existing `notifyManagersNewRequest` etc. so Phase 7 can wire them up correctly.
- [ ] `server/src/services/TriggersService.ts` — Cloud Scheduler integration; skeleton only this phase, real Phase 8.

_Test suite_

- [ ] `firebase/server/test/<endpoint>.test.ts` — supertest + Firestore emulator. Per endpoint: at least one happy-path + one forbidden-path + one validation-error case.
- [ ] Port the `ApiManager_test_forbidden` discipline as test cases (CO bishopric fails stake-scope; CO bishopric fails GE-scope; etc.).
- [ ] `npm run test:server` runs the full suite against the emulator.

**Tests**

End-to-end HTTP coverage via supertest. Each endpoint gets a happy-path + a forbidden-path; high-stakes endpoints (request lifecycle, manager queue) get more. The `ApiManager_test_forbidden` discipline from the Apps Script side ports as a structured suite.

_Unit (mocked repos for service-layer isolation; integration tests cover the real wiring)_

- [ ] `RequestsService.submit`: validates draft (member name required for add types; not for remove); rejects remove with no active manual/temp seat; rejects duplicate pending remove for same scope+email.
- [ ] `RequestsService.complete`: asserts `status==='pending'`; on remove with missing seat → R-1 no-op completion path with `completion_note` populated.
- [ ] `RequestsService.reject`: requires non-empty reason; asserts pending.
- [ ] `RequestsService.cancel`: requires principal email matches `requester_email` (canonical-equal); asserts pending.
- [ ] Error-mapping middleware: `Forbidden`/`NotFound`/`BadRequest`/`Conflict`/unknown → 403/404/400/409/500; 500 logs the stack but doesn't leak it in the response body.

_Integration (supertest + Firestore + Auth emulators)_

For every endpoint listed in `firebase/server/src/routes/*.ts`:
- [ ] Happy path: signed in as the right role → 200 + expected response shape.
- [ ] Forbidden: signed in as a wrong role → 403 with `Forbidden` message.
- [ ] Validation error: missing required field → 400 with field-specific message.

Endpoint-specific:
- [ ] `POST /api/stakes/csnorth/requests/submit` (add_manual) for a seat-less member → 200 + pending row written + audit row in same transaction.
- [ ] Same for a member already with a seat → still 200 (warning not block) + duplicate flagged in response.
- [ ] `POST /api/stakes/csnorth/manager/requests/complete`:
  - Pending add_manual → 200 + Seat inserted + Request flipped + 2 audit rows.
  - Pending remove with seat present → 200 + Seat deleted + Request flipped + 2 audit rows.
  - Pending remove with seat already gone (R-1) → 200 + Request flipped + `completion_note` set + 1 audit row.
  - Already-complete request → 409 with "no longer pending (current status: complete)".
- [ ] `POST /api/stakes/csnorth/manager/requests/reject`: empty reason → 400; valid → 200 + audit.
- [ ] `POST /api/stakes/csnorth/requests/cancel`:
  - Original requester cancels own pending → 200.
  - Different user → 403.
  - Manager cancelling someone else's request → 403 (managers reject rather than cancel).
- [ ] `POST /api/stakes/csnorth/manager/seats/update`: manual/temp row → 200; auto row → 400 ("auto seats are importer-owned"); immutable field in patch → 400.
- [ ] Self-approval policy: manager-and-bishopric submits + completes own request → both 200; audit shows distinct `requester_email` and `completer_email` fields (with the same value).
- [ ] Email-service stub invoked with expected payload shape per endpoint (verified via spy).
- [ ] `warning` field surfaces on response when stub email-service throws.
- [ ] `ApiManager_test_forbidden` ports: CO bishopric fails stake-scope reads; CO bishopric fails GE-scope reads; CO bishopric passes CO-scope reads; manager-only role fails `Auth_findBishopricRole` → null.

Coverage gate: every endpoint in `firebase/server/src/routes/*.ts` has at least one happy + one forbidden test before the phase ships.

**Acceptance criteria**

- Every Chunk 1–10 acceptance criterion that involves a server-side API path has a passing Express test.
- All write endpoints use transactions.
- Forbidden tests: each endpoint rejects when the principal lacks the required role (HTTP 403).
- AuditLog gets a row for every write; verified by transaction post-conditions in tests.
- Email service is invoked but stubbed; the API contract for `warning` field on partial failures is preserved.
- Self-approval policy preserved (manager completing their own request is allowed, audit shows distinct submitter / completer).
- R-1 race for remove preserved (no-op completion with `completion_note`).
- Importer and Expiry endpoints exist with skeleton handlers that 501 (or invoke a stub) — real implementations land in Phase 8.

**Out of scope**

- Frontend wiring — Phase 5/6/7.
- Real importer/expiry implementations — Phase 8.
- Real email sending — Phase 9.
- Stake-id from URL versus hardcoded — Phase 11. The path param is in place; the client just always passes `csnorth`.

---

## Phase 5 — Frontend SPA shell + auth flow

**Goal:** A Vite + TS client that handles sign-in, holds the Firebase Auth ID token, calls the rpc layer with auth headers, and renders a Layout shell with Nav and a content slot. One placeholder page proves the loop works end-to-end against the real Express backend.

**Dependencies:** Phase 2 (auth) + Phase 4 (`bootstrap` endpoint exists). Can develop in parallel with Phase 4 if a stub `bootstrap` is built first.

**Sub-tasks**

_Project structure_

- [ ] `firebase/client/src/main.ts` — entry point.
- [ ] `firebase/client/src/auth/` — Firebase Auth wrappers.
- [ ] `firebase/client/src/rpc/` — fetch wrapper + typed endpoint helpers.
- [ ] `firebase/client/src/router/` — client-side routing (History API).
- [ ] `firebase/client/src/layout/` — shell, nav, topbar, toast.
- [ ] `firebase/client/src/lib/` — render helpers (escapeHtml, renderUtilizationBar, renderRosterCards, etc.).
- [ ] `firebase/client/src/pages/` — one module per page; each exports `init(model, queryParams)` and optional `teardown()`.
- [ ] `firebase/client/src/styles/` — plain CSS (port `Styles.html`); split into `base.css`, `nav.css`, `roster.css`, `dashboard.css`, etc.

_Auth + rpc_

- [ ] `auth/firebase.ts` — initializeApp + onIdTokenChanged + signIn / signOut helpers.
- [ ] `rpc/client.ts` — `rpc<TReq, TRes>(path, body): Promise<TRes>`. Auto-injects Bearer token. Auto-retries once on 401 by forcing token refresh. Surfaces server's `warning` field as a toast. Type-safe via shared types.
- [ ] `rpc/endpoints.ts` — typed wrappers per endpoint: `Bishopric_roster()`, `Manager_dashboard()`, etc. Each wrapper knows its URL path and types.

_Routing_

- [ ] `router/router.ts` — History API; reads `?p=<page>&...`. Intercepts `<a data-page="...">` clicks. `pushState` per nav, `popstate` for back/forward. URL convention preserves the existing `?p=mgr/seats&ward=CO` shape so deep links from emails / bookmarks survive.
- [ ] Filter-state forwarding: query params survive nav (preserves Chunk 10.6's contract).

_Layout shell_

- [ ] `layout/shell.ts` — renders topbar (email + version + sign-out), Nav, content slot. Stable across navigation; only content slot swaps.
- [ ] `layout/nav.ts` — role-aware nav links generated from the principal's roles. Active page highlighted.
- [ ] `layout/toast.ts` — toast helper preserving the existing `info`/`warn`/`error` types.

_Page bundle pattern_

- [ ] On bootstrap, server returns `{principal, allowedPages: [...], currentPage: {id, model}, queryParams}`. Client owns rendering for every page (no server-side HTML).
- [ ] Per-page module shape:
  ```ts
  // pages/manager/dashboard.ts
  export interface DashboardModel { /* ... */ }
  export function init(model: DashboardModel, queryParams: URLSearchParams): TeardownFn | void {
    document.querySelector('#content')!.innerHTML = render(model);
    // wire listeners; return optional teardown for cancelable resources
  }
  ```
- [ ] Nav clicks: client-side dispatch — call the page's `init(model)` with a freshly-fetched model (one rpc per page-data load); content swap is synchronous after data arrives. (Differs from Apps Script Chunk 10.6 which pre-bundled HTML at bootstrap; the TS version pre-bundles only the page CODE via Vite, and fetches data per nav. Cleaner; data freshness wins over a saved rpc.)
- [ ] Shared loading state: `<div class="empty-state">Loading…</div>` placeholder while the page-data rpc is in flight.

_ClientUtils equivalents_

- [ ] Port to `lib/`:
  - `escapeHtml`, `formatDate`, `formatDateTime`
  - `renderUtilizationBar`
  - `renderRosterTable`, `renderRosterCards`
  - `rosterRowHtml`, `rosterCardHtml`
  - `renderEmptyState`
- [ ] All TS, all typed.

_Styles_

- [ ] Port `Styles.html` to plain CSS. Mechanical translation; keep selectors and values identical so the visual result is unchanged.
- [ ] Vite handles CSS imports per-module if useful; otherwise one global stylesheet is fine.

_Placeholder page_

- [ ] `pages/hello.ts` (Phase 2's hello, now rendered through the shell). Deleted in Phase 6.

**Tests**

Frontend shell + auth flow. Render helpers unit-tested in jsdom; user-visible flow E2E-tested via Playwright.

_Unit (vitest + jsdom)_

- [ ] `escapeHtml` against XSS-y inputs (`<script>`, `<>"&'`, mixed cases).
- [ ] `formatDate` / `formatDateTime` against fixed Date inputs in script tz; null/undefined renders as empty string.
- [ ] `renderUtilizationBar`: under cap → blue class; ≥90% → amber; over cap → red + OVER CAP label; cap unset → neutral text only, no bar.
- [ ] `renderRosterCards` / `renderRosterTable`: empty state shown when rows empty; row count matches input; opts (`showScope`, `rowActions`, `preview`) propagate.
- [ ] `rpc.ts`:
  - Builds correct URL path and method.
  - Attaches `Authorization: Bearer <token>` from current `getIdToken()`.
  - On 401 → calls `getIdToken(true)` and retries once; second 401 → throws.
  - On 4xx with `error` field → throws with that message.
  - On 200 with `warning` field → returns data + invokes toast handler with warning.
  - On network failure → throws with a recognizable error type.
- [ ] `router.ts`:
  - `pushState` on intra-app nav clicks; URL reflects new page+params.
  - `popstate` triggers re-render with restored params.
  - Direct deep-link with `?p=foo&ward=CO` parses both into `queryParams`.

_E2E (Playwright)_

- [ ] Sign-in flow: Auth emulator → click Sign In → popup completes → token issued → bootstrap rpc → Hello page renders within the shell.
- [ ] Sign-out: click Sign Out → returns to login; sessionStorage cleared.
- [ ] Browser back / forward across 3+ nav clicks: forward through pages, back, forward — content matches each step.
- [ ] Direct deep-link: open `localhost:5173/?p=hello` cold → bootstraps + lands on hello.
- [ ] Mobile viewport (375×667): no horizontal scroll; nav usable; topbar legible.
- [ ] Topbar shows email after sign-in; version stamp visible; sign-out button works.

Coverage gate: every render helper in `client/src/lib/` has at least one unit test; every E2E listed above has a passing Playwright spec.

**Acceptance criteria**

- Sign-in flow works: button click → popup → token issued → bootstrap call succeeds → hello page renders inside the shell.
- Sign-out clears state and returns to login.
- 401 from server triggers automatic token refresh; if refresh fails, returns to login.
- Layout shell stable across navigation (no full page reload on nav clicks).
- Browser back/forward work for in-app navigation.
- Direct deep-link works (refreshing on `?p=hello` re-bootstraps and lands on the hello page).
- Topbar shows correct email; version stamp visible.
- Mobile viewport (375px) usable.
- `tsc --noEmit` clean across client.
- Build (`npm run build:client`) produces `firebase/client/dist/` deployable to Hosting.

**Out of scope**

- Any real page beyond `hello` — Phase 6+.
- Filter-state URL rewrite on filter change (Phase 6 if a page needs it).
- Stake selector UI — Phase 12.
- Stake switcher in topbar — Phase 12.

**Non-obvious concerns to watch**

- `signInWithPopup` returns a promise; on success the `onIdTokenChanged` listener fires. The bootstrap rpc should wait for the token to be available before calling — race-condition-prone if you bootstrap on page load before sign-in completes.
- `getIdToken()` is async and may force-refresh; callers must `await` it. The rpc helper's auto-injection handles this; direct callers should not exist.
- Vite's dev server proxies `/api/**` to the local Cloud Run via the dev script. Production goes through Hosting's `firebase.json` rewrite. Two different paths to the same backend; document.

---

## Phase 6 — Page ports — read-side

**Goal:** Every read-only page from Apps Script renders correctly on Firebase against real Firestore data, with behaviour preservation. No new features; no UI redesigns.

**Dependencies:** Phase 5.

**Sub-tasks (one per page)**

- [ ] `pages/bishopric/roster.ts` — ward roster, utilization bar, multi-ward dropdown for bishopric counsellors with multiple ward roles, "removal pending" badges.
- [ ] `pages/stake/roster.ts` — stake pool roster, utilization bar.
- [ ] `pages/stake/wardRosters.ts` — dropdown + read-only ward roster.
- [ ] `pages/manager/allSeats.ts` — full roster with ward / building / type filters; per-scope summary cards with utilization bars; total-seat utilization bar when scope is "All"; deep-link filter state via URL.
- [ ] `pages/manager/dashboard.ts` — five cards (Pending, Recent Activity, Utilization, Warnings, Last Operations); single rpc for the aggregate; deep-links into Queue / Audit Log / AllSeats / Import.
- [ ] `pages/manager/auditLog.ts` — filter panel (deep-link via URL params), Next/Prev pagination, per-row collapsed summary + `<details>` diff. `complete_request` rows surface `completion_note` inline.
- [ ] `pages/manager/access.ts` — read view (importer-sourced + manual); write actions land in Phase 7.
- [ ] `pages/myRequests.ts` — requester's own request list; cancel button on pending rows; rejection reason on rejected; multi-role scope filter.
- [ ] Delete `pages/hello.ts` (was Phase-2 placeholder).
- [ ] Update `nav.ts` to expose all read-side pages.

**Tests**

Read-side pages: each page's render helper unit-tested with synthetic models; each page E2E-tested against emulator-seeded data.

_Unit (vitest + jsdom, per page)_

For each page (`bishopric/roster`, `stake/roster`, `stake/wardRosters`, `manager/allSeats`, `manager/dashboard`, `manager/auditLog`, `manager/access`, `myRequests`):
- [ ] Render with empty state (no seats, no requests, etc.) → expected empty-state HTML.
- [ ] Render with one row → row markup correct, action affordances per role.
- [ ] Render with full fixture → no exceptions, expected counts.

Page-specific:
- [ ] `manager/dashboard`: five cards render with all-empty model (zero pending, no activity, no wards configured, no warnings, never-run ops); same with all-populated model.
- [ ] `manager/auditLog`: pagination state reflected in counter ("Showing 11–20 of 87"); `<details>` expansion in row HTML; `complete_request` rows surface `completion_note` inline.
- [ ] `manager/allSeats`: filter row stacks at 375px; per-scope summary cards render; total-utilization bar shown when scope filter is "All" and `stake_seat_cap` is set.
- [ ] `bishopric/roster`: ward-dropdown rendered iff principal has multiple bishopric ward roles.

_Integration_

- [ ] Each read endpoint returns a model matching its TS interface in `shared/types/` (verified by an `expectTypeOf` runtime check or zod schema parse on response).

_E2E (Playwright, per page)_

For each read page:
- [ ] Sign in as the appropriate role → navigate to the page → renders without error against emulator-seeded data.
- [ ] Filter via URL deep-link (e.g. `?p=mgr/seats&ward=CO`) → both filters pre-populated.
- [ ] Mobile viewport (375px) → no horizontal page scroll; tables scroll within their container.

Page-specific E2E:
- [ ] `manager/auditLog`: Next/Prev paginates correctly; counter updates.
- [ ] `manager/dashboard`: deep-links land on the correct downstream page with correct filter state pre-applied.
- [ ] Multi-ward bishopric: switching the ward dropdown re-renders the other ward's roster.
- [ ] Stake `wardRosters`: dropdown selection re-fetches and renders.

Coverage gate: every read-side page has unit (render) + E2E (smoke) coverage.

**Acceptance criteria**

- Every Chunk 5 / Chunk 10 acceptance criterion for read paths passes against Firestore data populated from a recent Sheet snapshot.
- Filter state survives URL deep-links (e.g. `?p=mgr/seats&ward=CO&type=manual` lands with both filters pre-populated).
- Pagination on Audit Log works (Next / Prev counters update; "Showing 1–N of M" hint accurate).
- Dashboard cards render with empty state, with one ward, with all wards.
- Mobile (375px) usable across all pages.
- Card rendering matches the post-TASKS.md-#2 behaviour (no nested table-in-table; cards have shared border, tight padding).
- `tsc --noEmit` clean.

**Out of scope**

- Write paths — Phase 7.
- Bootstrap wizard — Phase 7.
- Inline edits on AllSeats — Phase 7.

**Non-obvious concerns to watch**

- The `?p=mgr/seats` deep-link contract assumes a single pageId-to-route mapping. Preserve it exactly for muscle memory + bookmarks.
- `ApiManager_dashboard`'s aggregate response shape is consumed by the Dashboard page in five places. Don't reshape during port — keep the wire shape identical and refactor later if needed.

---

## Phase 7 — Page ports — write-side

**Goal:** Every write-bearing page works on Firebase. The full request lifecycle (submit → manager queue → complete / reject / cancel) is exercised end-to-end. Bootstrap wizard runs against the new stack (still scoped to `csnorth`).

**Dependencies:** Phase 6.

**Sub-tasks**

_Request lifecycle pages_

- [ ] `pages/newRequest.ts` — add_manual / add_temp form, scope selector for multi-role principals, building checkboxes for stake scope, duplicate-warning inline, member-name required client- + server-side.
- [ ] `pages/myRequests.ts` cancel action.
- [ ] `pages/manager/requestsQueue.ts` — filter by state (Pending / Complete) / ward / type; pending cards with metadata + duplicate warning + Mark Complete / Reject; resolved cards with resolver / timestamp / rejection-reason.
- [ ] Mark Complete dialog with Buildings checkbox group + at-least-one-required gate (client + server).

_Manager admin pages_

- [ ] `pages/manager/configuration.ts` — every editable table (Wards, Buildings, KindooManagers, WardCallingTemplate, StakeCallingTemplate, Config-key fields).
- [ ] `pages/manager/access.ts` write actions — Add Manual Access form + Delete on manual rows.
- [ ] `pages/manager/import.ts` — Import Now button, status display, over-cap banner. (Importer endpoint is a stub at Phase 7; real impl Phase 8.)
- [ ] `pages/manager/allSeats.ts` inline edit — member_name, reason, building_names; plus dates on temp.
- [ ] Configuration page Triggers panel (list + reinstall) — endpoints work but the Cloud Scheduler integration is stub-only until Phase 8.

_Bishopric / Stake removal flow_

- [ ] X / trashcan on manual+temp rows.
- [ ] Remove modal with required reason field.
- [ ] "Removal pending" badge.
- [ ] R-1 race handling preserved.

_Bootstrap wizard_

- [ ] `pages/bootstrap/wizard.ts` — multi-step UI; each step persists immediately; resumable.
- [ ] Step 1: stake fields (name, callings_sheet_id, stake_seat_cap).
- [ ] Step 2: at least one Building.
- [ ] Step 3: at least one Ward.
- [ ] Step 4: additional Kindoo Managers (optional).
- [ ] Complete-Setup: flips `setup_complete=true`, audits, redirects.
- [ ] Bootstrap-admin auto-add as first KindooManager preserved.
- [ ] Setup-complete gate at the bootstrap rpc level (mirrors the Apps Script `ApiShared_bootstrap` gate).
- [ ] `pages/setupInProgress.ts` — distinct from `notAuthorized`.

_Toast / error UX_

- [ ] Server-thrown errors (Forbidden, Conflict, BadRequest) surface as toasts with the server's message verbatim.
- [ ] Best-effort warnings (`warning` field on success responses) surface as warn-toasts.

**Tests**

Write paths exercise the full transaction discipline. E2E covers every user-visible workflow end-to-end including emails (stubbed in Phase 7; real send tested in Phase 9).

_Unit_

- [ ] Form-validation logic in `pages/newRequest.ts`: member name required for add types; building required for stake scope; date validity for add_temp.
- [ ] `pages/manager/requestsQueue.ts` Mark Complete dialog: Confirm enabled when ≥1 building ticked; disabled otherwise.
- [ ] Bootstrap wizard step gating: Complete-Setup enabled iff steps 1-3 are valid.

_Integration (supertest; mostly already covered in Phase 4 — re-run against any new endpoints)_

- [ ] Bootstrap endpoints' setup-complete gate: each `ApiBootstrap_*` rejects post-setup; non-admin during setup → 403.
- [ ] Manager Configuration CRUD: every editable table.
- [ ] Inline seat edit: manual/temp row updates persist + audit; auto row → 400.
- [ ] Manual access insert: composite-key collision → 409; valid → 200 + audit.
- [ ] Manual access delete: importer-source row → 400; manual row → 200 + audit.

_E2E (Playwright, per workflow)_

End-to-end happy paths:
- [ ] Bishopric submits add_manual for new member → manager queue shows the request → manager completes (default building pre-ticked) → bishopric roster shows the new seat → email-service stub invoked twice (submit + complete) with expected payloads.
- [ ] Stake submits add_temp with two buildings ticked → manager completes → seat created with both buildings → end_date persists.
- [ ] Bishopric clicks X on a manual seat → modal → submits remove with reason → "removal pending" badge appears → manager completes → seat gone from roster.
- [ ] Bishopric submits add_manual → cancels from MyRequests → status flips to cancelled → manager email stub invoked.
- [ ] Manager rejects a pending request with a reason → MyRequests shows rejected + reason → email stub invoked.

Edge paths:
- [ ] Self-approval: manager-and-bishopric submits add_manual → completes own request → both audit rows show the same email in `requester_email` and `completer_email`.
- [ ] R-1 race: pending remove → seat hand-deleted via repo → manager Complete → completion succeeds with `completion_note` set; email body surfaces the note.
- [ ] Submit remove for member with only an auto seat → server 400 with "auto seats are LCR-managed" wording.
- [ ] Submit duplicate pending remove → 400 with duplicate-pending wording.
- [ ] Manager attempts complete on already-completed request (concurrent action) → 409 with "no longer pending" wording.

Bootstrap wizard:
- [ ] Fresh stake (`setup_complete=false`) signed in as bootstrap admin → wizard renders.
- [ ] Walk all 4 steps → Complete → setup_complete=true → audit row written → redirect to manager default page.
- [ ] Resume mid-wizard: refresh during step 3 → wizard re-renders at step 3.
- [ ] Non-admin during setup → SetupInProgress page (not NotAuthorized).
- [ ] Post-setup, hand-crafted call to `ApiBootstrap_*` → 403.

Toast UX:
- [ ] Server-thrown error message renders verbatim in toast.
- [ ] `warning` on success response → warn-toast.

Coverage gate: every flow in `spec.md` §6 (request lifecycle) has an E2E.

**Acceptance criteria**

- Full happy path `add_manual`: bishopric submits → email arrives (stubbed in Phase 7; real Phase 9) → manager completes → seat appears in Firestore → bishopric email arrives.
- Full happy path `add_temp`: same plus dates persist on the seat.
- Full happy path `remove`: bishopric submits → badge appears → manager completes → seat deleted.
- Reject path: row flipped to `rejected`, reason captured.
- Cancel path: pending row flipped to `cancelled`.
- Duplicate warning shows when submitting against an existing active seat.
- Bootstrap wizard runs end-to-end against a fresh staging `stakes/csnorth` doc with `setup_complete=false`.
- Manager Configuration CRUD against every editable table.
- Inline edit of seats works.
- All audit rows present in Firestore for every write.
- Self-approval policy preserved.
- Auto-seat removal blocked at server.
- R-1 race for remove (already-removed seat → no-op completion with note).
- All read-side acceptance criteria from Phase 6 still pass.

**Out of scope**

- Importer + Expiry real implementations — Phase 8.
- Email real sends — Phase 9.
- Multi-stake — Phase 11+.
- Stake-id from URL — Phase 11.

---

## Phase 8 — Importer + Expiry on Cloud Scheduler

**Goal:** The weekly callings-sheet import and the daily temp-seat expiry run on schedule, executed by Cloud Scheduler against Cloud Run endpoints, with per-stake config respected.

**Dependencies:** Phase 4 (skeleton endpoints exist) + Phase 7 (Manager Import page exists for manual triggering and surfaces results).

**Sub-tasks**

_Importer service_

- [ ] `server/src/services/Importer.ts` — full port of `Importer.gs`. Logic preserved verbatim:
  - Per-tab parsing (header row in top 5 rows, `Position` / `Name` / Personal Email / RHS columns)
  - Ward-tab prefix stripping; Stake-tab verbatim
  - Calling matching against templates (incl. wildcard rules)
  - Source-row hashing
  - Diff against existing auto-seats (insert / delete / update-name)
  - Diff against existing Access rows (importer-sourced only; manual rows untouched)
  - Per-row audit; `import_start` / `import_end` brackets
  - Updates `last_import_at`, `last_import_summary` on the stake doc
  - Over-cap detection in a follow-up pass; persisted snapshot to `last_over_caps_json`; one `over_cap_warning` audit row; best-effort email
- [ ] Sheets API integration via `googleapis` npm package using the Cloud Run service account.
- [ ] Operator runbook entry: "Granting the importer service account view access on the LCR sheet" — file → share → add `kindoo-app@<project>.iam.gserviceaccount.com` as Viewer.

_Expiry service_

- [ ] `server/src/services/Expiry.ts` — full port. Scans `stakes/{stakeId}/seats` for `type=temp AND end_date < today (in stake's tz)`; deletes; per-row audit; `actor_email='ExpiryTrigger'`; updates `last_expiry_at`, `last_expiry_summary`.

_Endpoints_

- [ ] `POST /api/internal/import` and `POST /api/internal/expiry` — invocable only by Cloud Scheduler (verified via OIDC token signed by Scheduler's service account) or manually by the manager via the existing Phase-7 wired UI (which authenticates as the manager).
- [ ] Two distinct entry shapes: scheduler-triggered (loops over all stakes, runs only those whose configured hour matches) vs manager-triggered (single stakeId from the request).

_Cloud Scheduler jobs_

- [ ] **Single-job-loops-over-stakes pattern from day 1** even though there's only one stake. Avoids a Phase-11 refactor and keeps the free-tier quota (3 Scheduler jobs) intact regardless of stake count.
- [ ] Job 1: hourly fire of `POST /api/internal/expiry`. The endpoint reads each stake's `expiry_hour`; runs expiry for stakes whose `expiry_hour == currentHour`.
- [ ] Job 2: hourly fire of `POST /api/internal/import`. The endpoint reads each stake's `import_day`+`import_hour`; runs import for stakes where both match the current day-of-week and hour.
- [ ] Acknowledged trade-off: hourly fires for expiry/import means up to 24×7 / 168 wakeups per week even for one stake. At Cloud Scheduler's free-tier (3 jobs unlimited fires), free. At Cloud Run free tier (2M req/month), trivial. Cleaner than per-stake jobs.

_Manual triggers_

- [ ] Manager Import page's "Import Now" button → `POST /api/stakes/:stakeId/manager/importerRun`. Returns synchronously when import completes.
- [ ] Manager Configuration "Reinstall triggers" button → no-op on Firebase (the Cloud Scheduler jobs are stake-agnostic and managed in deploy infra). Show a non-error message: "Triggers are managed at the platform level on Firebase; per-stake schedules are picked up from the stake config on the next hourly fire."

_AuditLog discipline preserved_

- [ ] Per-row audits, import_start/import_end brackets, automated-actor strings, `triggeredBy` field on bracket payloads (`weekly-trigger` for scheduled, `<manager email>` for manual).

**Tests**

Importer logic is the most algorithmically complex code in the project. Heavy unit coverage on parsing + diff math; integration tests use a fixture LCR sheet (Sheets API mocked) to cover full cycles.

_Unit_

- [ ] Tab-parser:
  - Header row found in row 1 vs row 3 vs row 5; `Position` / `Name` columns located; `Personal Email` column-E validation.
  - Multi-name cell split on `,` with trim; overflow emails fall back to empty `member_name`.
  - Ward-tab prefix stripped (`CO Bishop` → `Bishop`); Stake-tab prefix preserved.
- [ ] Calling-template matching:
  - Exact match wins.
  - Wildcard match (`*` standing for any run) per data-model.md rules.
  - Sheet-order priority among multiple wildcard matches.
  - No-match returns null.
- [ ] Source-row hashing: stable across email-format wobbles (`First.Last@gmail.com` and `firstlast@gmail.com` produce the same hash).
- [ ] Diff logic:
  - Fresh seats (in source, not in DB) → insert plan.
  - Stale seats (in DB, not in source) → delete plan.
  - Unchanged seats → no-op plan.
  - Name change only → update-name plan (seat_id preserved).
- [ ] Over-cap math:
  - Ward seat_count vs `wards.seat_cap`.
  - Stake portion-cap = `stake_seat_cap - sum(ward seats)`.
  - Cap of 0 or unset → skipped.
- [ ] Hourly Scheduler dispatch: stake with `expiry_hour=3` matches at hour 3 only; same for `import_day` + `import_hour`.

_Integration (Firestore emulator + Sheets API mocked with fixture data)_

- [ ] Full importer cycle against a fixture LCR sheet → expected Seats + Access + AuditLog state.
- [ ] Idempotency: second run with no source changes → zero diffs, only `import_start`/`import_end` audit rows.
- [ ] Source change (one email swap) → exactly one delete + one insert per row affected.
- [ ] Removed calling from template → matching auto-seats deleted.
- [ ] `give_app_access=true` template row → Access row inserted.
- [ ] Manual Access row (`source='manual'`) survives import; importer skips its composite key.
- [ ] Per-row audits emitted with `actor_email='Importer'`; bracket rows carry `triggeredBy`.
- [ ] Over-cap detection: persists snapshot to `stakes/{stakeId}.last_over_caps_json`; emits one `over_cap_warning` audit row; resolved condition clears snapshot to `[]`.
- [ ] Expiry:
  - Temp seat with `end_date < today` → deleted; one audit row with `actor_email='ExpiryTrigger'`, `action='auto_expire'`, `before_json` populated, `after_json` empty.
  - Temp seat with `end_date == today` → NOT deleted.
  - Auto seat with `end_date < today` → NOT deleted (only temp affected).
  - Two consecutive runs → second run is a no-op (no rows to expire).
- [ ] Stake with `setup_complete=false` skipped by both jobs.
- [ ] Concurrent-run guard: hand-crafted simultaneous expiry + manual import for the same stake → second invocation either waits or returns a clean "already running" message; no double-write.

_E2E (Playwright)_

- [ ] Manager clicks "Import Now" → status updates → over-cap banner appears if applicable + clears on next clean run.
- [ ] Configuration page `import_day` / `import_hour` save → toast warning explains how schedule pickup works on Firebase.

Coverage gate: every diff plan branch has at least one fixture test; every over-cap math branch covered.

**Acceptance criteria**

- Daily expiry runs at the configured hour (per stake's `expiry_hour`) and deletes expired temp seats; AuditLog rows present.
- Weekly import runs at the configured day/hour; per-row audits, `import_start` / `import_end`, over-cap snapshot persisted, over-cap audit row written if applicable.
- Over-cap email sends best-effort (Phase 9 makes it real; for now stubbed → log only).
- Manual "Import Now" works from the UI.
- Idempotent: running twice with no source changes produces zero diffs.
- Service account has Sheets API view scope on the LCR sheet (operator runbook entry).
- Single-stake configuration matches Apps Script behaviour 1:1.

**Out of scope**

- Per-stake Scheduler jobs (single-job-loop is the v1 stance).
- Real email sending — Phase 9.
- Per-stake `tz` configuration (everyone is `America/Denver` for v1; Phase-12 onboarding can address per-stake tz if needed).

**Non-obvious concerns to watch**

- The Sheets API client treats date cells differently from `SpreadsheetApp` — verify date parsing matches.
- A stake with `setup_complete=false` should be skipped by both jobs (no import, no expiry — there's nothing to act on).
- The hourly fire pattern means a manual "Import Now" can race with an automatic run that fires at the same hour. Acquire a per-stake transaction lock or a sentinel doc to serialize.

---

## Phase 9 — Email via SendGrid

**Goal:** All five notification types send real emails through SendGrid.

**Dependencies:** Phase 7 (write paths invoke email) + Phase 8 (importer over-cap email).

**Sub-tasks**

- [ ] Sign up SendGrid free tier (100 emails/day — comfortably above the 1–2 requests/week × ~2 emails per request).
- [ ] Verify sender domain — DKIM/SPF on `csnorth.org` (or configure a `noreply.csnorth.org` subdomain to keep apex DNS untouched). Operator step.
- [ ] SendGrid API key in Secret Manager (`projects/<id>/secrets/sendgrid_api_key`); Cloud Run reads via env var injection.
- [ ] `server/src/services/Email.ts` — typed wrappers for the five notification types, mirroring `EmailService.gs`:
  - `notifyManagersNewRequest(stake, request)`
  - `notifyRequesterCompleted(stake, request)`
  - `notifyRequesterRejected(stake, request)`
  - `notifyManagersCancelled(stake, request)`
  - `notifyManagersOverCap(stake, pools, source)`
- [ ] Plain-text bodies (preserve Apps Script `MailApp` shape); no HTML templates for v1.
- [ ] "From" address: `<stake_name> — Kindoo Access <noreply@csnorth.org>` (display name from `stake.stake_name`).
- [ ] Best-effort discipline: SendGrid errors don't fail the underlying request; surface the failure as a `warning` field on the response (preserves the existing API contract).
- [ ] `notifications_enabled` kill switch on the stake doc — `false` skips every send and logs only.
- [ ] Wire up the over-cap email from Phase 8.
- [ ] Test via SendGrid sandbox mode + real send to one verified inbox.

**Tests**

SendGrid wrapper coverage. CI uses a mocked client; real sends are tested manually (one per type) during phase ship.

_Unit_

- [ ] Body-template renderer for each of 5 notification types against synthetic request + stake fixtures:
  - Subject contains stake name + (where applicable) member email + request type.
  - Body contains link back to `?p=mgr/queue` (or `?p=my` per spec.md §9 table).
  - Type-aware lead verb: `add_manual` → "submitted a new manual-add request"; `remove` → "requested removal of"; `add_temp` → "requested temp access for".
  - R-1 completion email: body surfaces a `Note:` line with `completion_note`.
  - Over-cap email: lists each over-cap pool with counts + cap + over-by + deep link.

_Integration (SendGrid client mocked)_

- [ ] `notifyManagersNewRequest` invoked → SendGrid `send()` called with the correct payload shape (to, from, subject, body).
- [ ] All 5 notification types similarly verified.
- [ ] `notifications_enabled=false` on the stake doc → no `send()` call; one log line emitted with the would-be recipients.
- [ ] SendGrid 5xx → wrapper catches; warning string returned to API layer; underlying API request still returns 200 with `warning` field.
- [ ] SendGrid network timeout → same behaviour.
- [ ] Per-stake "From" display: `<stake_name> — Kindoo Access <noreply@…>` (display name from `stake.stake_name`).

_Manual (during phase ship; not CI-gated)_

- [ ] One real send per notification type to a verified inbox.
- [ ] DKIM passes on Gmail (no "via" disclaimer).
- [ ] Send to a known-bad address → SendGrid logs the bounce; our code logs the warning; no app crash.

Coverage gate: every notification type has a body-template unit test + a mocked-send integration test.

**Acceptance criteria**

- Each of five notification types delivers to a real Gmail inbox in testing.
- DKIM passes (no Gmail "via" disclaimer).
- SendGrid 5xx / network failure doesn't fail the underlying write; warning surfaces in the response and toast appears client-side.
- Kill switch works (`notifications_enabled=false` → no sends, log only).
- Subject lines and body shapes match the existing five email templates exactly.

**Out of scope**

- Per-stake "From" address (one platform sender for v1; per-stake DKIM is more work than warranted).
- HTML templates (plain text for v1 to match current).
- Bounce handling, suppression lists, click tracking.
- A "test send" admin button (deferred; manual SendGrid console use for ops).

---

## Phase 10 — Data migration + cutover

**Goal:** Live data moves from the Sheet to Firestore; DNS flips `kindoo.csnorth.org` to Firebase Hosting; the Apps Script app is decommissioned. End of Phase A.

**Dependencies:** Phases 1–9.

**Sub-tasks**

_Migration script_

- [ ] `firebase/scripts/migrate-sheet-to-firestore.ts`:
  - Reads each Sheet tab via Sheets API using the migration service account (separate from the runtime service account; granted view + edit on the source Sheet for the duration).
  - Writes each row to the corresponding Firestore collection under `stakes/csnorth/`.
  - Idempotent: re-runnable; same Firestore state regardless of run count. Achieved by using deterministic doc IDs (canonical email, composite keys) and `tx.set(docRef)` (overwrite) rather than `tx.create`.
  - Preserves: timestamps (parsed from cell `Date` values), UUIDs (existing seat_id / request_id / audit_id values), audit log history, source_row_hash values, source field on Access.
  - Maps the Config tab's key/value rows into the parent stake doc's fields.
  - Verifies: post-write per-collection counts match Sheet row counts; logs any discrepancies with row indices.
- [ ] Dry-run mode (`--dry-run`) that prints the planned writes without executing them.
- [ ] Spot-check helper: `firebase/scripts/diff-sheet-vs-firestore.ts` — picks N random rows from each collection, compares the Firestore record with the Sheet row, flags differences.

_Pre-cutover (rehearsal against staging)_

- [ ] Snapshot the production Sheet (File → Make a copy) to a "staging-source" sheet.
- [ ] Run migration script against `kindoo-staging` Firebase project + staging-source sheet.
- [ ] Walk the staging app end-to-end as each role: bishopric (CO ward), stake, manager. Compare every page against the Apps Script production app side-by-side.
- [ ] Compare audit log between Apps Script and Firestore — sample 20 rows, verify identical `before` / `after` JSON.
- [ ] Performance baseline: Dashboard p50, AllSeats p50, Audit Log first-page p50.
- [ ] Run a full importer cycle against the staging-source LCR sheet; verify per-row audits + over-cap detection match production.
- [ ] Run an expiry cycle against a seeded soon-to-expire temp seat in staging.
- [ ] Send one test email from each of the five notification types.

_Cutover (production maintenance window)_

- [ ] Banner on Apps Script app 24h pre-cutover: "Going read-only at HH:MM Saturday for migration; back at HH:MM."
- [ ] Communicate the window to Kindoo Managers + Stake + Bishopric leads.
- [ ] At go-time: revoke write access on the Sheet (Sheet → Share → set to "Viewer" for everyone except your migration account) AND set the Apps Script web app deployment to disabled (Manage Deployments → archive the active deployment).
- [ ] Run migration script against `kindoo-prod` Firebase project + the live Sheet.
- [ ] Verify counts match.
- [ ] Smoke test as each role on `kindoo-prod.web.app` (the default Hosting URL — DNS hasn't flipped yet).
- [ ] DNS flip: `kindoo.csnorth.org` CNAME flips from the Cloudflare Worker target → Firebase Hosting verification target. Cloudflare Worker keeps the rule but it's now bypassed.
- [ ] Wait for DNS propagation (Cloudflare TTL — minutes).
- [ ] Verify Firebase Hosting custom-domain SSL provisioning succeeded.
- [ ] Smoke test on `kindoo.csnorth.org`.
- [ ] Re-enable write access on the Sheet (Viewers can become Editors again — the Sheet is no longer the source of truth but stays human-readable for archive purposes).

_Post-cutover monitoring_

- [ ] 24–48 hours of active monitoring: Cloud Run logs, Firestore rules-denied count, error rates.
- [ ] Apps Script app stays deployed but disabled (web app set to "only me" or archived deployment) for one week as rollback option.
- [ ] After one week with no critical issues: delete Apps Script triggers (`ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t))`), set Apps Script web app to fully disabled, revoke the migration service account's Sheet edit access (downgrade to no access).

_Repo cleanup_

- [ ] Delete `src/` (Apps Script Main project source).
- [ ] Delete `identity-project/`.
- [ ] Delete `.clasp.json`, `.clasp.json.example`, `clasp` package.json scripts.
- [ ] Move `firebase/` contents to repo root (so `client/`, `server/`, `shared/` are top-level — cleaner long-term shape).
- [ ] Update `CLAUDE.md`: remove Apps Script-specific guidance ("Flat namespace", "auth is GSI + server-side JWT", "two identities"); add Firebase guidance.

_Doc updates_

- [ ] `docs/spec.md` — auth section rewritten (Firebase Auth, Cloud Run, Firestore); stack section rewritten; concurrency section rewritten (transactions instead of script lock).
- [ ] `docs/architecture.md` — D2, D6, D7, D10 superseded; new Firebase decisions added with new D-numbers (continue the sequence).
- [ ] `docs/build-plan.md` Chunk 11 marked `[SUPERSEDED — Firebase Hosting handles custom domain natively, see firebase-migration.md Phase 10]`.
- [ ] `docs/changelog/chunk-11-cloudflare.md` — never created; instead a `docs/changelog/firebase-cutover.md` entry summarizes Phases 1–10.
- [ ] Identity project README archived under `docs/archive/identity-project-readme.md` for historical reference (the secret-rotation runbook is no longer relevant but the auth-pivot narrative is good context).

**Tests**

Migration script correctness is the highest-stakes test surface in the entire migration. A bug here corrupts the cutover. Heavy unit + integration coverage; smoke + cutover steps below are manual but enumerated for the runbook.

_Unit_

- [ ] Per-tab transformation function (Sheet row → Firestore doc shape):
  - Date cells parsed correctly (timestamps land as Firestore `Timestamp`s).
  - Empty cells map to empty strings, not `undefined`.
  - Composite keys for Access constructed correctly per `accessRepo.makeId`.
  - Audit-log rows preserve `before`/`after` as nested objects (parsed from any existing JSON-string form on legacy rows).
  - `source` field on Access defaults to `'importer'` for legacy rows missing the column.
- [ ] Building name → slug transform stable for known inputs; cross-references rewritten consistently across `wards.building_name`, `seats.building_names`, etc.

_Integration (Firestore emulator + Sheets fixture)_

- [ ] Migrate fixture Sheet → Firestore matches expected state byte-for-byte (excluding auto-generated timestamps where applicable).
- [ ] Idempotency: second run produces identical Firestore state; no duplicates; no orphaned docs.
- [ ] Re-run on partial failure: kill mid-run, restart; complete state matches one-shot run.
- [ ] Source-row hashes preserved across migration (importer's first post-cutover run produces zero diffs against the migrated state).
- [ ] Counts per collection match Sheet row counts.
- [ ] Diff helper (`diff-sheet-vs-firestore.ts`):
  - Synthetic mismatch (e.g. flipped `member_name`) → flagged with row index.
  - Identical state → no flags.
  - Sample size of N rows per collection respected.

_Smoke (manual, during cutover rehearsal in staging)_

- [ ] Run migration against `kindoo-staging` (snapshot of production Sheet) → walk full app as each role.
- [ ] Compare audit log: 20 random rows match between Apps Script and Firebase end-to-end (`before`/`after` JSON preserved).
- [ ] Send one of each email type from staging.
- [ ] Run a full importer cycle against the staging-source LCR sheet → diff vs production Apps Script's last import: zero unexpected changes.

_Cutover (manual, during the maintenance window)_

- [ ] Pre-cutover: Sheet read-only confirmed; Apps Script web app archived.
- [ ] Migration script run against `kindoo-prod`; counts verified.
- [ ] Smoke as each role on `kindoo-prod.web.app`.
- [ ] DNS flip; SSL provisioning verified; smoke on `kindoo.csnorth.org`.
- [ ] 24h monitoring: error rate < threshold (set during rehearsal); no rules-denied spikes.

Coverage gate: integration tests pass against the real production-snapshot fixture before the cutover window opens. No manual cutover step is taken before the rehearsal in staging is fully green.

**Acceptance criteria**

- Migration script reproduces Firestore state from Sheet input deterministically (rerun-safe).
- Spot-check: 20 random rows match between Sheet and Firestore in each collection.
- All roles can sign in and walk a smoke test against production Firestore.
- DNS flip succeeds; users land on Firebase Hosting via `kindoo.csnorth.org`.
- One week of post-cutover monitoring with no rollback.
- Apps Script and Identity projects decommissioned.
- `src/` and `identity-project/` removed from repo; git history preserves them.
- All docs reflect the Firebase reality.

**Out of scope**

- Multi-stake — Phase 11+.
- Performance tuning beyond what was needed for Phases 6/7 to ship.
- Cost optimization beyond the $1 budget alert.

**Rollback plan (documented before go-time)**

- Within 24h of cutover: DNS flip back to Cloudflare Worker → Apps Script. Re-enable Apps Script web app deployment. Re-enable Apps Script triggers. The Sheet is still the source of truth (we never moved it), so no data restore is needed.
- After 24h but within 7 days: same DNS flip, but any Firestore-side writes that happened post-cutover need manual reconciliation back into the Sheet. Acceptable but uncomfortable.
- After 7 days: Apps Script triggers deleted; full rollback would require redeploying Apps Script + restoring triggers. Don't roll back at this point — fix forward.

---

## Phase 11 — Stake routing

**Goal:** Every API endpoint takes `stakeId` from the URL path. The principal carries memberships across multiple stakes. The hardcoded `csnorth` constant disappears from the codebase. Single-stake users still auto-route to their one stake — the URL just shifts to include `/csnorth/`.

**Dependencies:** Phase 10 (production must be on Firebase before this refactor).

**Sub-tasks**

_URL convention_

- [ ] `kindoo.csnorth.org/{stakeId}/?p=<page>&...`. The stakeId becomes the first path segment.
- [ ] Vite / router updated: routing reads stakeId from `location.pathname.split('/')[1]`.
- [ ] All `<a data-page>` links rewrite to include the current stakeId.
- [ ] Direct deep-links from emails / bookmarks: the existing `kindoo.csnorth.org?p=...` URLs (no stakeId) redirect to `kindoo.csnorth.org/csnorth?p=...` for compat. Add a one-liner in the bootstrap path: if URL has no stakeId segment AND the user has exactly one stake, redirect to `/{theirStake}/{rest of url}`.

_Server: principal shape change_

- [ ] `Principal` becomes:
  ```ts
  interface Principal {
    email: string;
    isPlatformSuperadmin: boolean;
    memberships: Record<StakeId, { roles: Role[] }>;
  }
  ```
- [ ] `Auth_principalFrom(token, stakeId)` resolves the user's memberships across all stakes (collection-group queries on `kindooManagers` and `access` filtered by canonical email), AND validates the user has at least one role in `stakeId` (else `Forbidden`). Returns the full multi-stake principal so the UI can render a stake switcher.
- [ ] Collection-group indexes: `kindooManagers` and `access` need collection-group queries enabled. Configure in `firestore.indexes.json`.

_Server: route refactor_

- [ ] Express routes already have `:stakeId` path param from Phase 4. The change here is removing the client-side hardcoded `csnorth` constant — every rpc call now passes the current URL's stakeId.
- [ ] `Auth_requireRole`, `Auth_requireWardScope` operate against `principal.memberships[stakeId].roles` (already scoped, since the principal validation gate happened in `Auth_principalFrom`).

_Client: rpc + page shape_

- [ ] `rpc/client.ts` reads stakeId from current URL and prefixes API path automatically.
- [ ] `pages/*` `init(model, queryParams)` signatures unchanged — page model already typed to be stake-agnostic.

_Importer / Expiry_

- [ ] Already use the loop-over-stakes pattern from Phase 8. Just confirm they work for >1 stake by adding a `testStake` to staging and seeding test data.

_Security rules_

- [ ] Already correct from Phase 3 (`hasMembership(stakeId)` covers it). Verify `kindooManagers` and `access` collection-group rules allow authenticated users to read their own membership docs across stakes (needed for the principal resolution). Or — alternative — make principal resolution a server-only operation via the Admin SDK and don't expose collection-group queries to clients at all. (Recommend the latter; clients never need to query Firestore directly.)

_Ops_

- [ ] Onboard a `testStake` in staging via direct Firestore writes (since the platform admin surface lands in Phase 12). Walk through the full role lifecycle to verify isolation.

**Tests**

Multi-stake routing: principal shape change, URL plumbing, cross-stake denial.

_Unit_

- [ ] Multi-stake principal builder: collection-group query results → `memberships` map keyed by stakeId.
- [ ] URL stakeId extractor: `/csnorth/?p=mgr/seats` → `'csnorth'`; `/?p=...` → null (triggers redirect logic).
- [ ] Default-route logic: 0 stakes / 1 stake / >1 stakes; no-superadmin variations (superadmin variants land in Phase 12).

_Integration_

- [ ] `Auth_principalFrom(token, stakeId)`:
  - User with membership in stakeId → returns principal with that stakeId in `memberships`.
  - User with membership in stake A only, called for stake B → throws `Forbidden`.
  - User with no memberships → empty `memberships` map (handled at routing layer; principal still resolved).
- [ ] Collection-group queries against emulator: user with roles in two stakes → both surfaces in `memberships`.
- [ ] Every endpoint after refactor: hits `/api/stakes/csnorth/...` for csnorth member → works. Hits `/api/stakes/otherStake/...` for non-member → 403.
- [ ] Bare URL compat: `/?p=mgr/seats` for single-stake user → server-side redirect to `/csnorth/?p=mgr/seats`.

_E2E (Playwright)_

- [ ] Single-stake user (csnorth only) signs in → URL gains `/csnorth/` segment automatically; nothing else feels different.
- [ ] Multi-stake user (signed in via emulator-seeded membership in csnorth + testStake) signs in → bootstrap returns memberships for both; current URL determines active stake.
- [ ] Hand-crafted URL change to `/otherStake/?p=mgr/seats` for non-member → Forbidden toast; redirect to safe default.
- [ ] Full Phase-7 E2E suite still passes for csnorth (regression check).

Coverage gate: zero hardcoded `'csnorth'` strings in code (verified by `grep` step in CI); every API path tested with a wrong-stake principal.

**Acceptance criteria**

- The constant `'csnorth'` does not appear in the codebase except in seed scripts, tests, and documentation examples.
- A user with memberships in stake A and stake B can access both via different URL paths.
- A user attempting to access `/{otherStake}/` without membership gets Forbidden (server enforced) and a clean error toast (client surfaced).
- All Phase 7 acceptance criteria still pass.
- Importer / Expiry continue to work; per-stake schedules respected via the hourly-fire-loop pattern.
- Existing single-stake users see no behaviour change other than the URL gaining a `/csnorth/` segment.
- The bare `kindoo.csnorth.org/?p=mgr/seats` URL redirects to `kindoo.csnorth.org/csnorth/?p=mgr/seats` for backward compat.

**Out of scope**

- Stake selector UI — Phase 12.
- Platform superadmin — Phase 12.
- Onboarding a second real stake via the in-app flow — Phase 12.

---

## Phase 12 — Platform superadmin + stake picker

**Goal:** A second stake can be onboarded end-to-end via the in-app platform admin surface. The platform superadmin has a tiny provisioning role (no read access to any stake's operational data, per the locked-in design).

**Dependencies:** Phase 11.

**Sub-tasks**

_Superadmin allow list_

- [ ] `platformSuperadmins/{canonicalEmail}` collection — minimal `{email, addedAt, addedBy}` doc.
- [ ] Edited via direct Firestore console use (no in-app management surface — chicken-and-egg, and the list is small enough).
- [ ] Server: `isPlatformSuperadmin(email)` helper; populates `principal.isPlatformSuperadmin`.
- [ ] Tad's email seeded into `kindoo-prod` `platformSuperadmins/`.

_Platform admin page_

- [ ] `pages/platform/index.ts` — list of stakes (id, display name, `setup_complete` flag, created_at, bootstrap admin email).
- [ ] `pages/platform/createStake.ts` — form (stakeId slug, display name, bootstrap admin email).
- [ ] On submit: writes `stakes/{stakeId}` with `setup_complete=false, bootstrap_admin_email=<...>, created_at=now, created_by=<superadmin email>`. Subcollections start empty.
- [ ] One audit row written to a new top-level `platformAuditLog/{ts}` collection (since stake-scoped auditLog doesn't yet exist for the new stake at creation time).
- [ ] `POST /api/platform/createStake` — only superadmins can call.

_Stake picker_

- [ ] `pages/stakePicker.ts` — rendered when bootstrap principal has memberships in >1 stake. Lists stakes with display names (read from each `stakes/{id}` doc); clicking navigates to `/{stakeId}/`.

_Stake switcher in topbar_

- [ ] Dropdown rendered in `layout/shell.ts` topbar when memberships > 1. Clicking switches the stakeId in the URL.

_Default route logic (consolidated)_

- [ ] On bootstrap:
  - 0 stakes + not superadmin → `notAuthorized`.
  - 0 stakes + superadmin → redirect to `/platform`.
  - 1 stake → redirect to `/{thatStake}/{role-default-page}`.
  - >1 stakes → render `stakePicker`.
  - Superadmin who's also a stake member: same as above, plus a "Platform admin" link in the topbar.

_Bootstrap wizard parameterization_

- [ ] Already parameterized by stakeId in Phase 7 (the wizard always operated against `stakes/csnorth`). Just verify it works for a fresh `stakes/{newId}` doc seeded with `setup_complete=false` and `bootstrap_admin_email=<...>`.

_Security rules_

- [ ] `match /stakes/{stakeId}` doc — write allowed if `isSuperadmin()`.
- [ ] `match /stakes/{stakeId}/{document=**}` — superadmin gets nothing (read or write). Provisioning ≠ inspection (per F10 + Phase 12 design).
- [ ] `match /platformSuperadmins/{email}` — read allowed if `isSuperadmin()`; write forbidden (console-only).
- [ ] `match /platformAuditLog/{id}` — read allowed if `isSuperadmin()`; write forbidden (server-only).

_Operator runbook_

- [ ] New doc: `docs/runbooks/lost-bootstrap-admin.md` — how superadmin re-designates a stake's bootstrap admin if the original is unreachable.
- [ ] New doc: `docs/runbooks/onboard-stake.md` — end-to-end checklist: superadmin creates stake → bootstrap admin signed up → wizard run → callings sheet shared with importer service account → first import → first email tested.

_Onboarding test_

- [ ] Create `testStake` (or `csnsouth` or whatever the second target name is). Designate yourself bootstrap admin. Run the full wizard. Verify isolation from `csnorth` via emulator rules tests AND a manual cross-stake access test.

**Tests**

Platform superadmin surface + multi-stake UX. Ends with a full second-stake onboarding as a manual integration test.

_Unit_

- [ ] `isPlatformSuperadmin(email)`: matches against `platformSuperadmins/{canonicalEmail}` lookup; canonical-email comparison.
- [ ] Default-route logic from Phase 11 expanded with superadmin cases:
  - Superadmin + 0 stakes → `/platform`.
  - Superadmin + 1 stake → role default for that stake + Platform link in topbar.
  - Superadmin + >1 stakes → picker + Platform link.

_Integration_

- [ ] `POST /api/platform/createStake`:
  - Superadmin → 200; stake doc written with `setup_complete=false, bootstrap_admin_email=<...>`; one row in `platformAuditLog`.
  - Non-superadmin → 403.
  - Duplicate stakeId → 409.
  - Invalid stakeId (whitespace, special chars, reserved words) → 400.
- [ ] `GET /api/platform/stakes`:
  - Superadmin → list of all stakes with `{id, name, setup_complete, created_at, bootstrap_admin_email}`.
  - Non-superadmin → 403.
- [ ] Bootstrap wizard against a freshly-created `stakes/testStake` doc — full Phase-7 wizard test suite re-run with `stakeId='testStake'`; all assertions pass identically.

_Rules_

- [ ] Superadmin can `update`/`set` `stakes/{stakeId}` doc (the parent doc only).
- [ ] Superadmin **cannot** read `stakes/{stakeId}/seats/...` (or any subcollection) without an explicit membership in that stake.
- [ ] Non-superadmin cannot read `platformSuperadmins/*` or `platformAuditLog/*`.
- [ ] Non-superadmin cannot write `stakes/{stakeId}` parent doc.

_E2E (Playwright)_

- [ ] Superadmin (no stake memberships) signs in → lands on `/platform`.
- [ ] Superadmin creates a new stake from the form → stake appears in the list → bootstrap admin email captured.
- [ ] Designated bootstrap admin signs in → SetupInProgress for non-admins; wizard for the admin → completes wizard end-to-end.
- [ ] Multi-stake user (csnorth + testStake) signs in → picker page → selects one stake → lands on role default for that stake.
- [ ] Stake switcher in topbar: switch from stake A to stake B → URL updates to `/{stakeB}/...` → page re-renders with stake B's data.
- [ ] Cross-stake isolation: signed in as manager of stake A, hand-craft URL to `/{stakeB}/?p=mgr/seats` (no membership in B) → Forbidden toast.
- [ ] Onboarding integration: full second-stake setup from cold start in <30 minutes (manual stopwatch; documented in onboarding runbook).

Coverage gate: full Phase-7 test suite passes against a freshly-created `testStake` with no shared state with `csnorth`. The stopwatch onboarding test is run at least once before the phase ships.

**Acceptance criteria**

- Superadmin can create a new stake from `/platform` without leaving the app.
- A new stake's bootstrap admin can sign in and run the wizard end-to-end.
- Two stakes' data is fully isolated (verified by emulator rules tests + manual probes).
- Stake picker appears for users with >1 stake; stake switcher dropdown in topbar works.
- Superadmin without explicit stake membership cannot read stake data (verified by manual probe + rules test).
- Operator runbooks exist for the two ops scenarios above.
- Onboarding a second stake via the in-app flow takes <30 minutes end-to-end (excluding callings-sheet sharing wait time).

**Out of scope**

- Self-serve stake creation (superadmin-curated only).
- Per-stake billing / quotas (single SendGrid sender, single GCP project for v1).
- Multi-stake reporting / cross-stake dashboards.
- Per-stake "From" address.
- Per-stake custom domain.

---

## Open questions to resolve before kicking off

These came up while writing. Better to nail them down before Phase 1 starts than discover mid-implementation.

1. **Buildings doc-ID slugging** (Phase 3): slugify on write (`Cordera Building` → `cordera-building`) with a `building_name` display field, vs URL-encoding the natural key as the doc ID? Recommend slugify; the cross-references (`wards.building_name`, `seats.building_names`) need a one-time migration to the slug form during Phase 10.

2. **Migration of audit-log history**: keep all existing audit rows (preserves continuity for "what changed in the last 6 months") vs start fresh on Firebase (cleaner, smaller initial Firestore size). Recommend keep — the audit log is a real artifact, not an operational table.

3. **Email "From" address final form**: `noreply@csnorth.org` (apex domain, requires SPF/DKIM at apex), or `noreply@kindoo.csnorth.org` (subdomain, isolates email DNS from your existing csnorth.org mail setup), or something else? Recommend `noreply@kindoo.csnorth.org` — least invasive on your existing csnorth.org DNS.

4. **`platformAuditLog` location**: top-level collection (proposed in Phase 12) vs reuse the per-stake auditLog with a `system` entity_type? Top-level is cleaner because stake-creation events don't belong to any stake. Confirm.

5. **Cloud Run region**: `us-central1` is the cheapest + lowest-latency for your geographic spread (Denver-area users). Confirm or override.

6. **Migration timing**: when do you want to target cutover (end of Phase 10)? This drives how compressed the phase pacing should be. No constraint on my end; this is a calendar question.

7. **Test data for staging**: do you want staging Firestore seeded with a redacted production snapshot (real-shape, real-volume), or a tiny hand-crafted fixture (one ward, three seats, etc.)? The migration script can do either; recommend redacted snapshot for higher-fidelity rehearsal.

Resolve these (any subset; I'll defer the rest to mid-phase) before Phase 1 starts.
