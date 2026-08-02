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
   - Verifies the deploy actually landed (step 3 below)

   Expected end state: the script exits 0 and prints `=== deploy-staging.sh complete ===`.

3. **Read the post-deploy verification block.**

   The script does not stop at `firebase deploy`. `firebase deploy` exiting 0 only means the API accepted the upload — it does **not** mean the functions are reachable. Step 6 of the script probes every deployed callable unauthenticated and compares the deployed function set against the source exports. Full rationale, including the incident that motivated it, is in the header of `infra/scripts/lib/verify-deploy.sh`.

   Expected output (names and counts will differ as the function surface changes):

   ```
   === post-deploy verification — staging ===
       region:    us-central1
       baseline:  syncApplyFix
       exports:   24 (source: functions/src/index.ts)
       callables: 6
       project:   kindoo-staging

     calibrated on 'syncApplyFix': HTTP 401, signature '401:UNAUTHENTICATED'.
     Any callable answering with that signature is healthy — it ran our code
     and rejected the anonymous call itself.

     FUNCTION                           HTTP   RESULT
     syncApplyFix                       401    healthy (baseline)
     backfillEqPresidentAccess          401    healthy
     backfillKindooSiteId               401    healthy
     createStake                        401    healthy
     getMyPendingRequests               401    healthy
     markRequestComplete                401    healthy

     deployed set matches functions/src/index.ts (24 functions).

   === post-deploy verification PASSED ===
   ```

   Every row must read `healthy`. Any `FAIL —` row exits the script non-zero and prints a remediation for that specific failure; see "Post-deploy verification failures" under Troubleshooting.

   The exact HTTP status and signature are **not** fixed values — the check calibrates on a known-good long-existing callable (`syncApplyFix`) in the same run and compares everything else to it, so it survives Firebase changing its response format. Do not "fix" a changed baseline number; only a mismatch between callables matters.

   To re-run just this check later, without deploying:

   ```bash
   bash infra/scripts/lib/verify-deploy.sh staging
   ```

   To deploy without it — a knowingly-partial state, a deliberately broken callable, no network — pass `--skip-verify`. The script then prints `The deploy is UNVERIFIED.` and exits 0. Prefer fixing the failure.

4. **Verify the staging URL.**

   - Open `https://staging.stakebuildingaccess.org` (or `https://kindoo-staging.web.app`) in a browser. Expected: the SPA loads.
   - Open the browser console. Expected: no red errors.
   - **Verify the third-party Licenses link (T-20).** In an INCOGNITO window (so no prior service worker is cached), sign in and click the `Licenses` link in the nav footer. Expected: a plain-text page with the THIRD_PARTY_LICENSES.txt content (Apache-2.0 / MIT notices for the runtime deps). Curl alone is NOT enough — `curl https://<host>/THIRD_PARTY_LICENSES.txt` bypasses the service worker and will return the real bytes even if the SW is shadowing the link click. The browser click test is what catches a `navigateFallbackDenylist` regression that rewrites the link to the SPA shell.
   - **Verify the Hosting cache headers.** These are what stop the PWA version-thrash (an old cached service worker reasserting after a deploy); confirm them with curl, which bypasses the SW and shows the raw Hosting response:

     ```bash
     host=staging.stakebuildingaccess.org
     # SPA shell (served for any navigation path via the catch-all rewrite) — must revalidate:
     curl -sSI "https://$host/"          | grep -i '^cache-control:'
     curl -sSI "https://$host/dashboard" | grep -i '^cache-control:'
     # Service-worker scripts — must revalidate so a new deploy can win:
     curl -sSI "https://$host/sw.js"                     | grep -i '^cache-control:'
     curl -sSI "https://$host/firebase-messaging-sw.js"  | grep -i '^cache-control:'
     # A content-hashed asset — must be immutable (pick any file under /assets/ from the build):
     curl -sSI "https://$host/assets/$(ls apps/web/dist/assets | grep -m1 '^index-.*\.js$')" | grep -i '^cache-control:'
     ```

     Expected:
     - `/`, `/dashboard`, `/sw.js`, `/firebase-messaging-sw.js` → `cache-control: no-cache, max-age=0, must-revalidate`
     - the `/assets/…` file → `cache-control: public, max-age=31536000, immutable`

     If the shell or `sw.js` comes back `immutable` (or with a long `max-age`), the header globs in `firebase.json` regressed — see the "shows the old version" troubleshooting entry below.

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

4. **Read the post-deploy verification block.**

   Identical to the staging step above, targeting `kindoo-prod`. Every callable row must read `healthy` and the deployed set must match `functions/src/index.ts`. A failure exits the script non-zero and prints `DEPLOYED, BUT VERIFICATION FAILED` — production is live and broken at that point, so either fix forward using the printed remediation or roll back per the Rollback section.

   Re-run on its own with:

   ```bash
   bash infra/scripts/lib/verify-deploy.sh prod
   ```

   `--skip-verify` exists on the prod script too, but on prod an unverified deploy is a deploy you have no evidence works. Use it only when you already know why the check would fail.

5. **Verify the prod URL.**

   - Open `https://stakebuildingaccess.org` (or `https://kindoo-prod.web.app`) in a browser; sign in; smoke-test the pages relevant to this deploy.
   - **Verify the Hosting cache headers** with the curl block from the staging step, substituting `host=stakebuildingaccess.org`. Same expected output: `no-cache, max-age=0, must-revalidate` for the shell + SW scripts, `public, max-age=31536000, immutable` for `/assets/…`.

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

## Post-deploy verification failures

Each of these prints its own remediation inline; this section is the background on why the symptom means what it means. All four are real failure modes that have shipped from this repo's deploy scripts while `firebase deploy` reported success.

### `FAIL — iam-missing` (HTTP 403)

Cloud Run rejected the request at the edge, before the container ran. The `allUsers` → `roles/run.invoker` binding is missing on that service.

Firebase grants that binding only when it **creates** the Cloud Run service. If an earlier failed deploy left an empty service shell behind, the next deploy takes the **update** path instead of create — the function then deploys "successfully", reports healthy, and is still unreachable to every caller. In a browser this surfaces as a **CORS error**, not a 403, because a Cloud Run 403 on the preflight carries no `Access-Control-Allow-Origin` header. That is a deeply misleading symptom; do not go looking for a CORS config.

Fix (the service name is the function name **lowercased**):

```bash
gcloud run services add-iam-policy-binding <lowercased-function-name> \
  --region us-central1 --project kindoo-staging \
  --member=allUsers --role=roles/run.invoker
```

Then re-run `bash infra/scripts/lib/verify-deploy.sh staging` and confirm the row flips to `healthy`.

### `FAIL — crashing` (HTTP 5xx)

The container is failing to start or crashing on request. The known cause is a runtime dependency missing from the generated `functions/lib/package.json`: `firebase deploy` uploads only `functions/lib`, and Cloud Build then runs its own `npm install` against that generated manifest with no lockfile. An optional peer dependency npm decides to skip takes every function down at container start.

```bash
gcloud run services logs read <lowercased-function-name> \
  --region us-central1 --project kindoo-staging --limit 50
```

Look for `Cannot find module` at the top of the container log. The fix is to declare the module explicitly in `functions/package.json` dependencies (that workspace is `backend-engineer`'s — file it in `docs/TASKS.md`). The systemic fix, pinning the deploy artifact's dependency tree, is tracked as **T-73**.

### `FAIL — not-deployed` (HTTP 404)

Nothing is serving at that URL. Either the function was never deployed, or it landed under a different name, or it is in a region other than `us-central1`. Check `firebase functions:list --project staging` and redeploy the single function.

### `ERROR: exported from source but NOT deployed`

The deployed function set is missing something `functions/src/index.ts` exports. Almost always a wrong-branch or stale-build deploy: the checkout that produced `functions/lib` did not contain those functions. Confirm `git rev-parse HEAD` is the commit you meant to ship, then rebuild and redeploy.

The mirror case — `warning: deployed but not exported from source` — is only a warning. It usually means a function was removed from source but its Cloud Run service has not been deleted yet.

### `BASELINE CALIBRATION FAILED`

The check probes a known-good long-existing callable first and calibrates on its response; everything else is compared to that. This message means the baseline itself did not answer like a healthy callable, so there was nothing trustworthy to compare against.

Two possibilities, and the message prints the remediation for the first:

1. The baseline is genuinely broken — treat it as whichever failure class its status code indicates, above. If **every** function is down, suspect the container-start mode.
2. Firebase changed the callable protocol's error shape. In that case update `vd_baseline_is_sane` in `infra/scripts/lib/verify-deploy.sh` and re-run the unit tests.

To calibrate on a different callable instead: `VD_BASELINE=markRequestComplete bash infra/scripts/lib/verify-deploy.sh staging`.

## Manual verification of the deploy scripts

Run these after any change to `infra/scripts/deploy-*.sh` or `infra/scripts/lib/verify-deploy.sh`. None of them touch a Firebase project.

1. **Shell syntax on every script.**

   ```bash
   bash -n infra/scripts/deploy-staging.sh
   bash -n infra/scripts/deploy-prod.sh
   bash -n infra/scripts/lib/verify-deploy.sh
   bash -n infra/scripts/tests/verify-deploy.test.sh
   ```

   Expected: no output, exit 0 for each.

2. **Verification-logic unit tests.**

   ```bash
   bash infra/scripts/tests/verify-deploy.test.sh
   ```

   Expected last line: `=== verify-deploy.test.sh: <N> passed, 0 failed ===`, exit 0. These cover the response classifier against synthetic responses for all four failure modes, the export parser against both fixtures and the live `functions/src/index.ts`, and the whole verification run end-to-end with the network stubbed out. No emulators, no credentials, no network.

3. **Dry-run both deploy scripts.**

   ```bash
   bash infra/scripts/deploy-staging.sh --dry-run
   bash infra/scripts/deploy-prod.sh --dry-run
   ```

   Expected: every command echoed with a `[dry-run]` prefix and nothing executed. The verification block must list the callable URLs it *would* probe and end with `[dry-run] nothing probed.` If it probes anything in dry-run, that is a bug — stop.

4. **Dry-run the flag combinations that change the verification path.**

   ```bash
   bash infra/scripts/deploy-staging.sh --web-only --dry-run
   bash infra/scripts/deploy-staging.sh --skip-verify --dry-run
   bash infra/scripts/deploy-prod.sh --skip-verify --dry-run
   ```

   Expected, respectively: `[skip] post-deploy verification (--web-only: no functions deployed)`, `The deploy is UNVERIFIED.`, `PRODUCTION IS UNVERIFIED.`

5. **Live path.** The classifier's real-world behaviour can only be confirmed by an actual deploy — the calibration depends on what Firebase actually returns for an unauthenticated callable POST. On the first deploy after any change here, read the verification block carefully rather than skimming for `PASSED`, and confirm the baseline row reports a 4xx with a `UNAUTHENTICATED`-shaped signature.

## Troubleshooting

### `firebase use staging` errors with "Project not found"

`.firebaserc` points at a project ID that does not resolve under the currently-logged-in Firebase account. Either:
- Run `firebase login` and confirm the listed account has access to the project, or
- Edit `.firebaserc` to point at a different (existing) project ID.

### Deploy script fails at `pnpm typecheck`

A workspace's `tsconfig.json` is broken. Run `pnpm typecheck` directly to see which workspace is failing; fix locally before retrying the deploy.

### Deploy succeeds but the staging site shows the old version

Browser cache. Hard-refresh (Cmd-Shift-R on macOS). The `version.gen.ts` payload (rendered in the topbar) should match the commit you just deployed; if it does not, the deploy actually did not go through — check `firebase hosting:channel:list --project staging` and re-run the deploy.

If a hard-refresh does NOT fix it, suspect the service worker, not Hosting. The Hosting cache headers (`firebase.json` → `hosting.headers`) make the SPA shell and the SW scripts (`/sw.js`, `/firebase-messaging-sw.js`) `no-cache` so a new deploy always wins on the next revalidation, while only content-hashed `/assets/**` (and the root-level hashed `workbox-*.js` chunk) stay `immutable`. The header `source` globs match the **request path** — Firebase Hosting headers are **last-match-wins**, so the catch-all `**` no-cache rule comes first and the `/assets/**` + `/workbox-*.js` immutable rules come after it to override it for hashed files only. If you change those globs, re-verify with the curl block in the "Verify the staging URL" step. Confirm the headers are actually live: `curl -sSI https://staging.stakebuildingaccess.org/sw.js | grep -i cache-control` must show `no-cache`.

**One-time escape hatch for a desktop browser already stuck in the pre-fix thrash.** Browsers that cached the old `sw.js` (or an uncontrolled tab) before these headers shipped can keep reasserting the stale worker even after the fix is deployed, because the OLD `sw.js` was fetched under default caching. To force such a browser onto the new build once:

1. DevTools → Application → Service Workers → check "Update on reload", then click **Unregister** for the site's worker.
2. DevTools → Application → Storage → **Clear site data**.
3. Close ALL tabs for the origin (the controlling page only releases when every tab is gone), then reopen.

After the headers are live, this is a one-time-per-browser cleanup; subsequent deploys revalidate `sw.js` automatically and do not need it.

> **CDN propagation:** Firebase Hosting serves through Fastly. After a deploy, edge nodes can briefly serve the previous release's headers/bytes until propagation completes (seconds, occasionally a minute). If the curl checks above show stale headers immediately after deploy, wait and re-run before concluding the config is wrong.

## What this runbook does NOT cover

- **Cloud Scheduler job management** — managed by the `installScheduledJobs` callable; see `functions/src/callable/installScheduledJobs.ts` and `docs/firebase-migration.md` Phase 8.
- **Secret Manager updates** — see `infra/runbooks/resend-api-key-setup.md` for the Resend key; add a similar runbook when a new secret is introduced.
- **Custom-domain / DNS setup** — `infra/runbooks/custom-domain.md`.
- **Runtime SA grants on the roster Sheet** — `infra/runbooks/granting-importer-sheet-access.md` (deprecated; T-45 removed the importer).
