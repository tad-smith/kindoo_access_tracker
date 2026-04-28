# Runbook: Deploying the Firebase port

Operator playbook for deploying the Firebase monorepo to `kindoo-staging` or `kindoo-prod`. Two commands, but with pre-flight, post-deploy verification, and rollback steps documented here so an operator under pressure has them in one place.

> **Before running this runbook**, complete `infra/runbooks/provision-firebase-projects.md` (B1 in pre-Phase-1 setup). That runbook creates the Firebase projects, billing, services, Firestore databases, Auth, and service accounts that this deploy runbook assumes already exist.

> **STATUS (as of 2026-04-27):** This runbook is **Phase 1 skeleton**. Several sections are TODO until operator task **B1** in `docs/firebase-migration.md` lands (real Firebase projects + service accounts + billing). The structure is in place so that as B1 + later phases ship, this fills in incrementally.

## Pre-flight (every deploy)

1. **Verify you're on a clean working tree on `main`.**

   ```bash
   git status
   git rev-parse --abbrev-ref HEAD
   ```

   Expected output: `working tree clean` and `main`. Any uncommitted changes or other branch → stop. The deploy bakes the current commit's git short SHA into the build via `infra/scripts/stamp-version.js`; if your tree is dirty, the version stamp won't match what's in git.

2. **Verify Firebase CLI auth.**

   ```bash
   firebase login:list
   ```

   Expected: at least one account listed. If empty, run `firebase login`.

3. **Verify the project alias resolves.**

   ```bash
   firebase use staging   # or: firebase use prod
   ```

   Expected output: `Now using alias staging (kindoo-staging)`. Errors here usually mean B1 hasn't been done — the alias points at a project ID that doesn't exist.

   - **TODO post-B1:** lock down operator access; the prod alias should require an additional `firebase login:add` step or a separate operator-account.

## Staging deploy

1. **Run the deploy script in dry-run first.**

   ```bash
   bash infra/scripts/deploy-staging.sh --dry-run
   ```

   Expected: every step echoed, nothing executed. Review the output — make sure no unexpected commands appear.

2. **Run the actual deploy.**

   ```bash
   pnpm deploy:staging
   ```

   This runs `infra/scripts/deploy-staging.sh` end-to-end:
   - Stamps version
   - Typechecks
   - Tests
   - Builds web + functions
   - Deploys Hosting + Functions + Firestore (rules + indexes)

   Expected end state: the script exits 0 and prints `=== deploy-staging.sh complete ===`.

   - **TODO Phase 1 hand-off:** until web-engineer + backend-engineer wire the workspace `build` and `test` scripts, the inner `pnpm test` and `pnpm --filter ./apps/web build` calls may fail. Phase 1's exit criterion is that `pnpm deploy:staging --dry-run` runs cleanly to the end.

3. **Verify the staging URL.**

   - **TODO post-B1:** record the staging URL here. Expected to be something like `https://kindoo-staging.web.app`.
   - Open the URL in a browser. Expected: the SPA loads. (Phase 1: a hello page reading the smoketest doc; Phase 4+: the real app.)
   - Open the browser console. Expected: no red errors.

## Prod deploy

> **DO NOT RUN THIS UNTIL PHASE 11 cutover has been scheduled.** Per migration plan F12, prod is empty until the migration window. Before then, every prod deploy attempt should be a dry-run only.

1. **Pre-flight, additional for prod:**
   - Confirm staging deploy passed for the same commit you're about to push to prod.
   - Confirm `git rev-parse HEAD` matches what's deployed to staging.
   - **TODO post-B1:** add an explicit `firebase use prod` and a typed `yes` confirmation prompt in the script.

2. **Run the deploy script in dry-run first.**

   ```bash
   bash infra/scripts/deploy-prod.sh --dry-run
   ```

3. **Run the actual deploy.**

   ```bash
   pnpm deploy:prod
   ```

4. **Verify the prod URL.**

   - **TODO post-B1:** record prod URL.
   - Open in browser; sign in; smoke-test the Phase-N pages relevant to this deploy.

## Rollback

> **TODO post-B1:** define rollback procedure. Likely:
>
> 1. `firebase hosting:rollback --project prod` (Hosting has automatic rollback support).
> 2. For Functions, `firebase functions:delete <name>` followed by `firebase deploy --only functions:<name>` from the previous commit.
> 3. For Firestore rules/indexes, deploy from the previous commit explicitly: `git checkout <prev-sha> -- firestore && firebase deploy --only firestore`.
>
> See `infra/runbooks/restore.md` for data restore procedures (separate concern from code rollback).

## Troubleshooting

### `firebase use staging` errors with "Project not found"

B1 hasn't been done — the project ID `kindoo-staging` in `.firebaserc` doesn't resolve to a real Firebase project. Either:
- Run B1 (create the project), or
- Edit `.firebaserc` to point at a different (existing) project ID.

### Deploy script fails at `pnpm typecheck`

Workspaces' `tsconfig.json` files are missing or have errors. Phase 1 workspace agents need to wire these. Until they do, `tsc -b` resolves the empty root `tsconfig.json` and exits 0 — if it doesn't, something else is wrong (check that `tsconfig.json` in the repo root has empty `files` and `references`).

### Deploy succeeds but the staging site shows the old version

Browser cache. Hard-refresh (Cmd-Shift-R on macOS). The `version.ts` footer should match the commit you just deployed; if it doesn't, the deploy actually didn't go through — check `firebase hosting:channel:list --project staging` and re-run the deploy.

## What this runbook does NOT cover

- **Cloud Scheduler job updates** — Phase 8.
- **Secret Manager updates** — `secrets.md` runbook (TODO).
- **Real auth provider config** — Firebase console; lives in `auth-config.md` (TODO).
- **DNS / custom domain setup** — Phase 11 cutover; lives in `cutover.md` (TODO).
