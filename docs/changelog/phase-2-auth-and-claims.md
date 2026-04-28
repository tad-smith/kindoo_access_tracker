# Phase 2 — Firebase Auth + custom claims + sync triggers

**Shipped:** 2026-04-28
**Commits:** _(see git log; commit message references Phase 2)_

## What shipped

Sign-in works end-to-end on `kindoo-staging`. All seven Phase-2 proofs pass:

1. Visiting the SPA while signed-out renders `SignInPage`.
2. `signInWithPopup` against Google issues a real Firebase ID token; `getIdToken(true)` is forced after the popup resolves so the next-cycle claims are picked up before the first authenticated read.
3. Firestore Rules verify the token (proven indirectly: authed reads from the deployed app succeed for the seed role).
4. The `onAuthUserCreate` Cloud Function trigger writes `userIndex/{canonicalEmail}` on first sign-in.
5. `syncManagersClaims`, `syncAccessClaims`, and `syncSuperadminClaims` triggers update custom claims when role docs change; `revokeRefreshTokens` forces token refresh.
6. After sign-out / sign-in, the Hello page renders the decoded `Principal` showing `managerStakes: [<stakeId>]`.
7. Failure modes: signed-out → SignIn; signed-in-no-claims → NotAuthorized; signed-in-with-claims → Hello.

Concretely landed:

- **`packages/shared/`** — `CustomClaims`, `StakeClaims`, `Principal`, `UserIndexEntry` types; `principalFromClaims(claims, typedEmail)` derivation helper with 12 vitest unit cases (no-roles → unauthenticated; manager only; stake only; multi-ward bishopric; multi-stake; superadmin; malformed shapes).
- **`functions/src/triggers/`** — four Cloud Functions: `onAuthUserCreate` (v1 auth trigger) plus `syncAccessClaims`, `syncManagersClaims`, `syncSuperadminClaims` (all v2 Firestore document-write triggers).
- **`functions/src/lib/`** — Admin SDK init, canonical-email re-export, `STAKE_IDS` constant, `uidForCanonical` helper, `seedClaimsFromRoleData`, `computeStakeClaims`, idempotent `applyClaims` (skips refresh-token revoke when claims didn't change).
- **`functions/tests/`** — 21 emulator-gated integration tests covering all four triggers plus the userIndex collision case; all skip cleanly with `describe.skipIf(!hasEmulators())` when emulators aren't running.
- **`firestore/firestore.rules`** — added `userIndex/{memberCanonical}` match block (read by the user themselves only via `request.auth.uid == resource.data.uid`; write server-only). All other collections still locked-everything; Phase 3 owns the full rules rewrite.
- **`firestore/tests/userIndex.test.ts`** — 5 rules-unit-testing scenarios.
- **`apps/web/src/`** — Auth wiring in `lib/firebase.ts` (with emulator detection); `features/auth/` (sign-in forcing post-popup token refresh; sign-out; `useTokenRefresh` listener; `SignInPage`; `NotAuthorizedPage`); `lib/principal.ts` + `lib/principal-derive.ts` consuming `@kindoo/shared`'s `principalFromClaims`; rewritten `pages/Hello.tsx` showing email + decoded principal; three-arm auth-gated `router.tsx`; `components/Topbar.tsx` (persistent shell).
- **`e2e/`** — REST-based emulator fixtures (`fixtures/emulator.ts`); four Playwright specs covering all four arms of the Phase-2 auth state machine.
- **Deploy pipeline** — `functions/scripts/build.mjs` (esbuild bundle + clean `lib/package.json` + node_modules symlink), updated `functions/package.json` (esbuild as devDep, `@kindoo/shared` moved to devDeps), updated `firebase.json` (functions source → `functions/lib`, predeploy hook).

`infra-engineer` is updating `infra/runbooks/provision-firebase-projects.md` in parallel to document the Hosting console "Get Started" gap surfaced by the first staging deploy. That runbook update lives outside this Phase-2 close commit.

## Deviations from the pre-phase spec

Phase 2's "spec" is the Phase 2 section of `docs/firebase-migration.md` plus `docs/firebase-schema.md` §2 / §3.1.

- **`onAuthUserCreate` uses `firebase-functions/v1/auth.user().onCreate`, not v2.** The Phase 2 sub-task list says "all triggers use 2nd gen." But `firebase-functions/v2/identity` only exposes BLOCKING auth triggers (`beforeUserCreated` / `beforeUserSignedIn`); there is no v2 post-create non-blocking trigger as of `firebase-functions@6.x`. v1 auth triggers remain supported and don't carry the gen-1 region/scaling baggage that the rest of the architecture is avoiding (this trigger fires at most ~1/user/lifetime). Documented in the trigger's header comment.
- **`@kindoo/shared` does not depend on `firebase`.** The Phase 2 task spec implied a `Timestamp` import from `firebase/firestore` in `UserIndexEntry`. The shared workspace's `CLAUDE.md` forbids runtime deps beyond `zod`, and adding `firebase` would also require an install. Solution: declare a structural `TimestampLike` interface that both `firebase/firestore`'s `Timestamp` and `firebase-admin/firestore`'s `Timestamp` satisfy. Consumers narrow-cast on the SDK side.
- **Cloud Functions deploy uses esbuild bundling, not direct TypeScript compilation.** Cloud Build runs `npm install` on the deployed source's `package.json`, and pnpm's `workspace:*` protocol is not understood by npm — `@kindoo/shared` as a workspace dep blocks deploy. The fix: esbuild bundles `@kindoo/shared`'s source into `functions/lib/index.js`; a build-time script writes a clean `functions/lib/package.json` containing only real npm deps (`firebase-admin`, `firebase-functions`); `firebase.json`'s `functions.source` points at `functions/lib`. Cloud Build sees only the clean `lib/package.json`. This is architecturally significant enough that it deserves its own architecture D-number eventually; captured as a follow-up TASK so it doesn't get lost.
- **`functions/lib/node_modules` is a symlink to `../node_modules`.** Same root cause: the local Functions emulator (`firebase emulators:start --only functions` against `functions/lib` source) needs to resolve `firebase-admin` / `firebase-functions` at module-resolution time, but the clean `lib/package.json` doesn't have an actual `node_modules`. Symlinking back to the workspace's `functions/node_modules` (which pnpm populates) lets local module resolution succeed; `firebase.json`'s `ignore: ["node_modules"]` excludes the symlink from deploy upload. Trade-off: `lib/` is no longer a fully-self-contained directory; it's only self-contained as far as Cloud Build is concerned.
- **`vitest.config.ts` in `functions/` sets `fileParallelism: false` + `singleThread: true`.** Required because the Auth + Firestore emulators are shared singletons across test files; parallel workers' `clearEmulators()` calls were racing each other and wiping each other's just-created users mid-test.
- **`tsconfig.tests.json` split** in `functions/` rather than a single config including `tests/`. The existing build config (`composite: true` + `outDir: ./lib` + `rootDir: ./src`) refuses files outside `rootDir`; the split keeps emit and typecheck both clean.
- **`apps/web/src/lib/principal.ts` is split into `principal.ts` (hook) + `principal-derive.ts` (pure derivation).** The unit test imports the pure derivation; if it pulled `principal.ts` (which imports `firebase.ts`) into the test module graph, vitest's Node platform path would fail at `getAuth()` against a fake API key. The split keeps tests clean; `principal.ts` re-exports the public API so consumers see one surface. Captured as a follow-up TASK to consolidate web-side derivation onto `@kindoo/shared`'s `principalFromClaims` so the SPA and the trigger code share one source.
- **e2e fixtures use Auth + Firestore emulator REST APIs**, not the Admin SDK or `@firebase/rules-unit-testing`. Avoids new top-level packages; emulator REST endpoints are documented and stable.
- **e2e sign-in uses an emulator-only `window.__KINDOO_TEST__.signInWithEmailAndPassword` test hatch**, not `signInWithCustomToken`. The hatch mirrors the production `signInWithPopup` flow (force `getIdToken(true)` after success), keeping specs synchronous against the SPA's actual `auth` instance. Hatch is gated by `VITE_USE_AUTH_EMULATOR` and is absent from production builds.

## Decisions made during the phase

- **`STAKE_IDS = ['csnorth']` constant in `functions/src/lib/constants.ts`** drives the first-sign-in claim-seeding path: `seedClaimsFromRoleData` walks this list when a brand-new user has no pre-existing claims to recompute. The `syncAccessClaims` and `syncManagersClaims` triggers extract `stakeId` from the doc path directly, so they are stake-ID-agnostic. Implication for operators: if the v1 stake's actual ID isn't `csnorth`, new users won't get claims seeded on first sign-in until an operator manually edits a manager doc to fire the trigger. Phase 12 (multi-stake) makes this dynamic; captured as a TASKS entry.
- **Three operational gaps surfaced on the first staging deploy:** (1) `gcloud services enable firebasehosting.googleapis.com` enables the API but does not provision a default Hosting site for serving — the operator must click "Get Started" in the Firebase Hosting console once after first deploy; (2) Cloud Build's `npm install` doesn't understand pnpm's `workspace:*` protocol, requiring the esbuild-bundle workaround above; (3) failed first-deploy attempts can leave functions in a half-registered state where Cloud Functions sees them as HTTPS functions even though the source declares them as Firestore-document triggers — recovery requires `firebase functions:delete <name>` before retry. Each is captured as a TASKS entry.
- **Skipped: the `version.ts` ↔ `stamp-version.js` shape reconcile (T-01).** Out of scope for Phase 2; deploy worked because the `version.ts` files have stable hand-maintained content (`KINDOO_FUNCTIONS_VERSION = '0.0.0-dev'`) and `stamp-version.js` was never invoked during this deploy. Defer to before Phase 11 cutover.

## Spec / doc edits in this phase

Phase 2 deliberately does not edit `docs/spec.md`, `docs/architecture.md`, or `docs/data-model.md`. Phase 2 is bootstrap-of-auth, not a behavioural change to the live Apps Script app, and the architecture was locked in pre-Phase-1 (F1–F17) with no new D-numbers earned this phase. Phase 11 cutover is when those three docs change to describe Firebase reality.

- `docs/firebase-migration.md` — F-row table unchanged (Phase 2 doesn't add new locked-in decisions).
- `docs/firebase-schema.md` — unchanged.
- `docs/changelog/phase-2-auth-and-claims.md` — this entry.
- `docs/TASKS.md` — appended Phase 2 follow-ups (T-09 through T-14).
- `infra/runbooks/provision-firebase-projects.md` — being updated in parallel by `infra-engineer` to add the Hosting console "Get Started" step. Out of scope for this commit.

## Deferred

Items intentionally not in Phase 2, with where they land.

- **B2 — domain registration + Resend domain verification** for `stakebuildingaccess.org`. Doesn't block Phase 2; needed before Phase 9 ships email triggers. → T-04.
- **B4 — LCR Sheet sharing protocol** for the importer service account. Doesn't block Phase 2; needed before Phase 8 importer runs in earnest. → T-05.
- **Phase 9** — real email send via Resend. Phase 2 has no email path.
- **`STAKE_IDS` hardening.** Currently hardcoded to `['csnorth']`; Phase 12 (multi-stake) makes this dynamic. → T-13.
- **Hosting predeploy hook.** `firebase.json` has no `hosting.predeploy` to rebuild `apps/web/dist` automatically. Operator must remember to run `pnpm --filter @kindoo/web build` before `firebase deploy --only hosting`. → T-09.
- **Local Node version alignment.** Emulator runs against host's Node (currently 20.x); production runtime is Node 22. Operator should switch to Node 22 LTS via nvm/asdf, but it's a developer-environment concern, not a deploy blocker. → T-14.
- **Web-side principal consolidation onto `@kindoo/shared`** — already tracked at T-08 from Phase 1 close.

## Next

Phase 3 is **Firestore schema + security rules + indexes**. `backend-engineer`'s lane primarily; `web-engineer` waits for the data model before Phase 4's SPA shell consumes it. The rules-tests workspace is already scaffolded (Phase 1) and the lock-everything stub is in place; Phase 3 replaces the stub with the real per-collection rules from `firebase-schema.md` §6.
