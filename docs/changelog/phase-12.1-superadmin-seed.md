# Phase 12.1 — Superadmin seed runbook + e2e test

**Shipped:** 2026-05-19
**Commits:** see PR [#153](https://github.com/tad-smith/kindoo_access_tracker/pull/153) on `feat/12.1-superadmin-seed-v2`.

## What shipped

The first implementation atom of Phase 12 (multi-stake). The `syncSuperadminClaims` Cloud Function trigger has existed since Phase 2 but had no production caller — the `platformSuperadmins` collection was empty by design. 12.1 locks in the trigger's deployed behaviour ahead of 12.2 (the Stake List page is the first reader of the `isPlatformSuperadmin: true` claim).

Three atoms in this PR:

- **Operator runbook** at `infra/runbooks/seed-platform-superadmin.md`. Console-only management surface per the operator-resolved Phase 12 decision #2: there is no in-app UI for adding or removing superadmins, and there will not be one. Covers canonical-email computation (with a pure-JS DevTools snippet that works in any browser console), the Firestore console add / verify / remove steps, four edge cases (never-signed-in target, doc-id mismatch, bootstrap chicken-and-egg, claim-on-wrong-user from Gmail dot/`+suffix` collapsing), and rotation.

- **End-to-end emulator test** at `functions/tests/syncSuperadminClaims.e2e.test.ts`. Companion to the existing handler-stub test — this one writes a real `platformSuperadmins/{canonical}` doc against the Firestore emulator, lets the Functions emulator route the write through Eventarc to the deployed-shape trigger, and polls `admin.auth().getUser()` until `customClaims.isPlatformSuperadmin` flips. Symmetric revoke covered. TCP-probes `localhost:5001` so it skips cleanly when only firestore + auth are up (e.g. `test:integration:local`).

- **CI workflow reorder + integration env split.** `"Build functions for emulator"` now runs **before** `"Integration tests"` in both `.github/workflows/test.yml` and the source-of-truth mirror at `infra/ci/workflows/test.yml`, so `functions/lib/` is built before the Functions emulator boots — required for the new e2e test's trigger to be registered. A new `functions/.env.demo-kindoo-tests` env file mirrors `.env.kindoo-staging` minus `KINDOO_SKIP_CLAIM_SYNC=true`; the integration step pins `--project demo-kindoo-tests` so claim-sync triggers actually fire under emulator. Without this, the production env's E2E short-circuit was leaking into integration runs.

- **B.1 → 12.1 rename** across `docs/firebase-migration.md`, root `CLAUDE.md`, and `docs/TASKS.md`. Pure relabeling for greppability; `docs/firebase-schema.md` and `docs/navigation-redesign.md` had no `B.x` references.

## Out of scope

- **No new functions code.** The `syncSuperadminClaims` trigger and `applyClaims.applySuperadminClaim` helper are unchanged. This PR adds a test + runbook + rename around the existing surface.
- **No UI for superadmin management.** Console-only by design per operator decision #2. The first reader of the claim is 12.2's Stake List page.
- **No `platformAuditLog` writes yet.** That collection starts seeing real entries in 12.3 (the `createStake` callable).

## Decisions made during the phase

- **Pre-seed `platformSuperadmins/{canonical}` before `auth.createUser` in the e2e test** (after a reviewer-flagged race). The `onAuthUserCreate` handler runs `seedClaimsFromRoleData` which itself reads `platformSuperadmins/{canonical}`; pre-seeding the doc before the auth user exists makes `onAuthUserCreate` the deterministic claim writer and collapses the race against `syncSuperadminClaims`.
- **Inline JS canonical-email snippet** in the runbook instead of a dynamic import from the SPA bundle. The original `await import('/src/lib/canonicalEmail.js')` path doesn't survive the production build (real call sites import from `@kindoo/shared` which gets bundled). The inline snippet mirrors `packages/shared/src/canonicalEmail.ts` verbatim and works from any DevTools console.

No new architecture D-numbers. The runbook formalises an existing convention (console-only superadmin management); the test exercises an already-deployed trigger.

## Spec / doc edits in this phase

- `docs/firebase-migration.md` — B.1 → 12.1 rename in the Phase 12 sub-deliverables list; 12.1 marked as the first implementation atom.
- `docs/TASKS.md` — 12.1 task entries updated to the new label.
- `docs/changelog/phase-12.1-superadmin-seed.md` — this entry.
- `CLAUDE.md` (root) — Phase 12 status references updated to use 12.1-12.5 labels.

## Test footprint

- New: 2 e2e tests in `functions/tests/syncSuperadminClaims.e2e.test.ts` (mint + revoke). Gated on Functions emulator reachability — skips cleanly under `test:integration:local`.
- All pre-existing functions / web / firestore-rules suites unchanged.

## Next

12.2 — Stake List page + Superadmin nav section. Gates on the `isPlatformSuperadmin` claim this phase made operationally seedable, and requires a `firestore/firestore.rules` change adding `isPlatformSuperadmin()` to the `stakes/{stakeId}` read predicate so a zero-role superadmin can list every stake.
