# Runbook: Deploying the Firebase port

Operator playbook for deploying the Firebase monorepo to `kindoo-staging` or `kindoo-prod`. Two commands, but with pre-flight, post-deploy verification, and rollback steps documented here so an operator under pressure has them in one place.

> **Before running this runbook the first time on a new machine**, complete `infra/runbooks/provision-firebase-projects.md`. That runbook creates the Firebase projects, billing, services, Firestore databases, Auth, and service accounts that this deploy runbook assumes already exist. Both `kindoo-staging` and `kindoo-prod` are provisioned and live as of 2026-05-03.

## Pre-flight (every deploy)

1. **Verify you are on a clean working tree on `main`.**

   ```bash
   git status
   git rev-parse --abbrev-ref HEAD
   ```

   Expected output: `working tree clean` and `main`. Any uncommitted changes or other branch → stop. The deploy bakes the current commit's git short SHA into the build via `infra/scripts/stamp-version.js`; if your tree is dirty, the version stamp will not match what is in git. The deploy scripts also enforce this guard themselves (`guard_main_clean`) and refuse to run otherwise.

2. **Verify the firebase CLI is the npm-installed shim, not the standalone binary.**

   ```bash
   which firebase
   ls -la "$(which firebase)"
   ```

   The path must resolve to either `node_modules/.bin/firebase` (this repo) or the small Node shim from `npm install -g firebase-tools`. If it is the ~282 MB standalone binary at `/usr/local/bin/firebase`, the emulator-driven tests this deploy depends on fail with cryptic ESM errors. See `infra/runbooks/provision-firebase-projects.md` §0.4 ("firebase CLI installed the right way") for the full footgun writeup and the fix. Do not run `pnpm install -g firebase-tools` with sudo — same section explains why.

3. **Verify Firebase CLI auth.**

   ```bash
   firebase login:list
   ```

   Expected: at least one account listed. If empty, run `firebase login`.

4. **Verify the project alias resolves.**

   ```bash
   firebase use staging   # or: firebase use prod
   ```

   Expected output: `Now using alias staging (kindoo-staging)`.

5. **Verify per-project env files contain `WEB_BASE_URL`.**

   The notification triggers (`notifyOnRequestWrite`, `notifyOnOverCap`) build deep-link URLs in email + push payloads (e.g. the link in a "your request was approved" email goes to `${WEB_BASE_URL}/request/{requestId}`). The triggers run server-side and have no access to the SPA's compiled-in env, so the value must be supplied as a Firebase Functions param at deploy time. Declared via `defineString('WEB_BASE_URL')` in `functions/src/lib/params.ts`; consumed at runtime by `EmailService.buildLink()` via `WEB_BASE_URL.value()`.

   The value is per-project — staging links must NOT point at prod, and vice versa. Set it via the per-project env file in `functions/`:

   ```bash
   cat functions/.env.kindoo-staging | grep WEB_BASE_URL
   # Expected: WEB_BASE_URL=https://staging.stakebuildingaccess.org

   cat functions/.env.kindoo-prod | grep WEB_BASE_URL
   # Expected: WEB_BASE_URL=https://stakebuildingaccess.org
   ```

   If either file is missing or the line is absent, create it before deploying:

   ```bash
   cat > functions/.env.kindoo-staging <<EOF
   WEB_BASE_URL=https://staging.stakebuildingaccess.org
   EOF

   cat > functions/.env.kindoo-prod <<EOF
   WEB_BASE_URL=https://stakebuildingaccess.org
   EOF
   ```

   The Firebase default origins `https://kindoo-staging.web.app` and `https://kindoo-prod.web.app` are also valid values — they remain reachable alongside the custom domains and can be used if the custom-domain DNS is being reconfigured. The custom domains are canonical for normal operation.

   `functions/.env.*` is gitignored. The full setup walkthrough (including Resend's `RESEND_API_KEY` companion secret) lives in `infra/runbooks/resend-api-key-setup.md` §4.

   **How the value reaches Cloud Build.** `firebase.json` sets `functions.source: "functions/lib"`, so Firebase CLI reads `.env.<projectId>` from `functions/lib/`, not `functions/`. `functions/scripts/build.mjs` (lines 110-118) iterates every `functions/.env.*` and `fs.copyFile`s each one to `functions/lib/.env.*` on every build. The copy is unconditional — source overwrites lib/ — so a stale empty `lib/.env.<projectId>` from a prior CLI interactive prompt cannot silently shadow the real source value. Source is the single source of truth; edit `functions/.env.<projectId>` and the next build re-syncs.

   **Failure modes if the variable is unset:**

   - **At deploy time:** `firebase deploy` may interactively prompt with `Enter a string value for WEB_BASE_URL:` and stash whatever you type into `functions/lib/.env.<projectId>`. If you take this path, mirror the value into `functions/.env.<projectId>` immediately — otherwise the next build overwrites lib/ with an empty value.
   - **At runtime:** `WEB_BASE_URL.value()` returns the empty string. `EmailService.buildLink()` throws `WEB_BASE_URL is not set on the function. Set it at deploy time.`; the trigger surface catches the throw via `safeBuildLink`, logs `email skipped — link build failed`, and writes one `email_send_failed` audit row tagged `type='config'` per affected request. Visible-but-not-silent surfacing of deploy-time misconfiguration, but emails do not ship and notifications stop until the value is restored.

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
   - Builds web + functions
   - Deploys Hosting + Functions + Firestore (rules + indexes)

   Expected end state: the script exits 0 and prints `=== deploy-staging.sh complete ===`.

3. **Verify the staging URL.**

   - Open `https://staging.stakebuildingaccess.org` (or `https://kindoo-staging.web.app`) in a browser. Expected: the SPA loads.
   - Open the browser console. Expected: no red errors.
   - **Verify the third-party Licenses link (T-20).** In an INCOGNITO window (so no prior service worker is cached), sign in and click the `Licenses` link in the nav footer. Expected: a plain-text page with the THIRD_PARTY_LICENSES.txt content (Apache-2.0 / MIT notices for the runtime deps). Curl alone is NOT enough — `curl https://<host>/THIRD_PARTY_LICENSES.txt` bypasses the service worker and will return the real bytes even if the SW is shadowing the link click. The browser click test is what catches a `navigateFallbackDenylist` regression that rewrites the link to the SPA shell.

## Prod deploy

1. **Pre-flight, additional for prod:**
   - Confirm staging deploy passed for the same commit you are about to push to prod.
   - Confirm `git rev-parse HEAD` matches what is deployed to staging.
   - **Open TODO:** the deploy-prod.sh script does not yet prompt for an explicit typed `yes` confirmation before proceeding when not in dry-run. The `guard_main_clean` check stops accidental deploys from a topic branch, but a typed-confirmation gate would be a useful additional speed bump for prod. Sketch is in the script header comment.

2. **Run the deploy script in dry-run first.**

   ```bash
   bash infra/scripts/deploy-prod.sh --dry-run
   ```

3. **Run the actual deploy.**

   ```bash
   pnpm deploy:prod
   ```

4. **Verify the prod URL.**

   - Open `https://stakebuildingaccess.org` (or `https://kindoo-prod.web.app`) in a browser; sign in; smoke-test the pages relevant to this deploy.

## Rollback

Open TODO: walk and validate the rollback procedure end-to-end against staging, then promote the steps below from sketch to verified. Until that drill happens, treat these as a starting point, not a finished playbook.

1. **Hosting.** `firebase hosting:rollback --project prod` — Firebase Hosting retains the previous release and rolls back instantly.
2. **Functions.** Roll back to the previous git SHA, rebuild, and redeploy only the affected function(s):
   ```bash
   git checkout <prev-sha>
   pnpm --filter ./functions build
   firebase deploy --only functions:<name> --project prod
   ```
   For a full functions rollback, drop the `:<name>` suffix.
3. **Firestore rules + indexes.** Deploy from the previous commit explicitly:
   ```bash
   git checkout <prev-sha> -- firestore
   firebase deploy --only firestore --project prod
   ```

See `infra/runbooks/restore.md` for data restore procedures (separate concern from code rollback).

## Troubleshooting

### `firebase use staging` errors with "Project not found"

`.firebaserc` points at a project ID that does not resolve under the currently-logged-in Firebase account. Either:
- Run `firebase login` and confirm the listed account has access to the project, or
- Edit `.firebaserc` to point at a different (existing) project ID.

### Deploy script fails at `pnpm typecheck`

A workspace's `tsconfig.json` is broken. Run `pnpm typecheck` directly to see which workspace is failing; fix locally before retrying the deploy.

### Deploy succeeds but the staging site shows the old version

Browser cache. Hard-refresh (Cmd-Shift-R on macOS). The `version.gen.ts` payload (rendered in the topbar) should match the commit you just deployed; if it does not, the deploy actually did not go through — check `firebase hosting:channel:list --project staging` and re-run the deploy.

## What this runbook does NOT cover

- **Cloud Scheduler job management** — managed by the `installScheduledJobs` callable; see `functions/src/callable/installScheduledJobs.ts` and `docs/firebase-migration.md` Phase 8.
- **Secret Manager updates** — see `infra/runbooks/resend-api-key-setup.md` for the Resend key; add a similar runbook when a new secret is introduced.
- **Custom-domain / DNS setup** — `infra/runbooks/custom-domain.md`.
- **Runtime SA grants on the roster Sheet** — `infra/runbooks/granting-importer-sheet-access.md`.
