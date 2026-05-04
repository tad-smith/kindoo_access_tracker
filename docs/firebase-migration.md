# Firebase migration plan

> **Status: ACTIVE (2026-04-27).** Migration committed; goal is to ship as quickly as possible. Target arc: 5–7 weeks full-time, 2–3 months part-time with Claude Code agents. Currently in **pre-Phase-1 gating** — stakeholder sign-offs on behaviour changes, tooling decisions, agent definitions, operator setup with DNS lead time. **Companion document: [`docs/firebase-schema.md`](firebase-schema.md)** — data model, rules, and indexes. Apps Script implementation continues to run in production until Phase 11 cutover.
>
> **History:** an earlier version of this plan ("Cloud Run + Express") was superseded on 2026-04-27 after architectural exploration concluded that direct-to-Firestore with custom claims was a better fit at this scale. Git history preserves the prior plan if needed.

13 phases across two arcs. Phases 1–11 port the Apps Script app to Firebase as a single-stake deployment. Phase 12 (single-stake cutover) ends Phase A. Phase 13 lifts the data model to multi-stake and exposes a platform-superadmin surface as Phase B. The Apps Script app remains in production through the end of Phase 11; cutover is one maintenance window. Phase B lands later if/when a second stake is in scope.

The companion `docs/firebase-schema.md` is the authoritative description of the data model, rules, and indexes — this plan references it rather than duplicating. `docs/spec.md` describes runtime behaviour and is updated in lockstep with each phase that changes it. `docs/architecture.md` gets substantially rewritten across Phases 2–4; sections that survive verbatim (request lifecycle state machine, audit-log shape, role union model, email policy) are explicitly left untouched.

## Architecture summary

- **Identity:** Firebase Authentication (Google sign-in only).
- **Authorization:** Custom claims on the auth token, set by Cloud Function triggers on role-data writes.
- **Data path (reads + writes):** Client uses Firestore JS SDK directly; rules enforce access. No Cloud Run, no Express, no per-request server-side code.
- **Server compute:** Cloud Functions for: weekly importer (Sheets API), daily temp-seat expiry, email send (SendGrid), audit-log fan-in, custom-claims sync, nightly reconciliation.
- **Hosting:** Firebase Hosting serves the static SPA build with auto-provisioned HTTPS.
- **Real-time:** `onSnapshot` listeners on shared-attention pages (Queue, Roster, MyRequests, Dashboard); request-response everywhere else.

The pure-client + minimal-Cloud-Functions approach trades a centralised service layer for: zero cold starts on the request path, simpler operational footprint, lower cost (free tier covers it), and a structurally simpler audit-log story that doesn't require duplicating logic in rules.

## Locked-in decisions

| # | Decision | Rationale |
| --- | --- | --- |
| F1 | **Direct-to-Firestore client; no Cloud Run; no Express.** Cloud Functions only for triggers + scheduled jobs + email send. | Eliminates per-request cold starts; halves the moving-parts count; Firestore Security Rules + custom claims carry the auth/authz that an Express middleware stack would otherwise carry. At our request volume (1–2/week per spec.md §1), the serverless trigger costs are zero. |
| F2 | **React 19 + TypeScript strict + Vite + TanStack Router + TanStack Query + reactfire + Zustand + react-hook-form + zod + shadcn-ui (Radix + Tailwind) + vite-plugin-pwa.** Monorepo via pnpm workspaces. Tests via Vitest + React Testing Library + Playwright + `@firebase/rules-unit-testing`. Locked in 2026-04-27. | Industry-standard stack for 10x-scale apps; user has explicitly chosen this as the learning vehicle. The cost (bundle ~150 KB gz vs ~30 KB vanilla) is acceptable for the future-proofing and pattern-transferability. |
| F3 | **Custom claims for role resolution.** Triggers on `access`/`kindooManagers`/`platformSuperadmins` writes update claims; `revokeRefreshTokens` forces refresh. Up to ~1 hour staleness on idle sessions; <2s on active. | Makes role checks free in rules (no `get()` calls); single doc lookup at sign-in is enough to know everything; staleness window is acceptable for this app. Replaces F7's per-request resolution from the prior plan. |
| F4 | **`userIndex/{canonicalEmail}` top-level collection** maps canonical email → Firebase Auth uid. Written by `auth.user().onCreate`; read by claim-sync triggers. | Bridges Firestore's canonical-email-as-doc-id keying with Firebase Auth's uid keying. Lookup-by-canonical-email is otherwise impossible (Firebase Auth's `getUserByEmail` matches typed form, not canonical). |
| F5 | **Canonical-email-as-doc-id for `seats` and `access`.** One doc per (stake, member). Drops UUIDs and `source_row_hash`. | Stable, human-readable entity_id improves audit log UX; removes a class of denormalization. See `docs/firebase-schema.md` §4.5–4.6. |
| F6 | **Seat collisions handled by `duplicate_grants[]` flag**, importer applies stake>ward priority. Duplicates are informational, not counted in utilization. | Per user's design preference: rare cross-scope collisions get flagged for manager reconciliation but don't pollute the accounting model. |
| F7 | **Access split-ownership at the field level** — `importer_callings` (Admin-SDK only) + `manual_grants` (manager-writable). Composite-key uniqueness becomes structurally impossible rather than rule-enforced. | Replaces today's `source` column with field-level segregation. Rules enforce the split with one-line `diff().affectedKeys().hasOnly(...)` check. |
| F8 | **Audit log via Cloud Function triggers** (Option A) writing to a flat `auditLog` collection per stake. Eventually consistent (~<1s). Nightly reconciliation job catches any gaps. | Conventional pattern; simpler client code; Admin-SDK paths (importer/expiry) fan in audit identically to client paths. Option B (embedded history with `getAfter()`) considered and parked — its atomicity advantage covered <50% of audit volume due to Admin-SDK rule bypass. |
| F9 | **Two Firebase projects: `kindoo-staging` and `kindoo-prod`.** Same code, different data. | Standard practice; lets the migration script rehearse against a snapshot in staging without risking production. |
| F10 | **HTTPS via Firebase Hosting auto-provisioned certs.** Required for PWA service workers. | Free with Hosting; eliminates the prior plan's F12 trade-off (HTTP-only). |
| F11 | **PWA from day one via `vite-plugin-pwa`.** Service worker, manifest, install prompt all configured early. Push via FCM is deferred to Phase 10.5. | User specifically requested PWA-readiness as a long-term capability. Building this in early is cheaper than retrofitting. |
| F12 | **Big-bang cutover** during a maintenance window. Apps Script stays as rollback for ~one week, then retires. | 1–2 requests/week; no dual-writes worth the complexity. Same as prior plan. |
| F13 | **Tests are non-negotiable; CI gates every PR.** Vitest (unit + integration), `@firebase/rules-unit-testing` (rules), Playwright (E2E), React Testing Library (component). No phase merges without green CI. | Past pain on the Apps Script side: integration bugs surfaced only at user-facing-flow time. Rigor up front makes each phase independently shippable. |
| F14 | **Repo layout side-by-side during migration.** New code in monorepo at repo root (`apps/web/`, `functions/`, `firestore/`, `packages/shared/`, `infra/`, `e2e/`); existing `src/` and `identity-project/` untouched until Phase 11's cutover. | Keeps the live app deployable for rollback throughout. Phase 11 retires `src/` and `identity-project/`; their git history is preserved. |
| F15 | **`stakeId` parameterized from day one.** Even though there's only one stake (`csnorth`) for v1, every collection path and rule takes `{stakeId}` as a path segment. Phase B is then a routing change, not a data refactor. | Prior plan's lesson learned. The hardcoded `csnorth` constant is consolidated in one place (`apps/web/src/lib/constants.ts`) so Phase B is grep-and-fix. |
| F16 | **Email via Resend** (100/day free tier; 3000/month). Domain verification via DKIM CNAME + DMARC TXT records (~10 min setup, no significant DNS lead time). Locked in 2026-04-27. | Resend has the cleanest developer experience among free transactional-email vendors at this scale. SendGrid (originally proposed) and Brevo are equivalent fallbacks if needed; vendor swap is a Cloud Function wrapper change of ~30 lines. |
| F17 | **Custom domain `stakebuildingaccess.org`** (chosen 2026-04-27), split across two surfaces: Firebase Hosting serves on the apex `stakebuildingaccess.org`; Resend "From" branding uses the `mail.stakebuildingaccess.org` subdomain (verified 2026-05-02 per T-04 — DKIM CNAME + DMARC TXT records on the `mail.` subdomain). Both share the same brand identity. The apex-pointing procedure (and the staging-subdomain rehearsal that precedes it) lives in `infra/runbooks/custom-domain.md`. The legacy `kindoo.csnorth.org` GitHub-Pages-iframe-wrapper URL is decommissioned at Phase 11 cutover (the redirect-vs-takedown decision itself is deferred to the cutover runbook, separate from the apex-pointing procedure). | User explicitly chose a fresh domain over staying on `kindoo.csnorth.org`. The apex/subdomain split keeps Resend's DNS records scoped to `mail.` so the apex SPF/DMARC posture is independent of the transactional-email vendor — vendor swap (per F16's fallback note) is a subdomain-only DNS change. |

## Team composition

Work is done by Tad in collaboration with **four Claude Code subagents**:

| Teammate | Owns | Coordinates with |
|---|---|---|
| `web-engineer` | `apps/web/`, `e2e/` | backend-engineer for shared schemas, rules changes, new indexes |
| `backend-engineer` | `functions/`, `firestore/` (rules + indexes) — merged from prior plan's separate functions and rules roles | web-engineer for query shapes; infra for deploys |
| `infra-engineer` | `infra/`, `firebase.json`, `.firebaserc`, deploy scripts, secret management, runbooks | Everyone (deploys touch every workspace) |
| `docs-keeper` | `docs/`, root `CLAUDE.md`, per-workspace `CLAUDE.md` *structure* | All — converts decisions into doc updates |

Three engineering agents (`web`, `backend`, `infra`) plus `docs-keeper` was deliberately chosen over the prior plan's four-engineer split. Rules and Cloud Functions are sufficiently related (both are server-side Firebase concerns sharing the same Admin SDK + emulator mental model) that one agent owns both effectively. Splitting them only earns its keep at larger team sizes.

Shared touchpoints:
- **`packages/shared/`** is touched by both `web-engineer` and `backend-engineer`. Coordination via `TASKS.md`.
- **`firestore/firestore.indexes.json`** — when `web-engineer` adds a query needing a composite index, they PR the index alongside the query and tag `backend-engineer` for review.
- **`firestore/firestore.rules`** — only `backend-engineer` modifies. Other agents propose rule changes via `TASKS.md` with a test case.

`TASKS.md` and `BUGS.md` at repo root, append-only by any agent; `docs-keeper` owns structure and archives resolved entries weekly.

## Testing strategy

Tighter than the Apps Script implementation's `Utils_test_*` pattern. Every phase ships with tests covering its acceptance criteria; no phase ships without green CI.

### Test stack

| Layer | Tooling | Lands in | What it covers |
| --- | --- | --- | --- |
| Unit | **vitest** | Phase 1 onward | Pure functions: email canon, hashing, validation, render helpers |
| Component | **vitest + jsdom + React Testing Library** | Phase 4 onward | React components in isolation; behaviour, not implementation |
| Hooks | **vitest + Firestore emulator + reactfire** | Phase 5 onward | Custom hooks (`useRequestsQueue`, mutations) against a real emulator |
| Security rules | **`@firebase/rules-unit-testing`** | Phase 3 onward | Per-rule scenarios with synthetic auth tokens; cross-stake denial; client-write denial |
| Cloud Functions | **vitest + emulators** | Phase 2 onward | Triggers and scheduled functions against emulator state |
| End-to-end | **Playwright** | Phase 4 onward | Full sign-in + multi-page workflows against the local emulator stack |
| Migration script | **vitest + emulator + Sheets fixture** | Phase 11 | Per-collection transformation, idempotency, diff-helper |

### Conventions

- **Tests colocated with code** in `tests/` folders within each feature (`apps/web/src/features/*/tests/`) or workspace.
- **Test names describe behaviour, not implementation.** `it('shows pending requests in FIFO order')`, not `it('renders list')`.
- **Each test sets up its own state** via factories (`makeStake()`, `makeKindooManager()`, `makePendingRequest()`).
- **Emulator state cleared between tests** via `clearFirestoreData` in `beforeEach`.
- **No mocks for Firestore.** Emulator is the test database. Mocks lie about transaction semantics, batched-write atomicity, and rule evaluation; the emulator doesn't.
- **Auth tokens via Auth emulator's `signInWithCustomToken`** for tests; helpers under `apps/web/test/lib/auth.ts`.
- **E2E uses Playwright headless** in CI; headed for local debugging via `pnpm test:e2e:headed`.
- **No fixed coverage threshold.** Per-phase **Tests** subsection is the actual gate.

### CI

GitHub Actions workflow at `infra/ci/workflows/test.yml` runs on every push and PR:

1. `pnpm install` — workspace install.
2. `pnpm lint` — eslint + prettier --check across all workspaces.
3. `pnpm typecheck` — `tsc -b` (project references) across the monorepo.
4. `pnpm test:unit` — vitest, no emulators.
5. `pnpm test:integration` — vitest + emulators.
6. `pnpm test:rules` — rules-unit-testing.
7. `pnpm test:e2e` — Playwright against emulators + locally-built app.
8. `pnpm build` — production builds verify across workspaces.

A failing step blocks the PR. No `--no-verify`; if a test is wrong, fix the test.

## Repo layout

Side-by-side during migration. Existing `src/` and `identity-project/` untouched until Phase 11.

```
kindoo/
├── apps/web/                      # SPA — web-engineer
│   ├── src/
│   │   ├── routes/                # TanStack Router file-based routes
│   │   ├── features/              # One folder per domain (seats, requests, access, manager, etc.)
│   │   ├── components/            # Cross-feature shared UI
│   │   ├── lib/                   # firebase init, principal hook, toast
│   │   └── styles/
│   ├── public/
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json
│   └── CLAUDE.md
│
├── functions/                     # Cloud Functions — backend-engineer
│   ├── src/
│   │   ├── triggers/
│   │   ├── scheduled/
│   │   ├── callable/
│   │   ├── services/
│   │   └── lib/
│   ├── tests/
│   └── CLAUDE.md
│
├── firestore/                     # Rules + indexes — backend-engineer
│   ├── firestore.rules
│   ├── firestore.indexes.json
│   ├── tests/
│   └── CLAUDE.md
│
├── packages/shared/               # Shared types + zod schemas — co-owned
│   ├── src/types/
│   ├── src/schemas/
│   ├── src/canonicalEmail.ts
│   └── CLAUDE.md
│
├── infra/                         # Deploy + scripts + runbooks — infra-engineer
│   ├── scripts/
│   ├── runbooks/
│   ├── ci/workflows/
│   └── CLAUDE.md
│
├── e2e/                           # Playwright — web-engineer
│   ├── tests/
│   ├── fixtures/
│   └── playwright.config.ts
│
├── docs/                          # Spec, architecture — docs-keeper
│   └── CLAUDE.md
│
├── src/                           # Apps Script Main — RETIRED in Phase 11
├── identity-project/              # Apps Script Identity — RETIRED in Phase 11
│
├── firebase.json
├── .firebaserc
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── CLAUDE.md
├── TASKS.md
└── BUGS.md
```

## Phase dependency overview

```
1 Project skeleton + monorepo + emulators
 └─ 2 Firebase Auth + custom claims + sync triggers
     └─ 3 Firestore schema + security rules + indexes
         └─ 3.5 Infrastructure refresh + reactfire replacement
             ├─ 4 Web SPA shell + auth flow
             │   ├─ 5 Read-side pages
             │   │   └─ 6 Write-side pages — request lifecycle
             │   │       └─ 7 Manager admin pages + bootstrap wizard
             │   │           └─ 10 PWA shell + branding
             │   │               └─ 11 Data migration + cutover  ◄─── end of Phase A
             │   │                   └─ 12 Multi-stake (Phase B)
             │   └─ 8 Importer + Expiry + audit triggers
             │       └─ 9 Email triggers via SendGrid
             └─ (rules + indexes serve everything below)
```

Phase 5 → 6 → 7 is web-engineer's serial path. Phase 8 → 9 is backend-engineer's serial path. Once Phase 4 ships, both arcs run in parallel until they converge for Phase 10. Phase 11 is everyone-on-deck for the cutover window. Phase 3.5 is a single-pass infra refresh (replacing reactfire + bumping major deps) that all downstream phases inherit.

Phase 10.1 (navigation redesign — left rail + sectioned nav), Phase 10.5 (FCM push notifications — new-request → managers), and Phase 10.6 (push expansion — remaining four lifecycle types) are not shown in the tree above; all three are deferred and not gated on Phase 11 cutover. Phase 10.1 depends on Phases 4 + 7 (it replaces the Phase-4 nav once the Phase-7 admin pages have established the full nav-item set); Phase 10.5 depends on Phases 9 + 10; Phase 10.6 depends on Phases 9 + 10.5. See [`navigation-redesign.md`](navigation-redesign.md) for Phase 10.1's design.

---

## Phase 1 — Project skeleton + monorepo + emulators

**Goal:** A deployable Firebase project that runs end-to-end through the full stack — Vite-built React + TS client served by Hosting, reading a single doc from Firestore via the SDK. Local development via emulators works. CI runs lint + typecheck + tests on every PR.

**Owner:** infra-engineer (skeleton); web-engineer (Vite + React stub); backend-engineer (Functions + emulator config). Phase 1 is the only phase where all engineering agents land code together — after this they parallelize.

**Dependencies:** none.

### Sub-tasks

_GCP / Firebase project setup_

- [ ] Create two Firebase projects: `kindoo-staging` and `kindoo-prod`. Both Blaze plan with $1/month budget alert.
- [ ] Enable services on both: Firestore (Native mode), Authentication, Hosting, Cloud Functions, Cloud Scheduler, Cloud Messaging (FCM), Sheets API, Secret Manager.
- [ ] Service account `kindoo-app@<project>.iam.gserviceaccount.com` with roles: Firestore Service Agent, Secret Manager Secret Accessor, Cloud Run Invoker (Cloud Functions 2nd-gen runs on Cloud Run under the hood).
- [ ] Reserve Firestore database in `us-central1` (matches stake script timezone bias).

_Repo layout (per F14)_

- [ ] Create monorepo at repo root: `apps/web/`, `functions/`, `firestore/`, `packages/shared/`, `infra/`, `e2e/`. Existing `src/` and `identity-project/` left in place.
- [ ] `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`.
- [ ] TS strict mode in every workspace; one shared `tsconfig.base.json`; project references for cross-workspace deps.
- [ ] Per-workspace `CLAUDE.md` skeletons describing local conventions.

_Web client skeleton_

- [ ] Vite + React 19 + TS app with one route: hello page that reads `stakes/_smoketest/hello` from Firestore.
- [ ] TanStack Router scaffolded; placeholder route.
- [ ] reactfire `<FirestoreProvider>` wired up at `App.tsx`.
- [ ] `pnpm dev:web` runs Vite dev server on port 5173.
- [ ] Build output to `apps/web/dist/` for Hosting to serve.

_Functions skeleton_

- [ ] One callable function: `hello` returns `{ version, builtAt, env }`. Anonymous-callable for the smoketest only; real functions land in Phase 2.
- [ ] `pnpm dev:functions` runs against the emulator.
- [ ] Build version stamped at build time via `infra/scripts/stamp-version.js`.

_Firestore skeleton_

- [ ] `firestore/firestore.rules` stub: `allow read, write: if false;` (locked down; opens up phase by phase).
- [ ] `firestore/firestore.indexes.json` empty.
- [ ] Rules tests scaffold using `@firebase/rules-unit-testing`.

_Hosting + emulators_

- [ ] `firebase.json` configured for Hosting, Functions, Firestore, Auth emulators.
- [ ] `pnpm dev` runs all emulators + Vite + Functions in parallel. One command, all green.
- [ ] `apps/web/.env.example` template documenting env vars (consumed by per-mode `apps/web/.env.staging` / `.env.production`, both gitignored).

_Deploy pipeline_

- [ ] `infra/scripts/deploy-staging.sh` and `deploy-prod.sh`: build web → deploy Hosting; build functions → deploy.
- [ ] CI runs tests on every PR; deploys remain operator-triggered.

_Observability foundations_

- [ ] Cloud Logging captures Functions logs automatically.
- [ ] Log-based metric definitions live in `infra/monitoring/metrics/`: `audit_trigger_failures`, `claim_sync_failures`, `firestore_rules_denied_count`. Additional metrics (`importer_duration`, `expiry_duration`) land in Phase 8.
- [ ] Alert policies in `infra/monitoring/alerts/`, all to Tad's email:
  - Phase 1: any function 5xx > 1/minute for 5 minutes.
  - Phase 8: importer didn't complete within 10 minutes of scheduler fire.
  - Phase 8: expiry didn't complete within 5 minutes of fire.
- [ ] Google Cloud Error Reporting enabled.
- [ ] `infra/runbooks/observability.md` documents metrics + how to add one.

_Backup and DR_

- [ ] Firestore Point-in-Time Recovery (PITR) enabled on `kindoo-prod` from Phase 1. 7-day window.
- [ ] Scheduled Firestore export: weekly Sunday 02:00 → `gs://kindoo-prod-backups/YYYY-MM-DD/`. 90-day lifecycle.
- [ ] `infra/runbooks/restore.md`: PITR restore, full GCS-export restore, partial collection restore.

_Test infrastructure (per F13)_

- [ ] Vitest configured per workspace; shared base config.
- [ ] `pnpm test:unit`, `test:integration`, `test:rules`, `test:e2e`, `test:all`.
- [ ] `@firebase/rules-unit-testing` installed; helper at `firestore/tests/lib/rules.ts`.
- [ ] Auth + Firestore emulator helpers at `apps/web/test/lib/`.
- [ ] Playwright installed; smoke spec at `e2e/tests/smoke.spec.ts`.
- [ ] Coverage via vitest c8 → `coverage/` (gitignored).
- [ ] `infra/ci/workflows/test.yml` runs lint + typecheck + tests on every push/PR.

### Tests

_Unit_

- [ ] `version.ts` returns the stamped build timestamp.
- [ ] `packages/shared/src/canonicalEmail.ts` skeleton against fixture inputs.

_Integration_

- [ ] `hello` callable returns the expected shape (vitest against in-process emulator).
- [ ] Firestore Admin SDK reads a seeded doc (`stakes/_smoketest/hello`) from emulator.

_E2E_

- [ ] Playwright smoke: Vite-served page loads at `localhost:5173`, fetches the hello doc, renders it.

_CI_

- [ ] `.github/workflows/test.yml` runs the full pipeline on push; a contrived failing test in any layer blocks the workflow.

### Acceptance criteria

- `pnpm dev` brings up emulators + Vite + Functions; opening `localhost:5173` reads + renders the smoketest doc.
- `pnpm deploy:staging` deploys Hosting + Functions; staging URL works.
- A test doc seeded into staging Firestore is readable from the deployed web app.
- `tsc -b` clean across all workspaces.
- CI passes on a clean PR.
- `kindoo-prod` Firestore is empty (no data until Phase 11).

### Out of scope

- Real authentication — Phase 2.
- Real schema or rules — Phase 3.
- Any real page beyond the smoketest — Phase 4+.

---

## Phase 2 — Firebase Auth + custom claims + sync triggers

**Goal:** Sign-in works end-to-end. After clicking "Sign in with Google," the user's verified identity reaches the client, the `onAuthUserCreate` trigger writes `userIndex/{canonical}`, claim-sync triggers seed custom claims from any pre-existing role data, and the client renders a Hello page showing the user's email + decoded role claims.

**Owner:** backend-engineer (functions + Auth config); web-engineer (Auth UI + principal hook).

**Dependencies:** Phase 1.

### Seven proofs (per spec.md §4 lineage from Apps Script Chunk 1)

1. **Login page loads.** Visiting the app while signed out shows a "Sign in with Google" button. No errors.
2. **Sign-in produces a Firebase ID token.** Clicking triggers `signInWithPopup`; the client receives an ID token via `onIdTokenChanged`.
3. **Server verifies the token.** Custom claims are checked in rules via `request.auth.token.stakes[stakeId].*`. Tampered tokens reject; expired tokens auto-refresh via the SDK.
4. **`onAuthUserCreate` writes `userIndex`.** First sign-in creates `userIndex/{canonical}` with `{uid, typedEmail, lastSignIn}`.
5. **Claim sync seeds initial claims.** If the user's canonical email already exists in `kindooManagers/` or `access/`, the trigger sets the corresponding stakes claims at creation time and revokes refresh tokens so the next request picks them up.
6. **Hello page renders email + decoded roles.** A Phase-2-only `pages/hello.tsx` reads claims via `usePrincipal()`. Deleted in Phase 5.
7. **Failure modes correct.** No token → login. Token valid but no claims → NotAuthorized. Token tampered → 401, client clears state, returns to login.

### Sub-tasks

_Firebase Auth setup_

- [ ] Enable Google sign-in provider in both Firebase projects.
- [ ] Authorized domains: `localhost`, `kindoo-staging.web.app`, `kindoo-prod.web.app`, `kindoo.csnorth.org` (last one Phase 11).

_Web client_

- [ ] `apps/web/src/lib/firebase.ts` — `initializeApp` with project config + emulator detection.
- [ ] `apps/web/src/features/auth/` — `useAuth()` hook wrapping reactfire's `useUser`; `signIn()`, `signOut()`.
- [ ] `apps/web/src/lib/principal.ts` — `usePrincipal()` returns `{ email, canonical, isManager, isStakeMember, bishopricWards, isPlatformSuperadmin }` derived from token claims.
- [ ] **Force token refresh on first sign-in completion** — call `getIdToken(true)` after `signInWithPopup` resolves so claims are picked up before the first authenticated read.
- [ ] `apps/web/src/features/auth/pages/login.tsx`, `notAuthorized.tsx`. Topbar with email + sign-out.
- [ ] Phase-2 placeholder: `apps/web/src/features/auth/pages/hello.tsx` showing email + decoded claims.

_Custom claims schema_

- [ ] Defined in `packages/shared/src/types/auth.ts`:
  ```typescript
  export type CustomClaims = {
    canonical: string;
    isPlatformSuperadmin?: boolean;
    stakes?: Record<string, { manager: boolean; stake: boolean; wards: string[] }>;
  };
  ```

_Cloud Functions_

- [ ] `functions/src/triggers/onAuthUserCreate.ts` — writes `userIndex/{canonical}`; checks `kindooManagers/` and `access/` for pre-existing role data; seeds claims if any; revokes refresh tokens.
- [ ] `functions/src/triggers/syncAccessClaims.ts` — fires on `stakes/{sid}/access/{canonical}` writes; recomputes `stakes[sid].stake` + `stakes[sid].wards`; calls `setCustomUserClaims` + `revokeRefreshTokens`.
- [ ] `functions/src/triggers/syncManagersClaims.ts` — fires on `stakes/{sid}/kindooManagers/{canonical}` writes; toggles `stakes[sid].manager`.
- [ ] `functions/src/triggers/syncSuperadminClaims.ts` — fires on `platformSuperadmins/{canonical}` writes; toggles `isPlatformSuperadmin`. (Skeleton; superadmin set is empty in v1.)
- [ ] `functions/src/lib/canonicalEmail.ts` — re-exports from `packages/shared`.
- [ ] Helper `functions/src/lib/uidLookup.ts` — `uidForCanonical(canonical)` reads `userIndex` then falls back to `getUserByEmail`.

_Shared (per F2 monorepo)_

- [ ] `packages/shared/src/canonicalEmail.ts` — port of `Utils_normaliseEmail` to TS. Cases: lowercase + Gmail dot-strip + `+suffix`-strip + `googlemail.com` → `gmail.com` fold.
- [ ] `packages/shared/src/types/auth.ts` — claims type, principal type.

_Rules (Phase 2 increment)_

- [ ] `userIndex/{canonical}`: `read` if `request.auth.uid == resource.data.uid`; `write` server-only.

_Seed data (staging)_

- [ ] Manually via Firebase console or `infra/scripts/seed-staging.ts`: one `stakes/csnorth` parent doc + one `stakes/csnorth/kindooManagers/{your-canonical}` doc. Just enough to prove role resolution.

### Tests

_Unit_

- [ ] `canonicalEmail`: `Alice.Smith@Gmail.com`, `alicesmith+church@googlemail.com`, `alice@csnorth.org`, whitespace edges, `googlemail.com` → `gmail.com` folding.
- [ ] `usePrincipal` derives the right shape from various claim fixtures (no claims, manager-only, multi-role).

_Integration (Auth + Firestore emulators)_

- [ ] `onAuthUserCreate` writes `userIndex/{canonical}` with correct shape.
- [ ] `onAuthUserCreate` seeds claims if pre-existing `kindooManagers/{canonical}` exists; verified via emulator inspection.
- [ ] `syncAccessClaims`: write to `access/{canonical}` with stake scope → `stakes.csnorth.stake = true`; with ward scope → `stakes.csnorth.wards = [wardCode]`; doc deletion → claim cleared.
- [ ] `syncAccessClaims` calls `revokeRefreshTokens` (verified via Auth emulator's revoke listener).
- [ ] Email canonicalization variant (`a.b+x@gmail.com` registered, lookup with `ab@gmail.com`) → resolves identically.
- [ ] `userIndex` collision (two distinct uids canonicalising the same) → second write fails or surfaces an alert.

_E2E (Playwright)_

- [ ] Sign in via Auth emulator → bootstrap → Hello page renders email + roles. (All seven proofs.)
- [ ] Sign out → returns to login; subsequent rpc-equivalent (Firestore SDK call) → 401-equivalent (PERMISSION_DENIED on a read attempt).
- [ ] Manually mutate access doc → next page-fetch cycle reflects updated roles.

### Acceptance criteria

- All seven proofs pass against staging.
- `stakeId='csnorth'` is the only stake. Constant lives in `apps/web/src/lib/constants.ts`.
- Apps Script Identity project is **NOT** yet decommissioned — stays as the prod auth source until Phase 11.
- Refreshing the page mid-session keeps the user signed in.
- A user not in any role data lands on NotAuthorized.

### Out of scope

- Real role-based pages — Phase 5+.
- Multi-stake principal shape — Phase 12.
- Platform superadmin UI — Phase 12 (trigger skeleton lands here).

---

## Phase 3 — Firestore schema + security rules + indexes

**Goal:** All collections defined per `docs/firebase-schema.md`. Rules complete, deny-by-default with explicit allows. All composite indexes declared. Rules tests cover every collection's read/write paths. The data layer is locked in for everything Phase 4+ will build on.

**Owner:** backend-engineer.

**Dependencies:** Phase 2.

### Sub-tasks

_Schema_

- [ ] `packages/shared/src/types/` — TS types for every collection per `firebase-schema.md` §§3–4: `Stake`, `Ward`, `Building`, `KindooManager`, `Access`, `Seat`, `Request`, `WardCallingTemplate`, `StakeCallingTemplate`, `AuditLog`, `UserIndex`, `PlatformSuperadmin`, `PlatformAuditLog`.
- [ ] `packages/shared/src/schemas/` — zod schemas matching the types, used for validation in both client forms and Cloud Function input.

_Rules_

- [ ] `firestore/firestore.rules` — implementation per `firebase-schema.md` §6, deny-by-default with explicit allows per collection. Helpers: `isManager`, `isStakeMember`, `bishopricWardOf`, `isAnyMember`, `isPlatformSuperadmin`, `lastActorMatchesAuth`. Cross-doc invariant: `tiedToRequestCompletion` for seat creation.
- [ ] Inline comments explaining `getAfter()` use, the `lastActor` integrity check, and the importer/manual split-ownership.

_Indexes_

- [ ] `firestore/firestore.indexes.json` — composite indexes per `firebase-schema.md` §5.1.
- [ ] TTL field configured on `auditLog` collection group via `gcloud firestore fields ttls update`.

_Helpers and conventions_

- [ ] `packages/shared/src/buildingSlug.ts` — slugify helper for building doc IDs.
- [ ] `packages/shared/src/auditId.ts` — generates `<ISO ts>_<uuid>` deterministic audit IDs.

_Per-doc shape verification_

- [ ] No repos in this architecture (client uses Firestore SDK directly), but a thin **typed-doc-helper** layer in `apps/web/src/lib/docs.ts` exports typed `doc(...)` and `collection(...)` references with the right path for each collection. Web-engineer consumes; backend-engineer mirrors in functions if needed.

### Tests

_Unit_

- [ ] zod schema parses for representative documents in each collection. Round-trip via `schema.parse(seedDoc)`.
- [ ] `auditId` generator: deterministic; sortable by reverse lex; no collisions for synthetic distinct inputs.
- [ ] `buildingSlug`: `'Cordera Building'` → `'cordera-building'`; deterministic.

_Rules (rules-unit-testing) — every collection_

- [ ] **Top-level:** anon read `userIndex` denied; authenticated user read own → ok; read other → denied. Same for `platformSuperadmins`, `platformAuditLog`.
- [ ] **`stakes/{sid}` parent doc:** member can read; manager can update with `lastActor` matching; non-member denied; superadmin can create; nobody can delete.
- [ ] **`wards`, `buildings`:** any member of stake can read; only manager can write.
- [ ] **`kindooManagers`:** manager can read + write; non-manager denied.
- [ ] **`access`:**
  - Manager can read.
  - Non-manager denied.
  - Manager creates new doc with manual_grants only → ok.
  - Manager update touches only `manual_grants` → ok.
  - Manager update tries to mutate `importer_callings` → denied (split-ownership).
  - Manager deletes doc with both maps empty → ok; with content → denied.
- [ ] **`seats`:**
  - Manager reads any.
  - Bishopric reads own ward's seats; other ward's denied.
  - Stake member reads stake-scope seats.
  - Manager creates manual seat tied to a request transitioning to complete in same tx → ok.
  - Manager creates manual seat without request linkage → denied.
  - Manager updates allowed fields only → ok; immutable field change denied.
  - Manager deletes seat with non-empty `duplicate_grants` → denied.
- [ ] **`requests`:**
  - Manager reads any.
  - Requester reads own.
  - Bishopric reads own-ward requests.
  - Stake member reads stake-scope requests.
  - Submit with `pending` status, requester matching auth, member_name present (for add types) → ok.
  - Submit with bad scope (not requester's) → denied.
  - Cancel by original requester → ok; by another user → denied.
  - Complete by manager → ok; by non-manager → denied.
  - Reject without reason → denied.
  - Update non-pending → denied (terminal states one-way).
  - Delete → always denied.
- [ ] **`wardCallingTemplates`, `stakeCallingTemplates`:** manager-only read + write.
- [ ] **`auditLog`:** manager reads; all writes denied (server-only).

_Cross-stake denial_

- [ ] User with claims for stake A trying to read any doc under stake B → denied (covered by `isAnyMember(stakeId)` checks evaluating false).

### Acceptance criteria

- Every collection defined; every rules path tested.
- Composite-key uniqueness on access (manager can't insert duplicate manual_grant for same scope+reason) — tested via emulator.
- Email canonicalization tests pass for typed-form variants.
- Cross-stake reads forbidden.
- Type-check clean; no `any` in shared types.
- Staging Firestore still empty except for Phase-2 seeds.

### Out of scope

- Web client wiring — Phase 4+.
- Real data — Phase 11.
- Cloud Function business logic (importer, expiry, email) — Phases 8/9.

---

## Phase 3.5 — Infrastructure refresh + reactfire replacement

**Goal:** A modern dependency baseline before Phase 4 onward commits the SPA to long-lived choices. `reactfire` (originally locked in by F2) is replaced by a thin in-house hooks layer at `apps/web/src/lib/data/` on top of TanStack Query + the Firebase SDK directly. The remaining major dep bumps land in one disciplined pass. Behaviour-preserving: every test that passed at the close of Phase 3 must still pass on the new baseline.

**Owner:** mixed. `web-engineer` leads (most of the surface area). `backend-engineer` handles the `firebase-functions` 6 → 7 bump and the `zod` 3 → 4 migration in functions schemas. `infra-engineer` owns the Volta pin, the pnpm 10 bump, lockfile churn, and a short version-baseline note in `infra/CLAUDE.md`. `docs-keeper` writes the closing changelog and adds the architecture decision recording the reactfire → DIY-hooks swap.

**Dependencies:** Phase 3 (closed at commit `bb6d7a9`).

**Why this phase exists:** A dependency audit on 2026-04-28 found that `reactfire` (the React + Firebase wiring layer chosen in F2) is unmaintained — last release v4.2.3 on 2023-06-27, README badge "Experimental — not a supported Firebase product", 53 open issues + 57 unmerged PRs, no Firebase v12 or React 19 compatibility statement. `react-firebase-hooks` (CSFrequency) had a v5.1.1 release in November 2024 but its v5.1.0 release notes flagged unresolved React 18 issues; ruled inactive. `@invertase/tanstack-query-firebase` is actively maintained but its Firestore live-query support is officially "🟠 Work in progress" — only `firestore/lite` (no `onSnapshot`) is "✅ Ready for use", and Phases 5+ shared-attention pages need real-time listeners. The decision (signed off 2026-04-28) is to drop reactfire and own the wiring as ~80 lines of code under `apps/web/src/lib/data/`. Recorded in `architecture.md` as D11. Once we're touching the dependency surface, the previously-deferred major-version bumps come along too — except `@google/clasp` (Apps Script side gets deleted at Phase 11) and `@types/node` (must match the Node 22 runtime).

### Sub-tasks

_Toolchain pinning (mostly already in working tree; this phase finishes + verifies)_

- [ ] Volta-pin Node 22.22.2 in root `package.json` (`"volta": { "node": "22.22.2" }`). Already in working tree.
- [ ] `engines.node` bumped to `>=22` in root + every workspace `package.json`. Already in working tree.
- [ ] `.nvmrc` (`22`) and `.npmrc` (`engine-strict=true`) at repo root. Already in working tree.
- [ ] Bump `packageManager` field from `pnpm@9.15.0` to the current pnpm 10.x line; run `volta install pnpm@10.x` (Volta's pnpm support is gated on `VOLTA_FEATURE_PNPM=1`, already enabled in the operator's env); regenerate `pnpm-lock.yaml`.
- [ ] Closes T-14 (formal close happens at Phase 3.5 commit time).

_Reactfire removal + DIY hooks layer (load-bearing)_

- [ ] Remove `reactfire` from `apps/web/package.json` dependencies.
- [ ] Drop the `reactfire>firebase: "11"` entry from the `pnpm.peerDependencyRules.allowedVersions` block in root `package.json`. Keep the `@firebase/rules-unit-testing>firebase` entry, updating it to whatever Firebase v12 line we land on.
- [ ] New module `apps/web/src/lib/data/`:
  - `useFirestoreDoc.ts` — accepts a Firestore `DocumentReference<T>`; subscribes via `onSnapshot(ref)`; pushes each snapshot into the TanStack Query cache via `setQueryData`; returns the standard TanStack Query result shape `{ data, status, error, ... }`. Cleans up the subscription on unmount and on ref change.
  - `useFirestoreCollection.ts` — same shape for `Query<T>` (collection reference or query). Returns `T[]` data; preserves referential stability across no-op snapshots so React doesn't re-render downstream consumers gratuitously.
  - `useFirestoreOnce.ts` — one-shot via `getDoc` / `getDocs`, no live subscription. Used by Phase 5's Audit Log cursor pagination (per the Phase 5 plan: "Audit Log uses TanStack Query for cursor-based pagination — NOT live; pagination doesn't compose with live").
  - `index.ts` — barrel re-exporting the three hooks.
- [ ] `apps/web/src/lib/data/firebase.ts` — re-exports the Firestore + Auth instances from the existing `apps/web/src/lib/firebase.ts` (wired in Phase 2); keeps emulator detection consistent across consumers.
- [ ] Hook signatures accept `DocumentReference<T>` / `Query<T>` directly. They do **not** depend on the typed-doc helper at `apps/web/src/lib/docs.ts` (which lands when the Phase 4 SPA shell is re-applied) — the helper produces refs of the right shape and the hooks consume them. This keeps the hooks layer independently testable.
- [ ] No React-context provider is required for the SDK instances themselves — Firebase's `getFirestore()` / `getAuth()` are module-scoped singletons. If a `<DataProvider>` becomes useful later for testability, it lives in this module; v1 ships without one.

_Web stack bumps (`apps/web`)_

- [ ] `firebase` 11.10.0 → 12.x (latest stable line).
- [ ] `vite` 6.4.2 → 8.x.
- [ ] `@vitejs/plugin-react` 4.7.0 → 6.x (tied to Vite 8).
- [ ] `vitest` 2.1.9 → 4.x.
- [ ] `jsdom` 25 → 29.
- [ ] `@hookform/resolvers` 3 → 5.
- [ ] `zod` 3.25 → 4.x. Note: zod v4 has breaking syntax changes for nested schemas; web-side schema changes are minor compared to shared-package work below.

_Functions stack bumps (`functions`)_

- [ ] `firebase-functions` 6.6 → 7.x. Verify v1 `auth.user().onCreate` and v2 Firestore document-write triggers still register correctly via the existing emulator integration tests (Phase 2's claim-sync triggers).
- [ ] `firebase-admin` stays on 13.x (already current).
- [ ] `vitest` 2 → 4 (matches web).
- [ ] `esbuild` 0.24 → 0.28.

_Shared / firestore-tests / e2e stack bumps_

- [ ] `@kindoo/shared`: `vitest` 2 → 4; `zod` 3 → 4. The zod v3 → v4 migration is the bulk of the shared-package work — schemas need rewriting to v4 syntax.
- [ ] `@kindoo/firestore-tests`: `@firebase/rules-unit-testing` 3.0.4 → 5.x; `firebase` 11 → 12; `vitest` 2 → 4.
- [ ] `@kindoo/e2e`: `@playwright/test` already current; nothing to bump.

_Root + cross-cutting bumps_

- [ ] `typescript` 5.9 → 6.x in root + per-workspace `tsconfig` checks for module-resolution behaviour changes.
- [ ] `pnpm` 9.15.0 → 10.x (already covered above under toolchain pinning).

_Hard exclusions (called out so future agents don't try)_

- `@types/node` stays on `^22.x`. Must match the Node 22 LTS runtime; bumping past 22 imports types for APIs not present at runtime. Documented in `infra/CLAUDE.md`.
- `@google/clasp` 2 → 3 is **not** part of this phase. The Apps Script side gets deleted at Phase 11 cutover; not worth the work.

_Phase 4 plan reconciliation_

- [ ] Update Phase 4 sub-tasks below: drop the reactfire `<FirebaseAppProvider>` / `<FirestoreProvider>` / `<AuthProvider>` bullet; replace with "DIY hooks consumed directly; SDK singletons exported from `lib/firebase.ts`." Update Phase 4's `Dependencies:` line to include Phase 3.5.
- [ ] Note in the Phase 4 prose that the WIP branch `phase-4-spa-shell-wip` (commit `d38bda1`) gets rebased onto post-3.5 `main` once 3.5 closes, with breakage fixes (reactfire calls become DIY-hook calls; Vite/Vitest config tweaks for the new majors; etc.).

### Tests

The Phase 3.5 test surface is mostly "everything that already passed must still pass" plus a small new thin-hooks suite.

_Existing (must still pass on the new baseline)_

- [ ] `@kindoo/shared`: 69 tests.
- [ ] `@kindoo/firestore-tests`: 160 rules tests.
- [ ] `@kindoo/functions`: 1 unit + 21 emulator-gated integration.
- [ ] `@kindoo/web`: 6 tests on `main` at the start of this phase (principal, version, SignInPage, NotAuthorizedPage from Phase 2). Must still pass on Firebase 12 + Vite 8 + Vitest 4 + zod 4.

_New — thin hooks layer (`apps/web/src/lib/data/*.test.ts`)_

- [ ] `useFirestoreDoc`: mock `onSnapshot` and verify the hook re-renders on snapshot push, returns the right `{ data, status }` shape for loading / success / error, cleans up the subscription on unmount, and re-subscribes correctly on ref change.
- [ ] `useFirestoreCollection`: same as doc; plus verify referential stability — array data only re-creates when underlying snapshots actually change.
- [ ] `useFirestoreOnce`: mock `getDoc` / `getDocs`; verify one-shot behaviour and proper TanStack Query cache integration.
- [ ] Error path: snapshot listener throws → hook surfaces error in `error` field; cleanup still runs on unmount.

_Smoke_

- [ ] `pnpm --filter @kindoo/web build` succeeds on the new baseline.

### Acceptance criteria

- All workspace `typecheck && lint && test` pass on Node 22.22.2 + pnpm 10.x.
- `@kindoo/web` production build is clean on the new baseline.
- `apps/web/src/lib/data/` hooks exist, are tested, and are ready for Phase 4 (re-applied) and Phase 5 to consume.
- `reactfire` is gone from `apps/web/package.json`, from `pnpm-lock.yaml`, and from the `pnpm.peerDependencyRules.allowedVersions` block in root `package.json`.
- D11 added to `architecture.md` recording the reactfire → DIY-hooks decision.
- Cloud Functions still register correctly under `firebase-functions` v7 (verified by the existing emulator integration tests).
- Phase 4's sub-task list reflects reactfire-removed reality; Phase 4's `Dependencies:` line includes Phase 3.5.
- T-14 closed in `docs/TASKS.md`.

### Out of scope

- Any new pages — Phase 4+.
- The Phase 4 SPA shell itself — that resumes after Phase 3.5 closes by rebasing branch `phase-4-spa-shell-wip` onto post-3.5 `main` and fixing breakage from the dep bumps + reactfire removal.
- `@google/clasp` 2 → 3 (above).
- `@types/node` past `^22.x` (above).
- Any Firestore schema / rules / index changes — owned by Phase 3, closed.

---

## Phase 4 — Web SPA shell + auth flow + first page

**Goal:** A complete React SPA shell — sign-in, layout with topbar + nav, content slot, client-side routing. One placeholder page (`hello`, surfaced through the shell) proves the loop works against real Firestore + Auth. The app feels like an SPA.

**Owner:** web-engineer.

**Dependencies:** Phase 2 (auth) + Phase 3 (rules permit reads) + Phase 3.5 (DIY hooks layer + new dep baseline).

### Sub-tasks

_Stack wiring_

- [ ] TanStack Router with file-based routes under `apps/web/src/routes/`.
- [ ] TanStack Query provider at root.
- [ ] DIY Firestore hooks consumed directly from `apps/web/src/lib/data/` (per Phase 3.5 / D11). SDK singletons exported from `apps/web/src/lib/firebase.ts`; no React-context provider for the SDK instances themselves.
- [ ] Zustand for cross-page state (toast queue, modal stack).

_Routing_

- [ ] Authed-route group `_authed/` that gates on `usePrincipal().isAuthenticated`.
- [ ] Per-role authed-route subgroups: `_authed/manager/`, `_authed/bishopric/`, `_authed/stake/`.
- [ ] `routes/index.tsx` — route default per principal: manager → `/manager/dashboard`, stake → `/stake/new`, bishopric → `/bishopric/new`. Multi-role → highest priority's leftmost tab. Matches today's spec §5 default-landing rule.
- [ ] URL convention preserves `?p=…&ward=…` deep-links: TanStack Router's `validateSearch` per route uses zod schemas in `packages/shared/src/schemas/`.

_Layout_

- [ ] `apps/web/src/components/layout/Shell.tsx` — topbar (email + version + sign-out + stake selector slot), Nav, content slot. Stable across navigation.
- [ ] `Nav.tsx` — role-aware links generated from principal claims. Active route highlighted.
- [ ] `Toast.tsx` — toast container + helper.
- [ ] `Dialog.tsx` — accessible modal primitive (focus-trap, ESC-close, ARIA).

_Render helpers (port from Apps Script `ClientUtils.html`)_

- [ ] `apps/web/src/lib/render/` — `formatDate`, `formatDateTime`, `escapeHtml` (typed via tagged template), `renderUtilizationBar`, `EmptyState`, `LoadingSpinner`.
- [ ] All TS, all typed.

_Styles_

- [ ] Port `Styles.html` to plain CSS under `apps/web/src/styles/`. Mechanical translation; preserve selectors and values so visuals match.
- [ ] Mobile-first; CSS modules per feature where useful.

_Placeholder page_

- [ ] `routes/_authed/hello.tsx` — Phase-2's hello, now rendered through the shell. Deleted in Phase 5.

_Token refresh choreography_

- [ ] After `signInWithPopup` resolves, force `getIdToken(true)` before the first authenticated query — ensures fresh claims on the first read.
- [ ] Listen to `onIdTokenChanged` for hourly auto-refresh and `revokeRefreshTokens`-driven refreshes; re-render principal-dependent UI.

### Tests

_Unit (vitest + jsdom + React Testing Library)_

- [ ] `escapeHtml` against XSS-y inputs.
- [ ] `formatDate` against fixed Date inputs in stake tz; null renders as empty.
- [ ] `renderUtilizationBar`: under cap → blue; ≥90% → amber; over cap → red + "OVER CAP" label.
- [ ] `Shell` renders email + sign-out button.
- [ ] `Nav` renders role-appropriate links; active link highlighted.
- [ ] `Toast` queue: enqueue + dismiss + auto-dismiss after timeout.
- [ ] `Dialog` focus-trap + ESC behaviour (RTL + jsdom).

_Hooks_

- [ ] `usePrincipal` returns the right shape from token-claim fixtures.

_E2E (Playwright)_

- [ ] Sign-in flow: Auth emulator → click Sign In → popup completes → token issued → bootstrap reads → hello page renders within shell.
- [ ] Sign-out clears state and returns to login.
- [ ] Browser back/forward across nav clicks: forward through pages, back, forward — content matches.
- [ ] Direct deep-link `localhost:5173/?p=hello` → bootstraps + lands on hello.
- [ ] Mobile viewport (375×667): no horizontal scroll; nav usable; topbar legible.

### Acceptance criteria

- Sign-in works end-to-end; hello page renders inside the shell.
- Sign-out clears state and returns to login.
- 401-equivalent triggers automatic token refresh; if refresh fails, returns to login.
- Layout shell stable across navigation.
- Browser back/forward work.
- Direct deep-link works.
- Topbar shows correct email + version stamp.
- Mobile (375px) usable.
- `tsc -b` clean.
- Build (`pnpm build:web`) produces deployable `apps/web/dist/`.

### Out of scope

- Any real page beyond hello — Phase 5+.
- PWA shell (manifest, SW) — Phase 10.
- Stake selector UI — Phase 12.

---

## Phase 5 — Read-side pages

**Goal:** Every read-only page from the Apps Script app renders correctly on Firebase against real Firestore data. No new features; no UI redesigns. Live updates via reactfire on shared-attention pages (Queue, Roster, MyRequests, Dashboard).

**Owner:** web-engineer.

**Dependencies:** Phase 4.

### Sub-tasks (one feature folder per page family)

- [ ] `features/bishopric/` — Roster (live), MyRequests (live), Ward dropdown for multi-ward counsellors.
- [ ] `features/stake/` — Roster (live), Ward Rosters (read-only browse).
- [ ] `features/manager/dashboard/` — Five cards (Pending counts, Recent Activity, Utilization, Warnings, Last Operations); each card is its own live query; deep-links to downstream pages.
- [ ] `features/manager/allSeats/` — Full roster; ward / building / type filters via URL search params; per-scope summary cards with utilization bars; total-utilization bar when scope filter is "All".
- [ ] `features/manager/auditLog/` — Filter panel (action, entity_type, entity_id, member, actor, date range); pagination via cursor; per-row collapsed summary + `<details>` diff. New filter: by `member_canonical` for cross-collection per-user view.
- [ ] `features/manager/access/` — Read view (importer + manual rendered as one card per user with importer/manual visually split per `firebase-schema.md` §4.5 rendering note). Write actions land in Phase 7.
- [ ] `features/myRequests/` — Live; cancel button on pending; rejection reason on rejected; multi-role scope filter.
- [ ] Delete `routes/_authed/hello.tsx`.
- [ ] Update `Nav.tsx` to expose all read-side pages.

_Live data pattern_

- [ ] Each shared-attention page uses `useFirestoreCollectionData` (reactfire). Re-renders automatically on snapshot.
- [ ] Manager Dashboard fans in 5 parallel queries; `isLoading` is "any of them loading."
- [ ] Audit Log uses TanStack Query for cursor-based pagination (NOT live; pagination doesn't compose with live).

### Tests

_Unit (RTL)_

For each page:
- [ ] Empty state: zero results → "No seats / no requests / no entries" rendering.
- [ ] One-row state: row markup correct, action affordances per role.
- [ ] Full-fixture state: row counts match input.

Page-specific:
- [ ] `manager/dashboard`: five cards render with all-empty model and with all-populated model.
- [ ] `manager/auditLog`: pagination state ("Showing 11–20 of 87"); `<details>` expands diff; `complete_request` rows surface `completion_note` inline.
- [ ] `manager/allSeats`: filter row stacks at 375px; per-scope summary cards render; total-utilization bar shown when scope filter is "All".
- [ ] `bishopric/roster`: ward-dropdown rendered iff principal has multiple bishopric wards.
- [ ] `manager/access`: importer rows read-only; manual rows have delete affordance (writes Phase 7).

_Hook tests_

- [ ] `useRequestsQueue` (consumed by Phase 6 too): correct query shape per filter combo.
- [ ] `useSeatsForScope`: correct filter applied; only readable docs returned (verified via emulator + auth tokens).

_E2E (Playwright)_

For each read page:
- [ ] Sign in as appropriate role → navigate → renders without error against emulator-seeded data.
- [ ] Filter via URL deep-link (`?ward=CO&type=manual`) → both filters pre-populated.
- [ ] Mobile viewport → no horizontal scroll.

Page-specific:
- [ ] `manager/auditLog`: Next/Prev paginates; counter updates.
- [ ] `manager/dashboard`: deep-links land on correct downstream page with filter state preserved.
- [ ] Multi-ward bishopric: switching ward dropdown re-renders other ward's roster.
- [ ] Live update verification: open Queue in two browser sessions; submit a request from one; second updates within 1s.

### Acceptance criteria

- Every Chunk 5 / Chunk 10 acceptance criterion for read paths passes against Firestore data populated from a recent Sheet snapshot.
- Filter state survives URL deep-links.
- Pagination on Audit Log works.
- Dashboard cards render across empty / one-ward / all-wards states.
- Mobile usable across all pages.
- Live updates work on Queue, Roster, MyRequests, Dashboard.
- `tsc -b` clean.

### Out of scope

- Write paths — Phase 6.
- Bootstrap wizard — Phase 7.
- Inline edits on All Seats — Phase 7.

---

## Phase 6 — Write-side pages — request lifecycle

**Goal:** Full request lifecycle works end-to-end. Submit → Manager Queue → Mark Complete / Reject. Cancel flow. Removal flow. All transactions atomic; all rules paths verified.

**Owner:** web-engineer (forms + mutations + dialogs); backend-engineer (any rule changes that surface during testing).

**Dependencies:** Phase 5.

### Sub-tasks

_Request lifecycle_

- [ ] `features/requests/components/NewRequestForm.tsx` — `add_manual` / `add_temp` form. Scope selector for multi-role principals. Building checkboxes for stake scope. Duplicate-warning inline (live query against `seats/{member_canonical}` to detect existing seat). Member-name required client- + server-side. react-hook-form + zod.
- [ ] `features/myRequests/` — cancel mutation.
- [ ] `features/manager/queue/` — Mark Complete dialog + Reject dialog. CompleteDialog with Buildings checkbox group, at-least-one-required gate (client + server).
- [ ] Mark Complete transaction: writes seat doc + flips request, atomically. Per `firebase-schema.md` §6 rules.
- [ ] Reject transaction: flips request, with reason.
- [ ] Cancel transaction: flips request to cancelled, requester only.

_Removal flow_

- [ ] X / trashcan on manual+temp roster rows (bishopric Roster + stake Roster + manager All Seats).
- [ ] Remove modal with required reason field.
- [ ] "Removal pending" badge once submitted.
- [ ] R-1 race handling: client tx checks seat existence inside the transaction; if absent, request flips with `completion_note` and only one audit row is generated (because no seat write happened).
- [ ] **Note:** Phase 8's `removeSeatOnRequestComplete` Cloud Function handles the Admin-SDK-side delete that's needed for non-R-1 normal removes (since rules' `seats.delete` can't see the linked request). Phase 6 wires the request-flip; Phase 8 wires the seat delete.

_Optimistic UX_

- [ ] All mutations rely on Firestore SDK's local cache for optimistic rendering. Errors surface as toasts; cache rolls back automatically on rules rejection.

### Tests

_Unit_

- [ ] `NewRequestForm` validation: member name required for add types; building required for stake scope; date validity for add_temp.
- [ ] CompleteDialog: Confirm enabled when ≥1 building ticked; disabled otherwise.

_Integration (Firestore emulator)_

- [ ] `submit add_manual` for seat-less member → request written with pending status, audit row appears (via trigger; Phase 8) within ~1s.
- [ ] `submit add_manual` for member already with a seat → still 200 (warning, not block); duplicate warning surfaced in form.
- [ ] `Mark Complete add_manual` → seat created, request flipped, both audit rows present.
- [ ] `Mark Complete add_temp` → temp seat created with dates; request flipped.
- [ ] `Mark Complete remove with seat present` → seat deleted via Phase 8 trigger, request flipped.
- [ ] `Mark Complete remove with seat already gone` (R-1) → request flipped with `completion_note`; only one audit row.
- [ ] `Mark Complete already-completed` (concurrent) → 409-equivalent: tx fails, error toast.
- [ ] `Reject` empty reason → form-validation error; non-empty → request flips with reason.
- [ ] `Cancel` by original requester → ok; by other user → denied at rule level.
- [ ] Manager attempts complete on non-pending → denied.
- [ ] Self-approval: manager-and-bishopric submits + completes own request → both audit rows show distinct `requester_canonical` and `completer_canonical` (with same value).
- [ ] Submit `remove` for member with only an auto seat → client-tx pre-check rejects with friendly error; doesn't reach Firestore.

_E2E (Playwright)_

End-to-end happy paths:
- [ ] Bishopric submits add_manual for new member → manager queue updates live → manager opens CompleteDialog → confirms → bishopric roster shows new seat → email-trigger stub invoked twice (submit + complete).
- [ ] Stake submits add_temp with two buildings ticked → manager completes → seat created with both buildings; `end_date` persists.
- [ ] Bishopric clicks X on manual seat → modal → submits remove with reason → "removal pending" badge appears live → manager completes → seat gone from roster.
- [ ] Bishopric submits add_manual → cancels from MyRequests → status flips live to cancelled.
- [ ] Manager rejects pending request with reason → MyRequests shows rejected + reason live.

Edge paths:
- [ ] Multi-role principal sees scope dropdown; submitting against a scope they don't own → server denies (rule check).
- [ ] Concurrent action: two managers both click Mark Complete; second sees 409 toast.

Coverage gate: every flow in `spec.md` §6 has an E2E.

### Acceptance criteria

- Full happy path `add_manual` end-to-end with live updates.
- Full happy path `add_temp` end-to-end with dates persisted.
- Full happy path `remove` with live "removal pending" badge.
- Reject and cancel paths end-to-end.
- Duplicate warning shows when submitting against existing seat.
- All audit rows appear within ~1s of write (Phase 8 trigger).
- Self-approval policy preserved.
- Auto-seat removal blocked at rule level.
- R-1 race for remove preserved.

### Out of scope

- Bootstrap wizard — Phase 7.
- Manager admin pages (Configuration, inline-edit, Access write actions, Import) — Phase 7.
- Real email sends — Phase 9.
- Importer / Expiry — Phase 8.

---

## Phase 7 — Manager admin pages + bootstrap wizard

**Goal:** Every manager admin surface works. Configuration page edits all the editable tables. Inline edit on All Seats. Access page write actions. Bootstrap wizard runs end-to-end. Reconcile flow for seat collisions.

**Owner:** web-engineer.

**Dependencies:** Phase 6.

### Sub-tasks

_Manager Configuration_

- [ ] `features/manager/configuration/` — Wards, Buildings, KindooManagers, WardCallingTemplate, StakeCallingTemplate, Config-key fields. One sub-page per editable table; CRUD via Firestore SDK direct writes.
- [ ] Triggers panel: list scheduled triggers + "Reinstall triggers" button (no-op on Firebase since triggers are platform-managed; show explanatory message).

_Manager Access write actions_

- [ ] Add Manual Access form — adds entry to `manual_grants[scope]` array via Firestore `arrayUnion`.
- [ ] Delete on manual rows — removes specific grant via `arrayRemove`.
- [ ] Importer rows read-only.

_Manager Import page_

- [ ] "Import Now" button → calls `runImportNow` callable (Phase 8 wires the function; Phase 7 wires the UI).
- [ ] Status display: last import time + summary.
- [ ] Over-cap banner: reads `last_over_caps_json` from stake doc.

_Inline edit on All Seats_

- [ ] Edit button on manual/temp rows only.
- [ ] Editable: `member_name`, `reason`, `building_names`, `start_date`, `end_date` (temp).
- [ ] Immutable: `scope`, `type`, `member_canonical`, `seat_id` (= doc.id), all `created_*` fields.
- [ ] Auto rows have no edit affordance.

_Reconcile flow for seat duplicate_grants_

- [ ] Badge on any seat with `duplicate_grants.length > 0`.
- [ ] Reconcile dialog: radio-button list over `[primary, ...duplicate_grants]`. Manager picks "real" grant.
- [ ] On confirm: rewrite seat doc with chosen grant as primary, empty `duplicate_grants`, recomputed `scope`. One audit row.

_Bootstrap wizard_

- [ ] `features/bootstrap/` — multi-step wizard.
- [ ] Step 1: stake fields (name, callings_sheet_id, stake_seat_cap).
- [ ] Step 2: ≥1 Building.
- [ ] Step 3: ≥1 Ward.
- [ ] Step 4: additional Kindoo Managers (optional). Bootstrap admin auto-added on first wizard load.
- [ ] Complete-Setup: flips `setup_complete=true`, calls `installScheduledJobs` callable (Phase 8 stub), audits, redirects.
- [ ] Setup-complete gate: client checks stake doc; if `setup_complete=false` and `auth.email == bootstrap_admin_email`, route to wizard ignoring `?p=`. If `setup_complete=false` and not the bootstrap admin → SetupInProgress page.
- [ ] **`features/auth/pages/setupInProgress.tsx`** — distinct from NotAuthorized.
- [ ] One-shot wizard: every wizard mutation has a rule-level check that `stake.setup_complete === false`. Once flipped, the wizard's writes are denied.

_Toast / error UX_

- [ ] Server-thrown errors (rule denials, transaction failures) surface as toasts with the error's message.
- [ ] Best-effort warnings (e.g., email-send failure piggybacked on response) surface as warn-toasts.

### Tests

_Unit_

- [ ] Form validation in NewRequestForm, CompleteDialog, Reconcile dialog, every Configuration sub-form.
- [ ] Bootstrap wizard step gating: Complete-Setup enabled iff steps 1–3 valid.

_Integration_

- [ ] Manager Configuration CRUD: every editable table — write succeeds; unauthorized writes denied.
- [ ] Inline seat edit: manual/temp updates persist; auto row → no edit possible (UI affordance absent + rule denial if hand-crafted).
- [ ] Manual access add: composite-key collision (same scope + same reason) → client-tx rejects with friendly error.
- [ ] Manual access delete: importer-source field protected; manager can't touch importer_callings.
- [ ] Reconcile: swap primary with duplicate → seat doc rewritten correctly; `scope` reflects new primary.

_E2E (Playwright)_

Bootstrap wizard:
- [ ] Fresh stake (`setup_complete=false`), bootstrap admin signs in → wizard renders.
- [ ] Walk all 4 steps → Complete → setup_complete=true → audit row written → redirect to manager default page.
- [ ] Resume mid-wizard: refresh during step 3 → wizard re-renders at step 3 (state reads from Firestore).
- [ ] Non-admin during setup → SetupInProgress (not NotAuthorized).
- [ ] Post-setup, hand-crafted wizard write → rule denial.

Reconcile:
- [ ] Seat with `duplicate_grants` shows badge → click Reconcile → dialog → pick → seat updates → badge gone.

### Acceptance criteria

- Bootstrap wizard runs end-to-end against a fresh staging `stakes/csnorth` doc.
- Manager Configuration CRUD against every editable table.
- Inline edit of seats works.
- Manual access add/delete works.
- Reconcile flow works for seat duplicate_grants.
- All Phase 6 read-side and write-side acceptance criteria still pass.

### Out of scope

- Importer + Expiry real implementations — Phase 8.
- Email real sends — Phase 9.

---

## Phase 8 — Importer + Expiry + audit triggers

**Goal:** All scheduled and event-driven Cloud Functions land. Weekly importer reads the LCR Sheet and applies diff to Firestore; daily expiry trims temp seats; audit triggers fan in audit rows for every entity write; nightly reconciliation catches gaps.

**Owner:** backend-engineer.

**Dependencies:** Phase 3 (rules + indexes) for the data model; Phase 7 (manager UI) for the "Import Now" button to invoke.

### Sub-tasks

_Importer service_

- [ ] `functions/src/services/Importer.ts` — port of `Importer.gs` logic per `spec.md` §8 with the new data model:
  - Per-tab parsing (header row in top 5 rows, `Position` / `Name` / Personal Email + RHS columns).
  - Ward-tab prefix stripping; Stake-tab verbatim.
  - Calling matching against templates including `*` wildcards.
  - **No `source_row_hash`** — doc IDs are reconstructed directly (`access/{canonical}` and `seats/{canonical}`).
  - Diff against existing access docs: `importer_callings[scope]` replaced wholesale per tab (split-ownership). `manual_grants` left alone.
  - Diff against existing seat docs: callings-list growth/shrink; primary scope determined by stake>ward priority, then alphabetical ward_code; cross-scope auto findings go to `duplicate_grants`. Promotion-on-empty-callings: if primary auto callings → empty AND a manual/temp duplicate exists, promote it. **[RESOLVED 2026-04-29]** The doc-per-person split-ownership model makes this scenario unreachable. `seats/{canonical}` has manager-driven primary (`type='manual'`/`'temp'`) iff any manual/temp grant exists for that person; an `type='auto'` primary therefore cannot have a manual/temp entry in `duplicate_grants[]`. Cross-scope auto-to-auto promotion is implicit in the diff planner's per-run rebuild of `desiredAutoSeats` (`functions/src/lib/diff.ts:202–235`), not via `duplicate_grants[]`. See `packages/shared/src/types/seat.ts` for the canonical type definition.
  - Per-row audit (via Phase 8 audit trigger; importer code doesn't write audit directly).
  - Updates `last_import_at`, `last_import_summary` on stake doc.
  - Over-cap detection in a follow-up pass; persists snapshot to `stakes.{sid}.last_over_caps_json`; emails best-effort (Phase 9).
- [ ] Sheets API integration via `googleapis` npm package using the importer Cloud Function's service account.
- [ ] Operator runbook: `infra/runbooks/granting-importer-sheet-access.md` — file → share → add `kindoo-app@<project>.iam.gserviceaccount.com` as Viewer.

_Expiry service_

- [ ] `functions/src/services/Expiry.ts` — scans `stakes/{sid}/seats` for `type=='temp' AND end_date < today (in stake.timezone)`; deletes; Phase-8 audit trigger fires `auto_expire` audit row.
- [ ] If a temp seat with `duplicate_grants` would be deleted: only the primary is cleared; if a non-temp duplicate exists, promote it.

_Cloud Functions endpoints_

- [ ] `functions/src/scheduled/runImporter.ts` — Cloud Scheduler hourly fire. Loops over all stakes whose `import_day` + `import_hour` match the current day-of-week + hour. Skips stakes with `setup_complete=false`.
- [ ] `functions/src/scheduled/runExpiry.ts` — Cloud Scheduler hourly fire. Loops over all stakes whose `expiry_hour` matches the current hour.
- [ ] `functions/src/callable/runImportNow.ts` — manager-invoked. Auth via the manager's Firebase ID token; verifies role via Admin SDK lookup against `kindooManagers/`. Calls importer for one stake.
- [ ] `functions/src/callable/installScheduledJobs.ts` — bootstrap-wizard Complete-Setup invokes; idempotent (Cloud Scheduler jobs are platform-managed).

_Audit triggers (the unified pattern)_

- [ ] `functions/src/triggers/auditTrigger.ts` — single parameterized trigger. Fires on writes to `stakes/{sid}/{collection}/{docId}` for `collection in ['seats', 'requests', 'access', 'kindooManagers']` and on the parent `stakes/{sid}` doc. Reads before/after, computes action, writes audit row with deterministic ID `{writeTime}_{collection}_{docId}` for idempotency.
- [ ] Helper `denormalizeMember`: pulls `member_canonical` from the after-state when present, falling back to before-state for delete; absent for system actions.
- [ ] Helper `pickAction(before, after, collection)`: maps state transitions to action vocabulary per `firebase-schema.md` §4.10.

_Nightly reconciliation_

- [ ] `functions/src/scheduled/reconcileAuditGaps.ts` — Cloud Scheduler nightly. For each stake, compares `auditLog` entry counts against entity-collection write counts (read from per-entity metadata or via lightweight scan); pages on >1% gap.

_Cloud Scheduler jobs_

- [ ] Single-job-loops-over-stakes pattern from day one (per F15, parameterizing for Phase 12). Two scheduler jobs total: `runImporter` hourly, `runExpiry` hourly. `reconcileAuditGaps` is a third (nightly). All three within Cloud Scheduler's free tier.

_Remove-completion handler_

- [ ] `functions/src/triggers/removeSeatOnRequestComplete.ts` — fires on `stakes/{sid}/requests/{rid}` writes. When status flips to `complete` AND `type=='remove'` AND a corresponding seat exists, deletes the seat via Admin SDK. Audit trigger fires `delete_seat` audit row from this Admin SDK write. (This is the deletion that Phase 6's transaction couldn't do cleanly because rules' `delete` operations don't have access to incoming data.)

### Tests

_Unit_

- [ ] Tab parser: header row in row 1 vs 3 vs 5; `Position` / `Name` columns located; `Personal Email` column-E validation.
- [ ] Multi-name cell split: comma-delimited with trim; overflow emails fall back to empty `member_name`.
- [ ] Ward-tab prefix stripping (`CO Bishop` → `Bishop`); Stake-tab verbatim.
- [ ] Calling-template matching: exact wins; wildcard with `*`; sheet-order priority among wildcards; no-match returns null.
- [ ] Priority math: stake outranks any ward; among wards, alphabetical ascending. Cross-scope auto findings go to duplicate_grants.
- [ ] Over-cap math: ward seat_count vs `wards.seat_cap`; stake portion-cap = `stake_seat_cap - sum(ward seats)`.
- [ ] Hourly Scheduler dispatch: stake with `expiry_hour=3` runs at hour 3 only; same for `import_day` + `import_hour`.

_Integration (Firestore emulator + Sheets API mocked)_

- [ ] Full importer cycle against fixture LCR sheet → expected access + seats + auditLog state.
- [ ] Idempotency: second run with no source changes → zero diffs (just `import_start`/`import_end` audit rows).
- [ ] Source change (one email swap) → exactly one delete + one insert per row affected.
- [ ] Removed calling from template → matching auto-seats deleted (or callings list shrunk).
- [ ] Manual access row survives import; `manual_grants` untouched.
- [ ] Per-row audits emitted with `actor_canonical='Importer'`.
- [ ] Over-cap detection: persists snapshot; emits `over_cap_warning` audit row; resolved condition clears snapshot.
- [ ] Multi-calling person: importer adds second calling → seat doc's `callings[]` grows, no duplicate doc.
- [ ] Cross-scope person (stake + ward): primary is stake (priority); ward goes to `duplicate_grants`.
- [ ] Promotion: auto callings disappear, manual duplicate exists → promoted to primary. **[RESOLVED 2026-04-29]** Scenario unreachable under the shipped schema; no test needed. See the resolution note on the promotion sub-task line above.
- [ ] Expiry: temp seat with `end_date < today` → deleted + `auto_expire` audit row.
- [ ] Expiry: temp seat with `end_date == today` → NOT deleted.
- [ ] Two consecutive expiry runs: second is no-op.
- [ ] Stake with `setup_complete=false` → skipped by both jobs.
- [ ] Concurrent run guard: hand-crafted simultaneous expiry + manual import → second invocation waits or returns "already running". **[RESOLVED 2026-04-29 — YAGNI]** Cloud Functions 2nd-gen scheduled jobs default to `max-instances=1` (single-runner per scheduled fire). The importer's idempotent design means concurrent manual `runImportNow` invocations converge to the same Firestore state. A Firestore-based mutex was deemed unnecessary for v1's 1–2 imports/week scale. Revisit if contention is observed.

Audit trigger coverage:
- [ ] Every audited collection's write produces an audit row within 1s.
- [ ] Idempotency: trigger retry produces same audit row (same deterministic ID).
- [ ] Admin SDK writes (importer) produce audit rows with `actor_canonical='Importer'`.
- [ ] Expiry writes produce `actor_canonical='ExpiryTrigger'`.
- [ ] `member_canonical` denormalized correctly across collections.

Reconciliation:
- [ ] Synthetic gap (delete one audit row, leave the entity) → reconciliation alert fires.
- [ ] No gap → quiet.

_E2E (Playwright)_

- [ ] Manager clicks "Import Now" → status updates → over-cap banner appears if applicable + clears on next clean run.
- [ ] Configuration `import_day` / `import_hour` change persists.
- [ ] Live audit log entries appear after import run.

Coverage gate: every diff plan branch has at least one fixture test.

### Acceptance criteria

- Daily expiry runs at the configured hour; deletes expired temps; audit rows present.
- Weekly import runs at configured day/hour; per-row audits, `import_start` / `import_end`, over-cap snapshot persisted.
- Manual "Import Now" works.
- Idempotent: running twice with no source changes → zero diffs.
- Service account has Sheets API view scope on LCR sheet.
- Single-stake configuration matches Apps Script behaviour 1:1 (with the documented schema-driven differences).
- Audit trigger fires for every entity write within 1s.
- Reconciliation job runs nightly; alerts on gaps.

### Out of scope

- Per-stake Scheduler jobs (single-loop pattern).
- Real email sending — Phase 9.
- Per-stake `tz` handling beyond `America/Denver` for v1.

---

## Phase 9 — Email triggers via Resend

**Goal:** All five notification types send real emails through Resend, fired by Firestore triggers on relevant entity changes.

**Owner:** backend-engineer.

**Dependencies:** Phase 6 (request lifecycle invokes notifications) + Phase 8 (importer over-cap email) + the new domain (per F17) registered and verified with Resend.

**Status:** [DONE — see [`docs/changelog/phase-9-resend-email.md`](changelog/phase-9-resend-email.md)]

### Sub-tasks

- [ ] Resend free-tier signup (100/day, 3000/month).
- [ ] Verify the new domain (per F17) in Resend's dashboard — adds a DKIM CNAME + DMARC TXT to the registrar's DNS panel. Wait 5–60 min for propagation. See `infra/runbooks/resend-domain-setup.md`.
- [ ] Resend API key in Secret Manager (`projects/<project>/secrets/resend_api_key`); Cloud Functions reads via env var injection.
- [ ] `functions/src/services/EmailService.ts` — typed wrappers for the five notification types per spec.md §9 table, using the Resend SDK:
  - `notifyManagersNewRequest(stake, request)`
  - `notifyRequesterCompleted(stake, request)`
  - `notifyRequesterRejected(stake, request)`
  - `notifyManagersCancelled(stake, request)`
  - `notifyManagersOverCap(stake, pools, source)`
- [ ] Plain-text bodies (preserve current shape).
- [ ] "From" address: `<stake.stake_name> — Stake Building Access <noreply@mail.stakebuildingaccess.org>` (display name from `stake.stake_name`; mail-subdomain verified in Resend per T-04).
- [ ] `notifications_enabled` kill-switch on stake doc — `false` skips every send and logs only.
- [ ] Firestore triggers that invoke email service:
  - [ ] `functions/src/triggers/notifyOnRequestWrite.ts` — fires on requests writes; matches lifecycle transition; calls appropriate notification.
  - [ ] `functions/src/triggers/notifyOnOverCap.ts` — fires on stake doc writes when `last_over_caps_json` goes from empty to non-empty.
- [ ] Best-effort discipline: Resend errors logged and surfaced as audit-log entries with action `email_send_failed`; don't fail the underlying entity write.
- [ ] R-1 completion email body surfaces `completion_note` per spec §9.

### Tests

_Unit_

- [ ] Body-template renderer per notification type against synthetic fixtures:
  - Subject contains stake name + member email + request type.
  - Body contains link back to `?p=mgr/queue` or `?p=my` per spec.md §9 table.
  - Type-aware lead verb: `add_manual` → "submitted a new manual-add request"; `remove` → "requested removal of"; `add_temp` → "requested temp access for".
  - R-1 completion email: body surfaces `Note:` line.
  - Over-cap email: lists each over-cap pool with counts + cap + over-by + deep link.

_Integration (Resend client mocked)_

- [ ] `notifyOnRequestWrite` invokes Resend `emails.send()` with correct payload shape on submit, complete, reject, cancel.
- [ ] `notifyOnOverCap` fires on transition; doesn't fire on continuing-overcap (last_over_caps_json change only).
- [ ] `notifications_enabled=false` → no `send()` call; one log line emitted.
- [ ] Resend 5xx → wrapper catches; audit row with `email_send_failed`.
- [ ] Resend network timeout → same.
- [ ] Per-stake "From" display.

_Manual (during phase ship; not CI-gated)_

- [ ] One real send per notification type to a verified inbox.
- [ ] DKIM passes on Gmail (no "via" disclaimer).
- [ ] Send to known-bad address → Resend logs the bounce; our code logs warning; no crash.

### Acceptance criteria

- Each of five notification types delivers to a real Gmail inbox in testing.
- DKIM passes.
- Resend failure doesn't fail underlying write.
- Kill switch works.
- Subject lines and body shapes match the existing five email templates.

### Out of scope

- HTML templates — plain text for v1.
- Bounce handling, suppression lists, click tracking.
- Test-send admin button.
- Push notifications — Phase 10.5 (deferred).

---

## Phase 10 — PWA shell + branding

**Goal:** App is installable as a PWA on mobile + desktop; service worker caches static assets and shell; users see "Update available" prompts when a new version deploys. Favicon + brand-bar icon land alongside the install-time branding.

**Owner:** web-engineer.

**Dependencies:** Phase 4 (web SPA shell).

### Sub-tasks

_PWA shell_

- [ ] `vite-plugin-pwa` configured in `apps/web/vite.config.ts`. Workbox strategy: cache-first for static assets; network-first for `/index.html`; never cache Firestore traffic.
- [ ] Web manifest: name, short_name, theme_color, icons (192px + 512px + maskable). Generated at `apps/web/public/manifest.webmanifest`.
- [ ] Apple touch icon for iOS install.
- [ ] Install-prompt UX: small "Install Stake Building Access" affordance in topbar when `beforeinstallprompt` event fires.
- [ ] Update prompt: when SW detects a new version, toast "Update available — refresh to update."
- [ ] Offline shell: app shell loads from cache when offline; data layer surfaces "Offline" toast.

_Branding_

- [ ] Migrate existing favicon assets from `website/images/` (`favicon.ico`, `favicon.svg`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`) to `apps/web/public/`. Wire `<link rel="icon">` and Apple touch icon in `apps/web/index.html`.
- [ ] If the existing assets visually mismatch the new "Stake Building Access" brand (F17), flag for operator review before proceeding — do not ship wrong-brand icons.
- [ ] Brand-bar icon: add the icon next to the wordmark in the topbar (small variant, same source as the favicon).

### Tests

_Unit_

- [ ] Install-prompt UX shown only when `beforeinstallprompt` fired.

_E2E (Playwright + service worker support)_

- [ ] PWA install prompt appears on first sign-in.
- [ ] Service worker registers; cached assets load offline.
- [ ] Update flow: deploy new version → SW detects → toast prompts user.

_Manual_

- [ ] iOS install (Safari → Add to Home Screen) — verify icon + standalone mode.
- [ ] Android install (Chrome) — verify install banner.
- [ ] Favicon renders correctly in Chrome / Safari / Firefox tabs.
- [ ] Brand-bar icon renders correctly at the topbar's intended size.

### Acceptance criteria

- App installable on iOS, Android, desktop (Chrome/Edge).
- Service worker caches shell; offline mode surfaces gracefully.
- Update prompt surfaces when a new version deploys.
- Favicon + brand-bar icon ship.

### Out of scope

- All FCM push notifications — Phase 10.5.
- New icon / brand redesign — separate task if needed.
- Navigation redesign (left-rail + sectioned nav) — Phase 10.1.

---

## Phase 10.1 — Navigation redesign (left rail + sectioned nav)

**Goal:** Replace the Phase-4-vintage top-tab nav with a directory-browser-style left rail that adapts across phone / tablet / desktop breakpoints, sectioned navigation with conditional headers, role-aware items, and Lucide icons. Specification in [`docs/navigation-redesign.md`](navigation-redesign.md).

**Owner:** web-engineer.

**Dependencies:** Phase 4 (web SPA shell — establishes the layout shell + role-aware Nav this redesign replaces), Phase 7 (manager admin pages — establishes the full nav-item set the redesign must accommodate).

**Status:** Design complete. Implementation deferred until operator schedules.

### Sub-tasks

(Deferred. See [`docs/navigation-redesign.md`](navigation-redesign.md) §1–§16 for the full design surface; sub-tasks will be enumerated when this phase is started.)

---

## Phase 10.2 — Fix dialogs and UX issues

**Goal:** UX polish across manager pages and the New Request flow. Modal dialogs replace inline forms (App Access, Configuration tabs); layout normalised to left-aligned with per-page max-widths; behaviour fixes (last-manager guard, audit infinite scroll, ward-scope auto-building, scope-dropdown audit); Configuration tab rename + reorder + Triggers tab removal; pill colours matched to the Apps Script roster.

**Owner:** web-engineer.

**Dependencies:** Phase 7 (manager admin pages — establishes the surface this phase polishes), Phase 8 (audit log — feeds the infinite-scroll fix).

**Status:** [DONE — see [`docs/changelog/phase-10.2-fix-dialogs.md`](changelog/phase-10.2-fix-dialogs.md)]

### Sub-tasks

17 items grouped in 5 implementation batches (tab cleanup + AllSeats summary removal; layout polish + roster pill colours + sheet hyperlink; modal dialogs replacing inline forms; Access page table-vs-card responsive view; audit infinite scroll + ward-scope auto-building). See the changelog for the full surface.

---

## Phase 10.3 — UI polish (urgent flag, queue sections, sort, contextual utilization)

**Goal:** Six UX polish items across request and roster surfaces. Adds an `urgent: boolean` field on requests with a red top-bar visual marker on pending cards; restructures the manager Queue into Urgent / Outstanding / Future sections by computed `comparison_date` (start_date for `add_temp`; submitted_at otherwise) with a today+7 cutoff at user-local midnight; relocates the My Requests Cancel button onto the pill row; renames "Notifications enabled" to "Email Notifications Enabled"; adds a contextual `<UtilizationBar>` above the All Seats table that follows the current scope filter; introduces a denormalized `sort_order` on seats and access docs (sourced from calling-template `sheet_order` via the importer's `TemplateIndex`) so rosters and All Seats sort by calling priority within each scope.

**Owner:** web-engineer (web + shared schema); backend-engineer (`firestore.rules` tightening + importer denormalization).

**Dependencies:** Phase 6 (request lifecycle — the `urgent` field and queue sectioning extend the pending-request surface), Phase 8 (importer — populates new `sort_order` on seats and access docs).

**Status:** [DONE — see [`docs/changelog/phase-10.3-ui-polish.md`](changelog/phase-10.3-ui-polish.md)]

### Sub-tasks

Six items shipped over seven commits (one shared-schema prep, four feature batches, one backend lane, one E2E follow-up). See the changelog for the full surface and operator-decided deviations from the pre-phase brief.

---

## Phase 10.4 — Auto Kindoo Access overhaul

**Goal:** Decouple "auto-seat creation" from "matched-a-template" by introducing a new `auto_kindoo_access: boolean` field on calling-template docs alongside the existing `give_app_access`. The Auto Ward Callings + Auto Stake Callings tabs are rebuilt as table views with three columns (Calling Name, Auto Kindoo Access, Can Request Access) and drag-to-reorder (mouse) / tap-and-hold + arrows (touch). The `give_app_access` field is renamed in the UI to "Can Request Access" (Firestore field name unchanged).

**Owner:** web-engineer (web + shared schema + UI + drag-and-drop + post-deploy runbook); backend-engineer (importer gate change).

**Dependencies:** Phase 8 (importer — adds the new gate condition), Phase 10.3 (sort_order denorm — new filter must preserve the MIN-across-callings invariant).

**Status:** [DONE — see [`docs/changelog/phase-10.4-auto-kindoo-access.md`](changelog/phase-10.4-auto-kindoo-access.md)]

**Destructive-on-first-import warning:** the importer's seat-creation gate moves from "calling matches a template" to "calling matches a template AND `auto_kindoo_access === true`." Existing templates have no field → treated as false → all auto seats whose calling no longer flags `auto_kindoo_access=true` are deleted on the first import after deploy. Operator runs [`docs/runbooks/post-10.4-deploy.md`](runbooks/post-10.4-deploy.md) before triggering.

### Sub-tasks

Four sub-changes (A schema, B importer, C UI, D drag-and-drop) shipped on one branch. See the changelog for the full surface and the operator runbook for pre-import setup.

---

## Phase 10.5 — Push notifications via FCM Web (deferred)

**Goal:** Managers receive a push notification when a new request is submitted, paralleling the email. Per-user opt-in respected. Email remains the source-of-truth channel.

**Owner:** web-engineer (PWA shell + push UI); backend-engineer (FCM registration triggers + push send Cloud Functions).

**Dependencies:** Phase 9 (email patterns extended to push), Phase 10 (PWA shell registers the service worker that handles background push).

**Status:** [DONE — see [`docs/changelog/phase-10.5-fcm-push.md`](changelog/phase-10.5-fcm-push.md)]

### Sub-tasks

_FCM Web push_

- [ ] Generate VAPID key pair in Firebase project; private key in Secret Manager.
- [ ] `apps/web/src/features/notifications/` — settings page subsection:
  - Permission request button.
  - Subscribe / unsubscribe to push.
  - Per-category toggles (e.g., "New requests" for managers).
- [ ] On subscribe: client gets FCM token; writes `userIndex/{canonical}.fcmTokens[deviceId] = token`.
- [ ] On unsubscribe: removes from array.
- [ ] Service worker `apps/web/public/firebase-messaging-sw.js` handles background push notifications.

_Cloud Function push send_

- [ ] `functions/src/triggers/pushOnRequestSubmit.ts` — fires on `requests/{rid}` create with `status='pending'`; reads all active managers' `userIndex` entries; sends push to each registered FCM token.
- [ ] Falls back to email if push fails or no tokens registered (preserves email-as-source-of-truth notification).
- [ ] Invalid tokens (expired, unsubscribed) cleaned up from `userIndex.fcmTokens` automatically on send-failure.

_Per-user notification preferences_

- [ ] `userIndex/{canonical}.notificationPrefs.push.newRequest = true|false` (default true if registered).
- [ ] Future: per-category toggles. Phase 10.5 only ships "new request" push.

### Tests

_Unit_

- [ ] FCM token write helper appends deterministically (no duplicate tokens for same device).

_Integration (FCM mock)_

- [ ] `pushOnRequestSubmit` reads correct manager set; sends to all registered tokens.
- [ ] Invalid token returns from FCM → token removed from userIndex.
- [ ] No tokens registered → push silently skipped (email path covers).

_Manual_

- [ ] Real push to a registered device.

### Acceptance criteria

- Push notifications work for at least one notification type (new request).
- Per-user push opt-in respected.
- Email continues to work as the source-of-truth channel.

### Out of scope

- Push for completion / rejection / cancellation / over-cap — separate follow-up if measured need.
- iOS push (requires PWA installed; Safari support is recent).
- Notification grouping / silencing windows.

---

## Phase 10.6 — Push notifications expansion (completion / rejection / cancel / over-cap)

**Goal:** Extend FCM Web push beyond Phase 10.5's "new request → managers" path. Push parallel of all five Phase 9 email notifications now ships — completion + rejection notify the requester (bishopric/stake users), cancellation + over-cap notify managers. The Notifications page expands access to non-managers so requesters can subscribe to their own request-lifecycle notifications.

**Owner:** web-engineer (panel + schema additions + role expansion); backend-engineer (push triggers fanning the same lifecycle transitions Phase 9's `notifyOnRequestWrite` already handles).

**Dependencies:** Phase 9 (email triggers — push fan parallel to email triggers), Phase 10.5 (PWA shell + FCM SW + token-registration plumbing already in place).

**Status:** Deferred. Operator flags when push is needed beyond new-request.

### Sub-tasks

_Schema_

- [ ] `userIndex.notificationPrefs.push` extended with new keys: `completed`, `rejected`, `cancelled`, `overCap` (in addition to existing `newRequest`). Each defaults to `true` on subscribe (matching Phase 10.5 convention). Per-role visibility on toggles — `cancelled` and `overCap` only render for managers; `completed` and `rejected` only render for requesters.
- [ ] zod schema in `packages/shared/src/schemas/userIndex.ts` mirrors.

_UI_

- [ ] `/notifications` route's role gate widens to allow any authorized user (not just managers). Bishopric and stake users can subscribe to push for their own request lifecycle notifications.
- [ ] `<PushNotificationsPanel />` renders per-category toggles based on user's role: managers see `newRequest`, `cancelled`, `overCap`; bishopric/stake users see `completed`, `rejected`. Mixed-role users see both.

_Backend triggers_

- [ ] Either extend `pushOnRequestSubmit` to a full `pushOnRequestWrite` (mirror of Phase 9's `notifyOnRequestWrite`), OR add three sibling triggers (`pushOnRequestComplete`, `pushOnRequestReject`, `pushOnRequestCancel`). Plus a new `pushOnOverCap` trigger paralleling `notifyOnOverCap`. Recommendation: consolidate `pushOnRequestSubmit` → `pushOnRequestWrite` for parity with Phase 9's structure; smaller surface to maintain.
- [ ] Each trigger reads target recipients (manager-list or requester) and fans push via the same `pushOnRequestSubmit` machinery (FCM token cleanup, `notificationPrefs.push.<category>` filter).

_Tests_

- [ ] Unit tests for each new lifecycle path (4 cases × push fanout).
- [ ] Integration tests fan-mocked.
- [ ] Manual real-device verification on iPhone PWA + desktop Chrome.

### Acceptance criteria

- All five Phase 9 email notification types have a parallel push notification.
- Bishopric and stake users can subscribe via the Notifications page.
- Per-category toggle works (e.g., a manager can mute `overCap` push without affecting other categories).
- Push remains additive to email; either channel can be silenced independently.

### Out of scope

- Multi-device notification preferences synchronization across user's devices (Phase 12 candidate).
- Notification grouping or quiet-hours logic.

---

## Phase 11 — Data migration + cutover

**Goal:** Live data moves from the Sheet to Firestore; DNS flips `kindoo.csnorth.org` to Firebase Hosting; the Apps Script app is decommissioned. End of Phase A.

**Owner:** All agents on deck. infra-engineer leads the cutover; backend-engineer owns the migration script; web-engineer validates the deployed app; docs-keeper updates spec/architecture in lockstep.

**Dependencies:** Phases 1–10. (Phase 10.5 and 10.6 are deferred; Phase 11 cutover is not gated on them.)

### Sub-tasks

_Migration script_

- [ ] `infra/scripts/migrate-sheet-to-firestore.ts`:
  - Reads each Sheet tab via Sheets API using a migration service account.
  - Writes to corresponding Firestore collection under `stakes/csnorth/`.
  - Idempotent: deterministic doc IDs (canonical email, slug); `tx.set` (overwrite) rather than `tx.create`.
  - **Schema-driven transformations** (the new bits vs. the prior plan):
    - Collapses today's per-(scope, calling, email) seat rows into one seat doc per (canonical_email) per stake. Multi-calling people get `callings: [...]`. Cross-scope people: pick stake>ward priority for primary, rest into `duplicate_grants`.
    - Splits today's Access `source` column into `importer_callings` map and `manual_grants` array on per-canonical-email doc.
    - Drops `source_row_hash`.
    - Slugifies building names; rewrites cross-references.
    - Preserves audit log history into the new flat `auditLog` collection.
  - Verifies: post-write per-collection counts match Sheet row counts; logs discrepancies.
- [ ] `--dry-run` flag.
- [ ] Spot-check helper `infra/scripts/diff-sheet-vs-firestore.ts`.

_Pre-cutover (rehearsal in staging)_

- [ ] Snapshot production Sheet → "staging-source" sheet.
- [ ] Run migration against `kindoo-staging` + staging-source.
- [ ] Walk staging end-to-end as each role; compare to production Apps Script side-by-side.
- [ ] Compare audit log: sample 20 rows; verify `before` / `after` JSON equivalent.
- [ ] Performance baseline: Dashboard p50, AllSeats p50, Audit Log first-page p50, Roster live-update latency.
- [ ] Run full importer cycle against staging-source LCR sheet; verify audits + over-cap detection match production.
- [ ] Run expiry cycle against seeded soon-to-expire temp seat.
- [ ] Send one test email per notification type.
- [ ] PWA install verification on real iOS + Android devices.

_Cutover (production maintenance window)_

- [ ] Banner on Apps Script app 24h pre-cutover: "Going read-only at HH:MM Saturday for migration; back at HH:MM."
- [ ] Communicate window to managers + bishopric leads.
- [ ] At go-time: revoke write access on the Sheet (Sheet → Share → set to Viewer) AND set Apps Script web app to disabled.
- [ ] Run migration script against `kindoo-prod` + live Sheet.
- [ ] Verify counts match.
- [ ] Smoke test as each role on `kindoo-prod.web.app` (default Hosting URL — DNS hasn't flipped yet).

_DNS for the new domain_

- [ ] Per F17, the user-chosen new domain points to Firebase Hosting (custom domain configured in Firebase Hosting console; auto-provisioned Let's Encrypt cert). Procedure: `infra/runbooks/custom-domain.md` Section 2 (apex → `kindoo-prod`).
- [ ] HTTPS verified end-to-end on the new domain.
- [ ] Smoke test on the new domain's URL as each role; sign-in works; PWA install still works.
- [ ] Re-enable write access on the legacy LCR Sheet (no longer source of truth; stays human-readable as archive).

_Legacy `kindoo.csnorth.org` decommission_

- [ ] Decision: redirect to the new domain, leave dormant pointing to a "moved" page on GitHub Pages, or take down entirely. Document the chosen path in `infra/runbooks/cutover.md` before the window opens (not yet written; will capture the legacy-domain decommission decision and the full cutover sequence — separate from `custom-domain.md`, which only covers the Firebase Hosting apex-pointing).
- [ ] If redirect chosen: update `website/index.html` to a meta-refresh + JS redirect to the new domain; keep GitHub Pages alive at the old path.
- [ ] Communicate the URL change to managers / bishopric / stake leads in the cutover communication (E3).

_Post-cutover monitoring_

- [ ] 24–48h active monitoring: Cloud Functions logs, Firestore rules-denied count, error rates, push-notification delivery rate.
- [ ] Apps Script app stays deployed but disabled for one week as rollback.
- [ ] After one week with no critical issues: delete Apps Script triggers, fully archive deployment, revoke migration service account's Sheet access.

_Repo cleanup_

- [ ] Delete `src/` (Apps Script Main).
- [ ] Delete `identity-project/`.
- [ ] Delete `.clasp.json`, clasp scripts, package.json clasp deps.
- [ ] Update root `CLAUDE.md`: remove Apps Script-specific guidance ("Flat namespace", "Auth is GSI + JWT", "Two identities"); add Firebase-specific.
- [ ] Update `pnpm-workspace.yaml` if needed.

_Doc updates_

- [ ] `docs/spec.md` — auth section rewritten (Firebase Auth + custom claims); stack section rewritten; concurrency section rewritten (Firestore transactions).
- [ ] `docs/architecture.md` — D2, D6, D7, D10 superseded; new Firebase decisions documented.
- [ ] `docs/data-model.md` — rewritten for Firestore schema; redirects to `firebase-schema.md` as the primary reference.
- [ ] `docs/build-plan.md` Chunk 11 marked `[SUPERSEDED — Firebase Hosting handles custom domain natively, see firebase-migration.md Phase 11]`.
- [ ] `docs/changelog/firebase-cutover.md` summarizes Phases 1–11.
- [ ] Identity project README archived under `docs/archive/identity-project-readme.md`.

### Tests

Migration script correctness is the highest-stakes test surface. Heavy unit + integration coverage; smoke + cutover steps below are manual but enumerated for the runbook.

_Unit_

- [ ] Per-tab transformation function (Sheet row → Firestore doc shape):
  - Date cells parsed correctly (Firestore `Timestamp`).
  - Empty cells map to empty strings, not `undefined`.
  - **Seat row collapse**: multiple seat rows with same canonical email + scope → one seat doc with merged callings list.
  - **Cross-scope detection**: stake-scope row + ward-scope row for same email → primary = stake, duplicate = ward.
  - **Access split**: rows with `source='importer'` → `importer_callings` map; rows with `source='manual'` → `manual_grants` array; preserves grant_id (uuid generated if missing on legacy rows).
  - Audit-log rows preserve `before`/`after` as nested objects (parsed from any JSON-string form on legacy rows).
- [ ] Building name → slug transform stable; cross-references rewritten consistently.

_Integration (Firestore emulator + Sheets fixture)_

- [ ] Migrate fixture Sheet → Firestore matches expected state byte-for-byte (excluding auto-generated timestamps).
- [ ] Idempotency: second run identical state.
- [ ] Re-run on partial failure: kill mid-run, restart; complete state matches one-shot run.
- [ ] Counts per collection match Sheet row counts (after collapse for seats).
- [ ] Diff helper: synthetic mismatch flagged; identical state → no flags.
- [ ] Importer's first post-cutover run produces zero diffs against migrated state (proves migration shape matches importer's output shape).

_Smoke (manual, during cutover rehearsal in staging)_

- [ ] Run migration against `kindoo-staging` (snapshot of production Sheet) → walk full app as each role.
- [ ] Audit log: 20 random rows match between Apps Script and Firebase end-to-end.
- [ ] Send one of each email type from staging.
- [ ] Run full importer cycle against staging-source LCR sheet → diff vs production Apps Script's last import → zero unexpected changes.

_Cutover (manual, during the window)_

- [ ] Pre-cutover: Sheet read-only confirmed; Apps Script web app archived.
- [ ] Migration script run against `kindoo-prod`; counts verified.
- [ ] Smoke as each role on `kindoo-prod.web.app`.
- [ ] DNS flip; HTTPS verified; smoke on `kindoo.csnorth.org`.
- [ ] PWA install verified on at least one iOS + one Android device.
- [ ] 24h monitoring: error rate < threshold; no rules-denied spikes.

Coverage gate: integration tests pass against production-snapshot fixture before the cutover window opens.

### Acceptance criteria

- Migration script reproduces Firestore state from Sheet input deterministically.
- Spot-check: 20 random rows match between Sheet and Firestore in each collection.
- Schema collapse verified: today's multi-row seat data correctly merged into one doc per (stake, member).
- Source-split verified: today's Access `source` column correctly split into `importer_callings` / `manual_grants`.
- All roles can sign in and walk a smoke test against production Firestore.
- DNS flip succeeds; users land on Firebase Hosting via `kindoo.csnorth.org`.
- PWA installs on real devices.
- One week of post-cutover monitoring with no rollback.
- Apps Script and Identity projects decommissioned.
- `src/` and `identity-project/` removed from repo; git history preserves them.

### Rollback plan (documented before go-time)

- Within 24h of cutover: DNS flip back to GitHub Pages → Apps Script. Re-enable Apps Script web app deployment. Re-enable triggers. Sheet is still source of truth (we never moved it). No data restore needed.
- After 24h but within 7 days: same DNS flip, but any Firestore-side writes that happened post-cutover need manual reconciliation back into the Sheet. Acceptable but uncomfortable.
- After 7 days: Apps Script triggers deleted; full rollback would require redeploying. Don't roll back; fix forward.

### Out of scope

- Multi-stake — Phase 12.
- Performance tuning beyond what was needed for Phases 6/7 to ship.
- Cost optimization beyond the $1 budget alert.

---

## Phase 12 — Multi-stake (Phase B, deferred)

**Goal:** A second stake can be onboarded end-to-end via a platform-superadmin surface. The platform superadmin has a tiny provisioning role (no read access to any stake's operational data, per the locked-in design).

**Owner:** All agents.

**Dependencies:** Phase 11. **Not started until at least one second stake is in scope.**

### Sub-tasks

Materially identical to the prior plan's Phases 11 + 12 (combined into one phase here since the data model already carries `{stakeId}` from day one per F15):

- [ ] URL convention: `kindoo.csnorth.org/{stakeId}/?p=<page>&...`. The stakeId becomes the first path segment in the SPA.
- [ ] Single-stake users redirect from bare `/?p=...` URLs to `/{theirStake}/?p=...` for backward compat.
- [ ] Multi-stake users see a stake picker page or a stake switcher in the topbar.
- [ ] `platformSuperadmins/{canonicalEmail}` populated. Edited via Firestore console (chicken-and-egg).
- [ ] `features/platform/` — list stakes, create stake form. `POST /api/platform/createStake` callable.
- [ ] Bootstrap wizard re-verified for fresh stakes.
- [ ] Operator runbooks: `infra/runbooks/onboard-stake.md`, `infra/runbooks/lost-bootstrap-admin.md`.
- [ ] Onboarding integration test: full second-stake setup from cold start in <30 minutes.

### Tests

Same shape as the prior plan's Phase 11 + 12 test sections, adapted for direct Firestore + custom claims. See git history for prior detail; reproduce when phase is live.

### Acceptance criteria

- Superadmin can create new stake from `/platform`.
- Bootstrap admin can sign in and run wizard for the new stake.
- Two stakes' data fully isolated (verified by emulator rules tests).
- Stake picker + switcher in topbar work.
- Superadmin without explicit stake membership cannot read stake data.
- Onboarding takes <30 minutes end-to-end.

### Out of scope

- Self-serve stake creation (superadmin-curated only).
- Per-stake billing / quotas.
- Multi-stake reporting dashboards.
- Per-stake "From" address.
- Per-stake custom domain.

---

## Open questions

The full list of open questions, sorted by weight, lives in `docs/firebase-schema.md` §8. The summary:

- **Q1 (meta):** Whether to migrate at all — Apps Script keeps running until this is settled.
- **Q2–Q4 (behavioural changes from current spec):** Duplicate manual/temp seats blocked vs warned; multi-calling auto seats collapsed; stake-priority makes stake-presidency members invisible on ward rosters.
- **Q5–Q10 (design pieces sketched, not finished):** Reconcile UX, audit-log diff rendering with nested maps, `getAfter()` viability spike, custom-claims size budget, bootstrap admin first-sign-in sequencing, self-lockout protection.
- **Q11–Q15 (operational):** Migration script, test strategy, phase-plan structure (this doc resolves it), reconciliation alerting, userIndex collision handling.
- **Q16–Q22 (minor):** Slugging strategy, "From" address, claim field name, request doc ID format, platformAuditLog TTL, reconcile cadence, ward-vs-ward priority.

Resolve any subset before starting any given phase; defer the rest. The Q1 meta-question gates everything.
