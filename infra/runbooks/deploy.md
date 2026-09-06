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

6. **Verify `apps/web/.env.staging` contains `VITE_EXTENSION_IDS`. Staging only** — a normal prod deploy needs nothing here.

   `pnpm deploy:staging` runs `vite build --mode staging`, which **fails outright** when this is unset, before anything is built or uploaded. That is deliberate. The SPA's `/auth/extension` handoff mints a session token for the Chrome extension only if the caller's ID is on the build's allowlist, and only the published Web Store ID is compiled in (`CHROME_EXTENSION_ID`, a production-only default). The staging extension is loaded unpacked and carries its own keypair-derived ID, so a staging build with an empty allowlist refuses the very extension it was built for — and the extension cannot tell that refusal apart from the manager closing the window, which turns it into a retry-forever dead end with one service-worker log line as the only clue. Failing the build converts that into a message at the moment the mistake is made.

   ```bash
   grep VITE_EXTENSION_IDS apps/web/.env.staging
   # Expected: VITE_EXTENSION_IDS=<32 characters, a–p>   (comma-separated for more than one)
   ```

   If the line is missing or empty, derive the ID from the staging extension's pinned key:

   ```bash
   pnpm --filter @kindoo/extension ext-id \
     --key "$(grep '^VITE_EXTENSION_KEY=' extension/.env.staging | cut -d= -f2-)"
   ```

   Paste the 32-character output into `apps/web/.env.staging` as `VITE_EXTENSION_IDS=<id>`. Both env files are gitignored. The build's own error message names the same command, so this is friction rather than a trap — but it stops the deploy either way. Full context: `infra/runbooks/extension-deploy.md` §"First-time per-env setup" step 6, and the comments above the key in `apps/web/.env.example`.

   **The list is a trust boundary.** Only ever add an ID you control: anything listed can ask a signed-in manager's browser for a custom token that exchanges into a full session as that manager. A malformed entry is dropped on its own rather than widening the list, so a typo costs that one ID its trust — and, if it was the only entry, fails the build.

   **The one prod case.** Three extension IDs exist — the Web Store ID, the staging keypair ID, and the keypair ID of the prod-mode unpacked build used for the pre-upload smoke test. Only the first is trusted implicitly, so that smoke test needs a **temporary** entry in `apps/web/.env.production` plus a prod redeploy to compile it in, and both have to be undone once the Web Store version is live: a listed ID stays trusted indefinitely. See `infra/runbooks/extension-deploy.md` §"First-time install (staging)".

## Deploy dependency pinning

**You only touch this when `functions/package.json` `dependencies` change.** Every other deploy is unaffected — the check below runs automatically inside the build and says nothing when all is well.

`firebase deploy` uploads only `functions/lib`, so `lib/` is the package root Cloud Build installs from. `functions/deploy-lock/package-lock.json` is the committed lockfile for that install; `functions/scripts/build.mjs` copies it to `functions/lib/package-lock.json` on every build, beside the `lib/package.json` it generates. Before this existed, every version range re-resolved at deploy time — which took production down once, when npm skipped `@firebase/app` (an optional peer of `@firebase/database-compat`) and all 24 functions died at container start. Background: `docs/TASKS.md` T-73, `functions/deploy-lock/README.md`.

### When a dependency changes

After editing `functions/package.json` `dependencies` (add, remove, or version bump):

```bash
pnpm install                 # updates pnpm-lock.yaml
pnpm deps:relock             # regenerates functions/deploy-lock/package-lock.json
```

Expected tail of `pnpm deps:relock` (versions will differ):

```
Verifying with a real `npm ci` ...
  require('firebase-functions') OK
  require('firebase-functions/v1') OK
  require('firebase-admin/database') OK

Resolved versions:
  @firebase/app                0.14.13
  firebase-admin               13.10.0
  firebase-functions           7.3.2
  resend                       4.8.0
  @firebase/database-compat    2.1.7
  @grpc/grpc-js                1.14.4

Wrote functions/deploy-lock/package-lock.json (273 packages).
```

Versions and the package count are illustrative — they move with every
dependency refresh. What matters is that the run succeeds and the diff is
reviewed.

Needs network (npm registry). Commit the regenerated lockfile in the same commit as the `functions/package.json` change. Review its diff: it is the only place the deployed transitive tree is visible.

`--dry-run` resolves and verifies without writing the repo file. `--keep` leaves the temp install directory in place for inspection.

### Verifying the pinning

```bash
pnpm deps:check
```

Expected:

```
deploy-lock check: OK
  functions/deploy-lock/package-lock.json
  lockfileVersion 3, 273 packages pinned

  DEPENDENCY                 DECLARED      pnpm-lock     deploy-lock
  @firebase/app              ^0.14.13      0.14.13       0.14.13
  firebase-admin             ^13.10.0      13.10.0       13.10.0
  firebase-functions         ^7.3.2        7.3.2         7.3.2
  resend                     ^4.8.0        4.8.0         4.8.0
```

Versions will differ — only the three columns agreeing matters.

Offline — no registry lookup, no `node_modules`, no credentials. It asserts the lockfile's root dependency set matches `functions/package.json` at the versions `pnpm-lock.yaml` resolves. It deliberately never re-resolves, so an upstream publishing a new version cannot turn it red; what it catches is someone editing dependencies and forgetting `pnpm deps:relock`.

The same check runs inside `pnpm --filter @kindoo/functions build`, so a stale lockfile fails the deploy at the predeploy hook rather than inside Cloud Build. If a deploy stops with `Deploy lockfile is out of step with functions/package.json + pnpm-lock.yaml`, run the two commands above and retry.

Do not lean on Cloud Build's `npm ci` to catch drift for you. Its sync check is one-directional — see step 3 of "Manual verification of the deploy dependency pinning" below for the measured behaviour. The case it misses is the one that caused the outage.

Direct dependency versions are pinned to what `pnpm-lock.yaml` resolves, so the deployed direct deps are the ones CI tests. Transitives are npm's own resolution and will not match pnpm's exactly (npm and pnpm resolve differently); that divergence lives in the committed lockfile where it can be reviewed.

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
       exports:   29 (source: functions/src/index.ts)
       callables: 8
       project:   kindoo-staging

     calibrated on 'syncApplyFix': HTTP 401, signature '401:UNAUTHENTICATED'.
     Any callable answering with that signature is healthy — it ran our code
     and rejected the anonymous call itself.

     FUNCTION                           HTTP   RESULT
     syncApplyFix                       401    healthy (baseline)
     backfillAuditTtl                   401    healthy
     backfillEqPresidentAccess          401    healthy
     backfillKindooSiteId               401    healthy
     createStake                        401    healthy
     getMyPendingRequests               401    healthy
     markRequestComplete                401    healthy
     mintExtensionToken                 401    healthy

     deployed set matches functions/src/index.ts (29 functions).

   === post-deploy verification PASSED ===
   ```

   Every row must read `healthy`. Any `FAIL —` row exits the script non-zero and prints a remediation for that specific failure; see "Post-deploy verification failures" under Troubleshooting.

   **The two T-104 functions do not appear in the probe table, and that is correct.** `dispatchScheduledTasks` (`onSchedule`) and `runScheduledTask` (`onTaskDispatched`) are invoked by Cloud Scheduler and Cloud Tasks with an OIDC identity, so an anonymous probe proves nothing about them — check 1 deliberately covers only `onCall` exports. They are covered by check 2, the `deployed set matches` line, which counts all 29. If either ever shows up as a row in the probe table, discovery has misclassified it; `infra/scripts/tests/verify-deploy.test.sh` guards both classes.

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

### Deploying a PR branch to staging (`--from-pr`)

To rehearse an unmerged PR on staging without merging it:

```bash
pnpm deploy:staging -- --from-pr <PR-number>
```

The `main`-branch and up-to-date-with-`origin/main` pre-flight guards are skipped for this mode; the clean-working-tree guard still applies, because the script moves `HEAD` under you. `--from-pr` composes with `--web-only` and `--skip-verify`, in any order. It is **staging-only** by design — production always ships from `main`.

**The checkout is detached, on purpose.** The script fetches GitHub's `refs/pull/<number>/head` and checks out the PR's exact head commit with `git checkout --detach`. It does **not** run `gh pr checkout`, and it creates no local branch.

This is the fix for a blocker that stopped real deploys three separate times. `gh pr checkout` creates and checks out a local branch for the PR head, and git permits a branch ref to be checked out in only one worktree at a time. Because this repo accumulates agent worktrees under `.claude/worktrees/`, any worktree holding the PR's branch killed the deploy on the spot:

```
[run] gh pr checkout 244
fatal: 'feat/limited-app-access' is already used by worktree at '/Users/tad/projects/Kindoo/.claude/worktrees/fold-limited-access'
failed to run git: exit status 128
```

A detached `HEAD` names a commit and claims no branch ref, so worktree locks cannot apply. Pruning stale worktrees is **not** required before a deploy, and this is not a "try again after cleanup" situation — the failure mode is structurally gone. Fork PRs still work: `refs/pull/<n>/head` exists in this repo for every PR, including cross-repo ones.

Expected output for the checkout block (the SHA is echoed so you can confirm exactly what is being deployed, rather than inferring it from a branch name):

```
PR title: feat: welcome email on first app-access grant
PR branch: feat/welcome-email-on-access-grant
PR author: tad-smith
PR head SHA: f3d371a34c644848643d77731c5f8fbd235bbfe4
Commits ahead of main: 4

[run] git fetch origin refs/pull/243/head
 * branch            refs/pull/243/head -> FETCH_HEAD
[run] git checkout --detach f3d371a34c644848643d77731c5f8fbd235bbfe4
Deploying commit: f3d371a34c644848643d77731c5f8fbd235bbfe4
[run] node infra/scripts/stamp-version.js
stamp-version: wrote 2 file(s), skipped 0 missing dir(s) — sha=f3d371a builtAt=...
```

Confirm the `sha=` from the stamper matches the first 7 characters of `PR head SHA`. That value is what the deployed bundle reports in the topbar, so it is how you check later that staging is running the PR you think it is.

If the script instead prints `warn: PR #<n> head <sha> is not among the objects fetched`, the PR was pushed to while the script was running (`gh pr view` and GitHub's pull ref disagreed). It deploys the commit it actually fetched and names it. Re-run to pick up fresh metadata if that is not what you wanted.

**On exit — success, failure, or Ctrl-C — a `trap` puts you back where you started:** the branch you were on, or the exact commit still detached if you invoked the script from a detached `HEAD`. Nothing is left to clean up, since no branch was created.

**Manual verification** (no Firebase project touched; substitute any open PR number):

```bash
bash infra/scripts/deploy-staging.sh --from-pr <PR-number> --dry-run
bash infra/scripts/deploy-staging.sh --from-pr <PR-number> --web-only --dry-run
bash infra/scripts/deploy-staging.sh --from-pr <PR-number> --skip-verify --dry-run
```

Expected: the PR title/branch/author/head-SHA block resolves, then

```
[dry-run] would: git fetch origin refs/pull/<n>/head
[dry-run] would: git checkout --detach <full-40-char-sha>
[dry-run] on exit (trap): would restore branch '<your-branch>'
```

and nothing is fetched or checked out — `git branch --show-current` is unchanged afterwards, and no new local branch exists. If the dry run reports `would: gh pr checkout`, you are on an old copy of the script; the worktree blocker is back.

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

## One-time fixup: backfill the `bootstrap` claim after PR #258

**Run this once, right after this deploy lands, then cross it off.** It is not a recurring deploy step — it is a gap left by adding a new trigger to an existing collection. `syncBootstrapClaims` (PR #258, `docs/architecture.md` D28, closes B-19) only fires on a *write* to `stakes/{stakeId}`, so a stake that already existed before this deploy and hasn't been written to since gets no `bootstrap` claim minted. Its bootstrap admin — who has typically already signed in once and hit "Not Authorized" — can't be rescued by the first-sign-in seeding either, since `onAuthUserCreate` only fires once per user, ever.

**When this applies:** only to a stake doc with `setup_complete: false` that existed before this deploy. A stake created by `createStake` after this deploy mints the claim automatically on write — nothing to do for those.

1. **Find affected stakes.** Firebase console → Firestore Database → `stakes` collection → filter `setup_complete == false`. For each match, that doc's `bootstrap_admin_email` is the admin who needs the fixup.

2. **Fire the trigger with a throwaway write.** Open `stakes/<slug>` in the console:
   - Add a field named `_touch`, type string, any value (e.g. `backfill`) → Save.
   - Delete the `_touch` field → Save.

   Either the add or the delete alone fires `onDocumentWritten` and mints the claim; doing both just leaves the doc exactly as it was before. Don't try to "fix" this by re-saving an existing field with the same value — the console may not register that as a change, and an unchanged doc doesn't re-fire the trigger.

3. **Verify the marker landed**, from your laptop, against the affected project:

   ```bash
   out=$(mktemp).json
   firebase auth:export "$out" --project prod   # or: --project staging
   jq --arg email "<bootstrap_admin_email, exactly as stored>" \
     '.users[] | select(.email==$email) | .customAttributes' "$out"
   rm -f "$out"
   ```

   `firebase auth:export` infers the export format from the target file's
   extension and errors out before exporting anything if it can't
   (`firebase-tools/lib/accountExporter.js`'s `validateOptions`) — a bare
   `$(mktemp)` has no extension, so the `.json` suffix above is load-bearing,
   not decorative.

   Expected: a JSON string with `"bootstrap":true` nested under the affected stake's id, e.g.:

   ```
   "{\"canonical\":\"...\",\"stakes\":{\"<slug>\":{\"manager\":false,\"stake\":false,\"wards\":[],\"bootstrap\":true}}}"
   ```

   If `stakes.<slug>` is absent, or present without `bootstrap`, the write in step 2 didn't register as a change — repeat step 2 with a different scratch value.

4. **Tell the admin to get a fresh ID token — a re-login, not a reload.** `applyBootstrapClaim`'s `writeClaims` (`functions/src/lib/applyClaims.ts`) revokes the user's refresh tokens whenever their claims change, same as every other claims-writing trigger in this repo. That means the admin's current session cannot pick the new claim up quietly on its next silent token refresh — the revoked refresh token makes that refresh fail. Have them sign out, close every tab open on the origin, and sign back in; that mints a new ID token and a new refresh token together, and they should land on the bootstrap wizard instead of "Not Authorized."

## One-time fixup: grant `kindoo-app` token-creator on itself after PR #282

**Run this once per project, before or right after the deploy that first ships `mintExtensionToken`, then cross it off.** Not a recurring deploy step — it's an IAM grant neither `kindoo-staging` nor `kindoo-prod` received at provisioning time, because the need arrived with the extension's email sign-in path. Under Application Default Credentials `createCustomToken` signs through the IAM `signBlob` API, so the runtime SA has to hold token-creator **on itself**. Nothing local or in CI catches the gap — the emulator substitutes an unsigned token — and in a deployed environment every email sign-in fails with `Sign-in failed: web sign-in failed (mint_failed)`.

```bash
for PROJECT in kindoo-staging kindoo-prod; do
  gcloud iam service-accounts add-iam-policy-binding \
    "kindoo-app@$PROJECT.iam.gserviceaccount.com" \
    --member="serviceAccount:kindoo-app@$PROJECT.iam.gserviceaccount.com" \
    --role="roles/iam.serviceAccountTokenCreator" \
    --project="$PROJECT"
done
```

Expected: two `Updated IAM policy for serviceAccount [kindoo-app@<project>.iam.gserviceaccount.com].` lines, each followed by a policy listing `roles/iam.serviceAccountTokenCreator`. Idempotent — safe to re-run.

Verify, and read the rationale, in `infra/runbooks/provision-firebase-projects.md` §5.2.1 and §1.8. That's where the grant lives for any project provisioned from here on.

## One-time: confirm the `reconcileAuditGaps` deletion prompt (T-102)

**Answer this once per project — staging and prod each prompt on their own first deploy after the merge, then cross it off.** The scheduled audit-reconcile job is gone from source (T-102; audit fan-in is covered by trigger retries instead), so the first `pnpm deploy:staging` and the first `pnpm deploy:prod` after that merge each find a deployed function with no source export and ask:

```
The following functions are found in your project but do not exist in your local source code:
	reconcileAuditGaps(us-central1)
? Would you like to proceed with deletion? Selecting no will continue the rest of the deployments. (y/N)
```

Answer **y** on each project. Deleting the function also deletes the Cloud Scheduler job that invoked it — that deletion, not the source removal, is what frees the two scheduler slots (one per project).

> Those two slots are spent again by T-104's `dispatchScheduledTasks`, which claims one per project. See "First deploy after T-104" below for the accounting; the allocation is now full.

If you answer no, the deploy still succeeds and the function stays live with nothing to invoke it. The backstop is the post-deploy check: `lib/verify-deploy.sh`'s source-vs-deployed diff reports `warning: deployed but not exported from source` for `reconcileAuditGaps` on every subsequent deploy until you take the prompt. Clear it by re-deploying and answering y, or delete the function directly:

```bash
firebase functions:delete reconcileAuditGaps --region us-central1 --project staging   # or: --project prod
```

## First deploy after T-104: a scheduler job and a task queue appear

**Walk this once per project — staging and prod each need it on their first deploy after T-104 merges — then cross it off.** It is not a recurring deploy step. T-104 adds two functions of kinds this project has not deployed before, and each brings a piece of Google Cloud infrastructure that `firebase deploy` creates as a side effect:

| Export | Kind | Side effect of the first deploy |
|---|---|---|
| `dispatchScheduledTasks` | `onSchedule`, cron `0 * * * *`, `Etc/UTC` | A **Cloud Scheduler job** named after the function, in `us-central1`. |
| `runScheduledTask` | `onTaskDispatched` | A **Cloud Tasks queue** named after the function, in `us-central1`. |

Both are created by the CLI, not by you. What you have to do afterwards is confirm they exist and grant the IAM the CLI does not grant — step 3 below, which is the part that fails silently if skipped.

### The scheduler free tier is now fully spent

Cloud Scheduler's free tier is **3 jobs per billing account** — per *billing account*, not per project, so a staging and a prod copy of one job cost two slots. Both projects bill to the same account. After this deploy:

| Slot | Project | Job | Created by |
|---|---|---|---|
| 1 | `kindoo-staging` | `dispatchScheduledTasks` | `firebase deploy` |
| 2 | `kindoo-prod` | `dispatchScheduledTasks` | `firebase deploy` |
| 3 | `kindoo-prod` | `firestore-weekly-export` | operator, by hand (`provision-firebase-projects.md` §3.4) |

That is 3/3. **A future scheduled feature must not become a fourth job** — it becomes a trigger row in that stake's `stakeSchedules/{stakeId}` document, which the hourly dispatcher fans out over Cloud Tasks. Routing new work through the dispatcher instead of through `onSchedule` is the entire reason T-104 exists; a new `onSchedule` export would create a fourth job on each project it deploys to and start billing. Cloud Tasks has its own free tier — 1M operations/month — which at one dispatch per stake per hour this stack cannot approach.

### 1. Confirm the Cloud Scheduler job

```bash
gcloud scheduler jobs describe firebase-schedule-dispatchScheduledTasks-us-central1 \
  --project=kindoo-staging --location=us-central1 \
  --format="value(state,schedule,timeZone)"
```

Expected: `ENABLED	0 * * * *	Etc/UTC`.

The job name is derived by the CLI, not chosen by you: `firebase-schedule-<export name>-<region>`, and for a 2nd-gen function the job's location is the function's own region (`scheduleIdForFunction` and `upsertScheduleV2` in `firebase-tools` 15.18.0). A later CLI version could derive it differently, so if that name is not found, list rather than guess:

```bash
gcloud scheduler jobs list --project=kindoo-staging --location=us-central1
```

Expected: one row whose name contains `dispatchScheduledTasks`. On prod the same list shows **two** rows — that one plus `firestore-weekly-export`, which is operator-created and is not a Function. Repeat both commands with `--project=kindoo-prod`.

### 2. Confirm the Cloud Tasks queue

The queue is named after the function, in the function's region:

```bash
gcloud tasks queues describe runScheduledTask \
  --project=kindoo-staging --location=us-central1 \
  --format="value(name,state)"
```

Expected: `projects/kindoo-staging/locations/us-central1/queues/runScheduledTask	RUNNING`. Repeat with `--project=kindoo-prod`.

That name is what the code addresses — `dispatchScheduledTasks` enqueues via `taskQueue('runScheduledTask')`, and the repo pins no region anywhere, so 2nd-gen's `us-central1` default applies. **Verify it rather than assume it**: the CLI's queue provisioning has no local equivalent and is first exercised on this deploy, so if `describe` says `NOT_FOUND`, list before concluding anything is broken:

```bash
gcloud tasks queues list --project=kindoo-staging --location=us-central1
```

If a queue is there under another name or region, note it — the runner's own address is what matters, and a mismatch between it and what the dispatcher enqueues to is the bug. If there is genuinely no queue, the deploy did not get as far as provisioning it. Redeploy that one function and read the output rather than re-running the whole deploy:

```bash
firebase deploy --only functions:runScheduledTask --project staging
```

### 3. Grant the enqueue IAM — the CLI does not do this for you

**This is the step that fails silently.** Verified against the CLI and SDK versions this repo deploys with (`firebase-tools` 15.18.0, `firebase-functions` 7.3.2) by reading their source, because the published documentation does not state it either way:

- `firebase-tools`' `upsertTaskQueue` (`lib/deploy/functions/release/fabricator.js`) always creates the queue, but calls `setEnqueuer` — the function that writes `roles/cloudtasks.enqueuer` onto the queue's IAM policy — **only when the endpoint declares an explicit `invoker`**.
- `firebase-functions`' `onTaskDispatched` (`lib/v2/providers/tasks.js`) copies `invoker` onto the endpoint with `convertIfPresent`, i.e. only when the developer passes one.

So with a plain `onTaskDispatched` and no `invoker` option, the queue is created and **no principal is granted permission to enqueue onto it**. Nothing fails at deploy; every hourly dispatch then fails at runtime with `PERMISSION_DENIED`.

Two bindings are needed. The **member** is `kindoo-app@<project>` (the dispatcher's runtime service account) in both, but the **resource** differs, and neither is project-wide:

**(a) `roles/cloudtasks.enqueuer`, on the queue resource.** Permission to create tasks in it.

**(b) `roles/iam.serviceAccountUser`, on the `kindoo-app@` service-account resource — that is, on itself.** Cloud Tasks' [`OidcToken`](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/OidcToken) reference requires the caller creating an HTTP-target task to hold `iam.serviceAccounts.actAs` on the service account named in the token, and Google documents no exception for the case where the caller *is* that account — which is our case, because `firebase-admin`'s task client stamps the OIDC token with the app's own resolved service account. `roles/iam.serviceAccountUser` is the predefined role that carries `actAs`.

> **This is a second, distinct self-binding — it does not replace the D33 one.** `kindoo-app@` already holds `roles/iam.serviceAccountTokenCreator` on itself (for `mintExtensionToken`; see the PR #282 section above). That role carries `signBlob` / `signJwt` / `getOpenIdToken` and **not** `actAs`, so it does not satisfy (b), and (b) does not satisfy it. Both must be present. When tidying IAM under T-26, revoke neither.

Check what is already there before granting anything:

```bash
for PROJECT in kindoo-staging kindoo-prod; do
  echo "--- $PROJECT: queue policy ---"
  gcloud tasks queues get-iam-policy runScheduledTask \
    --project="$PROJECT" --location=us-central1 \
    --format="value(bindings.role)"
  echo "--- $PROJECT: kindoo-app SA policy ---"
  gcloud iam service-accounts get-iam-policy \
    "kindoo-app@$PROJECT.iam.gserviceaccount.com" \
    --project="$PROJECT" --format="value(bindings.role)"
done
```

Expected once both bindings are in place: the queue policy prints `roles/cloudtasks.enqueuer`, and the SA policy prints **both** `roles/iam.serviceAccountTokenCreator` and `roles/iam.serviceAccountUser`. If the queue policy is empty — the likely outcome, per the source reading above — grant the missing ones:

```bash
for PROJECT in kindoo-staging kindoo-prod; do
  gcloud tasks queues add-iam-policy-binding runScheduledTask \
    --project="$PROJECT" --location=us-central1 \
    --member="serviceAccount:kindoo-app@$PROJECT.iam.gserviceaccount.com" \
    --role="roles/cloudtasks.enqueuer"
  gcloud iam service-accounts add-iam-policy-binding \
    "kindoo-app@$PROJECT.iam.gserviceaccount.com" \
    --member="serviceAccount:kindoo-app@$PROJECT.iam.gserviceaccount.com" \
    --role="roles/iam.serviceAccountUser" \
    --project="$PROJECT"
done
```

Expected: four `Updated IAM policy for ...` lines, each followed by the new policy. Idempotent — safe to re-run, and safe to run even if the CLI turns out to have granted (a) already.

**The third binding you do not need to add: invoker on the runner.** Cloud Tasks calls `runScheduledTask`'s Cloud Run service carrying an OIDC token for `kindoo-app@`, so that account needs `roles/run.invoker` on it. `kindoo-app@` already holds `roles/run.invoker` **at the project level** from provisioning (`provision-firebase-projects.md` §1.8), which covers every Cloud Run service in the project including this one. Confirm rather than assume:

```bash
gcloud projects get-iam-policy kindoo-staging \
  --flatten="bindings[].members" \
  --filter="bindings.members:kindoo-app@kindoo-staging.iam.gserviceaccount.com AND bindings.role:roles/run.invoker" \
  --format="value(bindings.role)"
```

Expected: `roles/run.invoker`. Empty output means step 1.8 was not completed on that project — fix it there, not here.

### 4. Confirm a dispatch actually happened — and expect nothing to run

Wait for the top of the next hour, then:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dispatchscheduledtasks"' \
  --project=kindoo-staging --limit=20 --freshness=2h \
  --format="value(timestamp,severity,jsonPayload.message)"
```

Expected: at least one entry from the last hour, ending in `dispatchScheduledTasks: done`, and none at `ERROR`. That `done` line carries the run summary — `{ stakes, seeded, enqueued, deduped, failures }` — and it is the only line that proves a walk completed rather than merely started.

The service name is **lowercased** — Cloud Run service names are RFC1123, so the export `dispatchScheduledTasks` logs under `dispatchscheduledtasks`. Filtering on the camelCase name matches nothing and looks exactly like "the dispatcher never ran."

To force a run without waiting, use the job name from step 1:

```bash
gcloud scheduler jobs run <job-name-from-step-1> \
  --project=kindoo-staging --location=us-central1
```

No output on success. An empty log read after a forced run, with the job reporting `ENABLED`, is the failure that step 3 exists to prevent — read `runScheduledTask`'s logs too, and see `infra/runbooks/observability.md` "Scheduled-task dispatch."

> **On the deploy that first ships the dispatcher, `{ stakes: N, seeded: 0, enqueued: 0, deduped: 0, failures: 0 }` is the whole expected result — and `stakeSchedules` does not appear at all.** The job registry (`functions/src/lib/taskRegistry.ts`) ships empty, so there is nothing to seed onto a stake, and the dispatcher only writes a stake's document when it seeds or stamps something. An absent `stakeSchedules` collection is therefore the healthy outcome here, not evidence that anything failed. **Do not go looking for documents on this deploy, and do not read their absence as a broken Scheduler job or a missing IAM grant.**
>
> The `dispatchScheduledTasks: done` line from step 4 is the only proof of life until a job is registered. That is what you are checking for; there is nothing else to see.
>
> **What this deploy does NOT prove: step 3's two IAM grants.** Nothing is enqueued, so neither `cloudtasks.enqueuer` nor the `serviceAccountUser` self-binding is exercised, and `enqueued: 0` reads identically whether both grants are in place or neither is. Registering a job does not settle it either — seeded rows arrive `enabled: false`, so the first real enqueue is the first time somebody flips one on. **Do that on staging first**: enable one job there, wait for the next hourly tick, and confirm a `runScheduledTask` invocation actually appears. Until that round trip has been seen once, treat the grants as unverified, and do not let the first `enabled: true` in the estate be a prod console edit.
>
> **What changes when a job is first registered** (the sync-reminder PR is the first): the dispatcher **self-seeds** on its next hourly pass, writing the new entry onto every stake including ones that predate the job — there is no backfill to run and `createStake` seeds nothing. Every seeded trigger arrives `enabled: false`, so `enqueued` stays 0 until somebody opts a stake in by flipping that flag. From that deploy onward the check becomes "did the documents appear": an hour on, `stakeSchedules` should hold one document per stake, and if it is still empty the dispatcher is not running — go back to step 1.

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

The container is failing to start or crashing on request. The historical cause was a runtime dependency missing from the generated `functions/lib/package.json`: Cloud Build ran its own `npm install` against that manifest with no lockfile, and an optional peer dependency npm decided to skip took every function down at container start.

```bash
gcloud run services logs read <lowercased-function-name> \
  --region us-central1 --project kindoo-staging --limit 50
```

Look for `Cannot find module` at the top of the container log.

T-73 closed that hole: `functions/lib/package-lock.json` now ships with the artifact and pins the whole transitive tree, so npm no longer makes resolution decisions at deploy time. A `Cannot find module` after this should be rare and means something new — a genuinely undeclared dependency, or an import the bundle left external that nothing pins. Check the module against `functions/deploy-lock/package-lock.json` first:

```bash
node -e "const l=require('./functions/deploy-lock/package-lock.json'); console.log(Object.keys(l.packages).filter(p=>p.includes('<module-name>')))"
```

If it is absent from the lockfile, it must be declared in `functions/package.json` dependencies (that workspace is `backend-engineer`'s — file it in `docs/TASKS.md`), then `pnpm install && pnpm deps:relock`. If it IS in the lockfile, the artifact was built before the lockfile landed or the deploy skipped the predeploy hook — rebuild and redeploy.

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

   **Nothing in CI runs this file** — this manual step is the only gate on it, so run it whenever you touch either script. Two of its lines carry state you should read rather than skim: the `./scheduled/` and `./tasks/` misclassification guards print how many exports of each class they examined, and `0 exports under ...` means the guard found nothing to check in the live `index.ts` and fell back to its fixtures. That is correct on a branch that predates T-104 and wrong on `main` after it.

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

## Manual verification of the deploy dependency pinning

Run these after any change to `functions/package.json` dependencies, `functions/scripts/build.mjs`, or `functions/scripts/*deploy-deps*.mjs`. None of them touch a Firebase project.

1. **Drift check.**

   ```bash
   pnpm deps:check
   ```

   Expected: the `deploy-lock check: OK` table shown under "Deploy dependency pinning" above, exit 0.

2. **Build emits all three artifacts.**

   ```bash
   pnpm --filter @kindoo/shared build && pnpm --filter @kindoo/functions build
   ls functions/lib
   ```

   Expected last build line: `External (Cloud Build \`npm ci\` installs): @firebase/app@0.14.13, firebase-admin@13.10.0, ...` (versions will differ) — exact versions, no carets. `ls` must show `index.js`, `index.js.map`, `node_modules` (symlink), `package.json`, `package-lock.json`.

3. **Reproduce Cloud Build's install.** This is the only local way to prove the artifact installs; `firebase deploy` cannot be dry-run through Cloud Build.

   ```bash
   work=$(mktemp -d)
   rsync -a --exclude node_modules functions/lib/ "$work/"
   npm ci --no-audit --no-fund --prefix "$work"
   ```

   Expected: `added <N> packages`, exit 0. `npm ci` validates the lockfile against `lib/package.json`, so success proves the copied lockfile covers the generated manifest.

   Note the check is one-directional, measured on npm 10.9.7: `npm ci` errors when the manifest declares something the lockfile lacks (`EUSAGE`) or the pin does not satisfy the declared range (`ERESOLVE`), but it **passes and silently omits** a dependency the manifest dropped. That last case is the outage's exact shape, so a green `npm ci` is not on its own evidence the artifact is correct — step 1 is. Run both.

4. **Load the modules that failed in the outage.**

   ```bash
   (cd "$work" && for m in firebase-functions firebase-functions/v1 firebase-admin/database; do
      node -e "require('$m')" && echo "OK $m"; done)
   ls "$work/node_modules/@firebase/app"
   rm -rf "$work"
   ```

   Expected: three `OK` lines and a populated `@firebase/app` directory. Cloud Functions loads the whole of `index.js` in every container and the 1st-gen `onAuthUserCreate` pulls `firebase-functions/v1`, which eagerly loads `firebase-admin/database` — so these three are the container-start canaries.

5. **Emulator still resolves through the symlink.** `functions/lib/node_modules` is a symlink to the workspace install; the new `lib/package-lock.json` must not disturb it.

   ```bash
   printf 'WEB_BASE_URL=https://kindoo-staging.web.app\n' > functions/.env.demo-kindoo-tests
   npx --yes firebase-tools emulators:exec --only functions,firestore,auth \
     --project demo-kindoo-tests "true"
   rm -f functions/.env.demo-kindoo-tests functions/lib/.env.demo-kindoo-tests
   ```

   Expected: `functions: Loaded functions definitions from source: ...` listing all 24 exports, then `Script exited successfully (code 0)`.

6. **Live path.** Which install command the GCP Node.js buildpack chooses for this artifact is only observable in a real deploy. The buildpack runs `npm ci` when it finds a `package-lock.json` beside the manifest; either path installs the pinned tree, since a present lockfile also constrains `npm install`. On the first deploy after this landed, read the Cloud Build log's install line and confirm it names the lockfile and reports the pinned package count.

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

- **Which stake runs which scheduled job** — that is data, not deploy config: the trigger rows in `stakeSchedules/{stakeId}`, self-seeded by the dispatcher on its next hourly pass and then opted in by a manager. Deploy owns only the two pieces of plumbing above (the hourly Cloud Scheduler job and the Cloud Tasks queue), and neither changes when a stake enables or disables a job. There is no seeding step to run and no backfill. See `docs/TASKS.md` T-104.
- **Secret Manager updates** — see `infra/runbooks/resend-api-key-setup.md` for the Resend key; add a similar runbook when a new secret is introduced.
- **Custom-domain / DNS setup** — `infra/runbooks/custom-domain.md`.
- **Runtime SA grants on the roster Sheet** — `infra/runbooks/granting-importer-sheet-access.md` (deprecated; T-45 removed the importer).
