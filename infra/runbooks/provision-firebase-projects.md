# Runbook: Provisioning the Firebase projects (B1)

End-to-end setup of the two Firebase projects this migration depends on:

- `kindoo-staging` — rehearsal environment; matches prod in shape, holds throwaway data.
- `kindoo-prod` — live environment; PITR enabled, weekly backups, holds real data once Phase 11 cutover lands.

This runbook is **B1** in `docs/firebase-migration.md`. It blocks Phase 2 acceptance — until both projects exist with billing, services, Firestore, Auth, and a runtime service account, the deploy scripts and emulator-to-cloud workflows have nothing to point at.

> **Audience:** the operator (Tad). You'll click through the Firebase + Google Cloud consoles and run gcloud / firebase CLI commands at your terminal. No code changes are involved here — once both projects exist, the repo's existing `.firebaserc` already names them and `infra/scripts/deploy-*.sh` will resolve them via the alias.

> **Estimated time:** ~90 minutes end-to-end if you've never done this before, broken roughly as: 5 min pre-flight, 25 min staging project, 25 min prod project (faster the second time), 15 min PITR + weekly export on prod, 15 min cross-project tidy + verification. Plan to do staging start-to-finish first, verify it, *then* repeat for prod — don't ping-pong.

## Conventions in this runbook

- Commands shown in fenced code blocks are intended to be copy-pasted at your shell. Substitute `<PROJECT_ID>` with `kindoo-staging` or `kindoo-prod` as appropriate; the runbook calls out which one.
- "Firebase console" means <https://console.firebase.google.com>; "GCP console" means <https://console.cloud.google.com>. Same underlying project, two UIs that show different facets. Some settings only exist in one or the other.
- Where a step is **prod-only** or **staging-only** it's flagged in bold. Most steps run identically against both projects.

---

## Phase 0 — Pre-flight checks (do once, before either project)

These are the shared prerequisites. Confirm all five before touching either project; otherwise you'll hit a wall partway through Phase 1.

### 0.1 Google account

You'll be using the Google account you're already signed into when you visit <https://console.firebase.google.com>. Personal (`@gmail.com`) or Workspace accounts both work — Firebase doesn't care. Confirm you're signed in as the account that should *own* both projects long-term. You can transfer ownership later via IAM, but it's friction; pick the right account up front.

### 0.2 Billing account

Firebase's free Spark plan does not allow Cloud Functions deploys, Cloud Scheduler jobs, or the Sheets API call the importer will eventually make. Per F1 in `docs/firebase-migration.md`, this stack requires the **Blaze (pay-as-you-go) plan** on both projects. Blaze requires a Google Cloud billing account with a payment method attached.

To check:

1. Open <https://console.cloud.google.com/billing>.
2. If you see a billing account listed with a green "Active" status and a payment method, you're set — note its name (e.g., "My Billing Account") and ID (e.g., `01ABCD-234EFG-567HIJ`); you'll link it twice in Phase 1 step 2.
3. If not, click "Create account" and follow the wizard. You'll need a credit card. Google's billing setup docs are at <https://cloud.google.com/billing/docs/how-to/manage-billing-account>.

At our request volume (1–2 requests/week per `docs/spec.md` §1) the actual monthly cost on both projects combined is expected to be well under $1, mostly Cloud Storage for backups. Phase 1 step 2 sets a $1 budget alert as a tripwire — it doesn't cap spending, just notifies if something is unexpectedly running up costs.

### 0.3 gcloud CLI installed and authenticated

Run:

```bash
gcloud --version
gcloud auth list
```

Expected:

- `gcloud --version` prints something like `Google Cloud SDK 482.0.0` (any reasonably recent version is fine).
- `gcloud auth list` shows the same Google account you're using for Firebase, with `*` next to it indicating it's the active account.

If gcloud isn't installed, follow <https://cloud.google.com/sdk/docs/install>. After install, run `gcloud auth login` and follow the browser flow.

### 0.4 firebase CLI installed and authenticated

Run:

```bash
which firebase
firebase --version
firebase login:list
```

Expected:

- `which firebase` returns a path like `/Users/<you>/projects/Kindoo/node_modules/.bin/firebase` (when run in this repo) or a similar small Node shim from `~/.nvm/...` or `~/.config/...` if installed via npm globally. The path should NOT be `/usr/local/bin/firebase` or anywhere it's a 250+ MB standalone binary — the standalone pkg-bundled `firebase` cannot `require()` ESM packages and breaks `firebase emulators:exec` against modern Vitest. See `docs/TASKS.md` `[T-02]` for the full footgun writeup.
- `firebase --version` prints a version like `13.27.0` (any 13.x is fine).
- `firebase login:list` shows the Google account you're using. If empty, run `firebase login`.

If `which firebase` returns the standalone binary, **uninstall it before continuing**. Either:

- Drag `/Applications/firebase` to the Trash (if you installed via the macOS pkg), or
- `sudo rm /usr/local/bin/firebase` (if you installed via shell script — verify the file is large first; the npm shim is small).

The repo includes `firebase-tools` as a dev dependency, so once you've run `pnpm install` at the repo root you have a working `firebase` via `pnpm exec firebase ...` or via the path-resolved shim from `node_modules/.bin/`.

### 0.5 You're at the repo root

Open a terminal at `/Users/<you>/projects/Kindoo` (or wherever you've cloned this repo). Most commands in this runbook assume you're either at the repo root or running gcloud/firebase commands that don't depend on cwd.

```bash
pwd
git rev-parse --show-toplevel
```

Both should print the same absolute path to the repo root.

---

## Phase 1 — Provision `kindoo-staging`

Run these in order. Don't move on to prod until staging is fully verified — every problem you'll hit on prod is something you'd rather hit on staging first.

### 1.1 Create the Firebase project

1. Open <https://console.firebase.google.com>.
2. Click "Add project" (or "Create a project" if your project list is empty).
3. **Project name:** `kindoo-staging`. Firebase will derive the project ID from the name; verify the auto-derived ID is exactly `kindoo-staging` and not something like `kindoo-staging-c4b2a`.
   - **If the ID `kindoo-staging` is taken** (very rare, but possible since project IDs are global), pick the next-best ID Firebase suggests, note it down, and update `.firebaserc` later in step 2.10. Common fallback: `kindoo-staging-1` or similar.
4. Click "Continue."
5. **Google Analytics:** click the toggle to **disable** it. We don't use Analytics; enabling it adds an extra wizard step now and a sub-project to manage forever. (Re-enabling later is a single console click if we ever want it.)
6. Click "Create project." Wait ~30s for provisioning.
7. Click "Continue" when the green check appears.

You're now on the project's Firebase console home page, sometimes called the project dashboard.

### 1.2 Capture the project number

Firebase shows the project number in two places. Find it now and write it down — you'll need it for step 1.6 (the default compute service account uses the project number, not the project ID).

1. Click the gear icon (top left, next to "Project Overview") → "Project settings."
2. The General tab shows "Project ID" (= `kindoo-staging`) and "Project number" (= a 12-digit number, e.g., `123456789012`). Note the project number.
3. The same page also has a "Web API key" — ignore for now; you'll capture per-app config in step 1.10.

### 1.3 Upgrade to Blaze plan + set $1 budget alert

1. Still on the Firebase console, click the gear icon → "Usage and billing."
2. Click the "Details & settings" tab → "Modify plan."
3. In the plan picker, click "Select plan" under **Blaze (Pay as you go)**.
4. Link the billing account you confirmed in step 0.2.
5. **Budget alert:** Firebase's plan picker offers a one-click "Set budget alert" during this flow. Set it to **$1**. (If you skip it here, you'll set it via the GCP console next.)
6. Click "Purchase."

You're now on Blaze. The console will show "Spark → Blaze" briefly then refresh.

**To verify (and tighten) the budget alert:**

1. Open <https://console.cloud.google.com/billing/budgets?project=kindoo-staging>.
2. If a $1 budget already exists, click into it; otherwise click "Create budget."
3. Set:
   - **Name:** `kindoo-staging budget`.
   - **Time range:** monthly.
   - **Target amount:** $1.
   - **Threshold rules:** alerts at **50%, 90%, 100%** of budget. (The default is 50/90/100; just confirm it's set.)
   - **Email alerts to billing admins and users:** check this so Tad's account gets the email.
4. Save.

Note: the budget **alerts** but does not cap spending. If something goes badly wrong the project can run up costs past $1; the alert is just a notification, not a circuit breaker. At our scale this hasn't been a concern, but keep an eye out.

### 1.4 Set the active gcloud project

Before running the service-enable commands in step 1.5, point gcloud at this project:

```bash
gcloud config set project kindoo-staging
gcloud config list
```

Expected: `gcloud config list` shows `project = kindoo-staging` under `[core]`.

### 1.5 Enable required services

Paste this whole block at your shell:

```bash
gcloud services enable \
  firestore.googleapis.com \
  identitytoolkit.googleapis.com \
  firebase.googleapis.com \
  firebasehosting.googleapis.com \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  fcm.googleapis.com \
  fcmregistrations.googleapis.com \
  sheets.googleapis.com \
  secretmanager.googleapis.com \
  eventarc.googleapis.com \
  pubsub.googleapis.com
```

Expected: a single line `Operation "operations/acat...n3" finished successfully.` after ~30–90s. If it hangs longer than 2 minutes, Ctrl-C and re-run; the API enable operation is idempotent.

What each API does for us:

| API | Why we need it |
| --- | --- |
| `firestore.googleapis.com` | Native-mode Firestore database; the entire data layer. |
| `identitytoolkit.googleapis.com` | Firebase Authentication backend. |
| `firebase.googleapis.com` | Firebase project metadata + management API; the CLI uses it. |
| `firebasehosting.googleapis.com` | Hosts the SPA at `kindoo-staging.web.app` with auto-provisioned HTTPS (per F10). |
| `cloudfunctions.googleapis.com` | Cloud Functions 2nd-gen — auth triggers, claim-sync, audit fan-out, importer, expiry. |
| `cloudbuild.googleapis.com` | Cloud Functions 2nd-gen builds via Cloud Build under the hood. |
| `run.googleapis.com` | Cloud Functions 2nd-gen *runs* on Cloud Run (per F1). |
| `cloudscheduler.googleapis.com` | Hourly importer + hourly expiry + nightly audit-reconcile (per F8 / Phase 8). |
| `fcm.googleapis.com` | Firebase Cloud Messaging — push notifications (Phase 10). |
| `fcmregistrations.googleapis.com` | FCM device-registration API (Phase 10). |
| `sheets.googleapis.com` | The importer reads the LCR callings sheet (Phase 8). |
| `secretmanager.googleapis.com` | Resend API key + any other secrets (Phase 9 onward). |
| `eventarc.googleapis.com` | Firestore-trigger plumbing for 2nd-gen Functions (used by audit + claim-sync). |
| `pubsub.googleapis.com` | Pub/Sub backs Cloud Scheduler delivery to Pub/Sub-targeted Functions; required even if jobs use HTTP targets. |

### 1.5.1 Initialize Firebase Hosting via the console

After the API is enabled, you must also "initialize" Hosting via the Firebase Console for the default site to actually serve traffic. Without this step, `firebase deploy --only hosting` succeeds at upload but `kindoo-staging.web.app` returns "Site Not Found."

1. Open <https://console.firebase.google.com/project/kindoo-staging/hosting/sites/kindoo-staging>.
2. Click "Get Started." Walk the wizard:
   - Step 1 (Install Firebase CLI): already done; click Next.
   - Step 2 (Initialize project): already done via `.firebaserc`; click Next.
   - Step 3 (Deploy): click Finish/Continue. The wizard's "Deploy" step is satisfied either by an immediate `firebase deploy --only hosting` afterward or by accepting that you'll deploy via CI/script.
3. After the wizard completes, the URL `kindoo-staging.web.app` will resolve (may need 1–2 minutes for CDN propagation).

### 1.6 Create the Firestore database

Per F8/F9 we use Native mode in `us-central1` (matches the stake's `America/Denver` script-tz bias). **The region is immutable** — to change it later you'd have to delete the project and recreate. Triple-check before clicking.

1. Firebase console → "Firestore Database" in the left nav → "Create database."
2. **Database ID:** if the console prompts you for a name, leave it as `(default)`. Do **not** type the project ID (e.g., `kindoo-prod`) — that creates a *named* database instead of the default one, and every Firebase SDK + tutorial assumes you're talking to `(default)`. Threading an explicit `databaseId` through Web SDK init, Functions, rules deploys, and the export job is a forever-tax you don't want. If the console only shows a name field with the project ID prefilled, clear it and type `(default)` (with the parens).
3. **Mode:** Native mode. (NOT Datastore mode — that's a different product.)
4. Click "Next."
5. **Location:** `nam5 (us-central)` from the Multi-region section, OR `us-central1 (Iowa)` from the Region section. **Per F8 we want the regional `us-central1`** — it's cheaper than multi-region and our scale doesn't justify multi-region failover. Click `us-central1`.
6. Click "Next."
7. **Security rules starting mode:** "Start in production mode" (auto-locks all reads/writes). Phase 1's `firestore/firestore.rules` stub is `allow read, write: if false;` which will overwrite this on first deploy regardless, but starting locked-down is safer than starting open.
8. Click "Create." Wait ~60s.

The database is now provisioned. The Firestore tab will show an empty database.

**Verify the name:** before moving on, confirm the database is `(default)`, not project-id-named:

```bash
gcloud firestore databases list --project=<PROJECT_ID> --format="value(name)"
```

Expected: a single line ending in `databases/(default)`. If it ends in `databases/<PROJECT_ID>` instead, you got a named database. Recreate as `(default)`:

```bash
gcloud firestore databases delete --database=<PROJECT_ID> --project=<PROJECT_ID>
gcloud firestore databases create \
  --database='(default)' \
  --location=us-central1 \
  --type=firestore-native \
  --project=<PROJECT_ID>
```

### 1.7 Enable Firebase Authentication + Google sign-in

1. Firebase console → "Authentication" in the left nav → "Get started."
2. The "Sign-in method" tab opens. Click "Google" under "Additional providers."
3. Toggle **Enable** to on.
4. **Project public-facing name:** `Stake Building Access`. (This shows in the Google sign-in popup.)
5. **Project support email:** your operator email.
6. Click "Save."

Now configure authorized domains:

7. Still in the Authentication console, click the "Settings" tab → "Authorized domains."
8. The list should already include `localhost` and `kindoo-staging.firebaseapp.com`. Confirm both are present.
9. Click "Add domain" → enter `kindoo-staging.web.app` → "Add." (Firebase Hosting serves at both `*.firebaseapp.com` and `*.web.app`; auth needs both authorized.)
10. The eventual custom domain `stakebuildingaccess.org` (per F17; registration + DNS verification in B2) will be added here at Phase 11 cutover. Don't add it now — DNS records are not yet pointing it at Firebase Hosting.

### 1.8 Create the runtime service account `kindoo-app`

This is the explicit-credentials service account for any code path that uses the Admin SDK with a service-account key (notably the Sheets API client in the importer; Phase 8 work). It's distinct from the default Cloud Functions compute SA — see step 1.9 for that.

```bash
gcloud iam service-accounts create kindoo-app \
  --display-name="Stake Building Access runtime service account" \
  --project=kindoo-staging
```

Expected output: `Created service account [kindoo-app].`

If the SA already exists (you re-ran the runbook), gcloud prints `ERROR: ... ALREADY_EXISTS: Service account kindoo-app@... already exists.` That's fine; skip and move on.

Now grant it the three roles from F1 / Phase 1:

```bash
for ROLE in \
  roles/datastore.user \
  roles/secretmanager.secretAccessor \
  roles/run.invoker; do
  gcloud projects add-iam-policy-binding kindoo-staging \
    --member="serviceAccount:kindoo-app@kindoo-staging.iam.gserviceaccount.com" \
    --role="$ROLE"
done
```

Expected: three `Updated IAM policy for project [kindoo-staging].` lines.

What each role does:

- `roles/datastore.user` — Firestore read + write via Admin SDK. (Datastore is the legacy name for the same API.)
- `roles/secretmanager.secretAccessor` — read API keys (Resend, eventually).
- `roles/run.invoker` — Cloud Functions 2nd-gen runs on Cloud Run; the invoker role is what lets Cloud Scheduler (or another Function) call it.

### 1.9 Note: the default compute SA is what Functions actually run as

This trips people up the first time. Cloud Functions 2nd-gen runs on Cloud Run, and unless you specify otherwise, each function runs under the **default compute service account**:

```
<PROJECT_NUMBER>-compute@developer.gserviceaccount.com
```

For staging, substituting your project number from step 1.2, that's e.g., `123456789012-compute@developer.gserviceaccount.com`.

`kindoo-app` is the SA for explicit-credentials operations (where code instantiates an Admin SDK client with `kindoo-app` as the impersonated identity, e.g., the Sheets API client). The Functions runtime itself uses the compute SA.

In Phase 1 the function we deploy (`hello`) needs no special permissions — it's a pure callable returning `{version, builtAt, env}`. From Phase 2 onward, when `auth.user().onCreate` writes to Firestore, the compute SA must have `roles/datastore.user` and the Functions deploy will fail without it. Add it now while you're already in IAM:

```bash
gcloud projects add-iam-policy-binding kindoo-staging \
  --member="serviceAccount:$(gcloud projects describe kindoo-staging --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --role="roles/datastore.user"
```

Expected: `Updated IAM policy for project [kindoo-staging].`

You'll also want `roles/run.invoker` and `roles/secretmanager.secretAccessor` on the compute SA before Phases 8–9; add those now too:

```bash
for ROLE in roles/run.invoker roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding kindoo-staging \
    --member="serviceAccount:$(gcloud projects describe kindoo-staging --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
    --role="$ROLE"
done
```

### 1.10 Register the web app + capture client config

The web app needs Firebase config (API key, auth domain, etc.) to talk to this project. Register it:

1. Firebase console → gear icon → "Project settings" → "General" tab.
2. Scroll to "Your apps" near the bottom. Click the web icon (`</>`) to register a web app.
3. **App nickname:** `Stake Building Access Web (staging)` or similar.
4. **Set up Firebase Hosting:** check this box. (If you skip this, Firebase auto-creates a default Hosting site at `kindoo-staging.web.app` later, but checking it now produces cleaner config.)
5. Click "Register app."
6. Firebase shows the config object — six values: `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`. **Copy these now**; you can re-display them later from the same page if needed.
7. Click "Continue to console."

Now copy the values into your local environment. The expected location and var names (per `apps/web/.env.example` and `apps/web/CLAUDE.md`):

```bash
cp apps/web/.env.example apps/web/.env.local
```

Then edit `apps/web/.env.local` and fill in:

```
VITE_FIREBASE_API_KEY=<apiKey from console>
VITE_FIREBASE_AUTH_DOMAIN=<authDomain, e.g., kindoo-staging.firebaseapp.com>
VITE_FIREBASE_PROJECT_ID=kindoo-staging
VITE_FIREBASE_APP_ID=<appId>
VITE_FIREBASE_MESSAGING_SENDER_ID=<messagingSenderId>
```

`VITE_USE_FIRESTORE_EMULATOR=` stays empty for staging/prod builds.

`apps/web/.env.local` is gitignored. Don't commit it.

The Firebase **API key is not a secret** — it's a public client identifier; security comes from rules + auth, not key secrecy. But treating it as routine-config-not-source-controlled keeps the operator habits consistent.

---

## Phase 2 — Provision `kindoo-prod`

Repeat **all of Phase 1**, substituting `kindoo-prod` everywhere `kindoo-staging` appears. Re-read each step rather than skimming — there are subtle prod-only additions in the next two phases.

In particular, do not skip step 1.5.1 (Initialize Firebase Hosting via the console) for prod. The instructions are identical:

1. Open <https://console.firebase.google.com/project/kindoo-prod/hosting/sites/kindoo-prod>.
2. Click "Get Started." Walk the wizard:
   - Step 1 (Install Firebase CLI): already done; click Next.
   - Step 2 (Initialize project): already done via `.firebaserc`; click Next.
   - Step 3 (Deploy): click Finish/Continue. The wizard's "Deploy" step is satisfied either by an immediate `firebase deploy --only hosting` afterward or by accepting that you'll deploy via CI/script.
3. After the wizard completes, the URL `kindoo-prod.web.app` will resolve (may need 1–2 minutes for CDN propagation).

Without this step, `firebase deploy --only hosting` succeeds at upload but `kindoo-prod.web.app` returns "Site Not Found."

When done, you should have:

- A `kindoo-prod` Firebase project on Blaze with $1 budget alert.
- All 14 services enabled.
- The default Hosting site initialized via the console wizard.
- A Firestore database in `us-central1` Native mode.
- Authentication with Google sign-in enabled, public name "Stake Building Access," authorized domains: `localhost`, `kindoo-prod.web.app`, `kindoo-prod.firebaseapp.com`.
- A `kindoo-app` SA with the three F1 roles.
- The default compute SA with `roles/datastore.user`, `roles/run.invoker`, `roles/secretmanager.secretAccessor`.
- A registered web app — but **do not write its config to `apps/web/.env.local`** (which holds staging). Save it somewhere safe; it will land in CI secrets or an `.env.production` later. For now, copy it into a personal-notes scratchpad and forget it.

Once Phase 2 completes, move on to Phase 3 (PITR + backups), which is **prod-only**.

---

## Phase 3 — Backup and DR (prod-only)

Per F8 / Phase 1's Backup-and-DR sub-tasks, prod gets PITR plus a weekly Firestore export to GCS. Staging doesn't need either — staging data is throwaway by design.

### 3.1 Enable PITR on `kindoo-prod`

```bash
gcloud firestore databases update \
  --database='(default)' \
  --enable-pitr \
  --project=kindoo-prod
```

Expected: `Updated database [projects/kindoo-prod/databases/(default)].`

PITR keeps a continuous 7-day window. You can read the database as of any second within that window and export that snapshot. Cost: $0.0001/GB-month for the journal — under our scale this is well under a penny per month.

The matching restore procedures live in `infra/runbooks/restore.md`.

### 3.2 Create the prod backups bucket

```bash
gcloud storage buckets create gs://kindoo-prod-backups \
  --project=kindoo-prod \
  --location=us-central1
```

Expected: `Creating gs://kindoo-prod-backups/...`

Match the Firestore region (`us-central1`) so the export job stays in-region (no cross-region traffic costs).

Now apply the 90-day lifecycle rule (per F8 / Phase 1) — keep ~12 weekly snapshots, expire older ones:

Save this lifecycle JSON to a temp file (`/tmp/lifecycle.json` or wherever). Note `gcloud storage` expects the inner object only (no wrapping `lifecycle` key — that's a `gsutil`-ism):

```json
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": 90 }
    }
  ]
}
```

Then apply:

```bash
gcloud storage buckets update gs://kindoo-prod-backups \
  --lifecycle-file=/tmp/lifecycle.json
gcloud storage buckets describe gs://kindoo-prod-backups \
  --format="value(lifecycle_config)"
```

Expected: the second command prints back the rule you just applied (something like `{'rule': [{'action': {'type': 'Delete'}, 'condition': {'age': 90}}]}`). If it prints empty, the field name may have changed — fall back to `gcloud storage buckets describe gs://kindoo-prod-backups --format=yaml | grep -A 20 lifecycle` and look for an `age: 90` entry.

### 3.3 Grant the export-runner SA permission to write to the bucket

The Cloud Scheduler job in step 3.4 invokes `firestore.googleapis.com/.../databases/(default):exportDocuments`, which runs as the project's Firestore service agent. That SA already has implicit Firestore-export permissions on its own database, but it needs explicit write access on the GCS bucket:

```bash
gcloud storage buckets add-iam-policy-binding gs://kindoo-prod-backups \
  --member="serviceAccount:service-$(gcloud projects describe kindoo-prod --format='value(projectNumber)')@gcp-sa-firestore.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

Expected: a JSON-shaped IAM policy reply. The `service-<projectnumber>@gcp-sa-firestore.iam.gserviceaccount.com` account is auto-created by Google when you enable the Firestore API; you don't need to provision it.

### 3.4 Create the weekly Firestore export Cloud Scheduler job

Per F8 / Phase 1: weekly Sunday 02:00 UTC → `gs://kindoo-prod-backups/<date>/`.

```bash
gcloud scheduler jobs create http firestore-weekly-export \
  --project=kindoo-prod \
  --location=us-central1 \
  --schedule="0 2 * * 0" \
  --time-zone="Etc/UTC" \
  --uri="https://firestore.googleapis.com/v1/projects/kindoo-prod/databases/(default):exportDocuments" \
  --http-method=POST \
  --oauth-service-account-email="kindoo-app@kindoo-prod.iam.gserviceaccount.com" \
  --message-body='{"outputUriPrefix":"gs://kindoo-prod-backups/"}' \
  --headers="Content-Type=application/json"
```

Expected: `name: projects/kindoo-prod/locations/us-central1/jobs/firestore-weekly-export ... state: ENABLED`.

Wait — the export endpoint uses the date *the job runs* as the path suffix, but only if you include `{{.ScheduleTime}}` substitution... actually, the Firestore `exportDocuments` API takes the prefix you give it and appends an auto-generated subdirectory based on the export operation ID, NOT the date. So your bucket will end up with paths like `gs://kindoo-prod-backups/2026-01-04T02:00:13_12345/`. That's fine — the lifecycle rule expires by age, not by name pattern, and the timestamp ordering is intuitive.

The `kindoo-app` SA is acting as the OAuth principal for the scheduler's HTTP call here. It needs `roles/datastore.importExportAdmin` on the project; add it now (it wasn't in step 1.8's list because only prod needs it):

```bash
gcloud projects add-iam-policy-binding kindoo-prod \
  --member="serviceAccount:kindoo-app@kindoo-prod.iam.gserviceaccount.com" \
  --role="roles/datastore.importExportAdmin"
```

To confirm the job is configured but not actually run it yet (it'll run automatically Sunday 02:00 UTC):

```bash
gcloud scheduler jobs describe firestore-weekly-export \
  --project=kindoo-prod \
  --location=us-central1
```

Expected: a YAML dump showing `state: ENABLED` and the schedule and target you set.

### 3.5 Optional: trigger an immediate test export

To verify the job actually works without waiting for Sunday:

```bash
gcloud scheduler jobs run firestore-weekly-export \
  --project=kindoo-prod \
  --location=us-central1
```

Then, after ~30s, list the bucket:

```bash
gcloud storage ls gs://kindoo-prod-backups/
```

Expected: a single subdirectory like `gs://kindoo-prod-backups/2026-04-27T18:42:11_98765/`. (At Phase 1 prod is empty, so the export will be small — just the export metadata files.)

This test export counts toward the 90-day lifecycle, but it'll just expire on its own.

---

## Phase 4 — Cross-project tidy

After both projects exist and prod has its DR setup, finalize the repo-side wiring.

### 4.1 Verify `.firebaserc` matches reality

```bash
cat .firebaserc
```

Expected:

```json
{
  "projects": {
    "default": "kindoo-staging",
    "staging": "kindoo-staging",
    "prod": "kindoo-prod"
  }
}
```

If you had to use a fallback project ID (per the warning in step 1.1), edit `.firebaserc` accordingly. Then re-verify with:

```bash
firebase use staging
firebase use prod
```

Both should print `Now using alias <name> (<project-id>).`

### 4.2 Confirm `apps/web/.env.local` is set for staging

You filled this in during step 1.10. Re-verify:

```bash
cat apps/web/.env.local | grep -v '^#' | grep -v '^$'
```

Expected: five lines populated; `VITE_USE_FIRESTORE_EMULATOR` empty.

The prod values you captured in Phase 2 step 1.10 are *not* in this file — they'll go into a CI secret store later. For now keep them in your password manager.

### 4.3 (Future) prod env handling — punted to later

Prod web-app config doesn't need to live anywhere yet. The first Phase 4 staging deploy uses staging only. When prod deploys land at Phase 11 cutover, the build pipeline will need to inject prod values via `.env.production` or CI secrets — that's a Phase 11 sub-task, not B1.

### 4.4 Pre-bootstrap stake-doc seed

**When to do this:** before the Phase 7 bootstrap admin signs into a stake for the first time. Skip until you're ready to walk a fresh stake through the Phase 7 wizard.

**Why:** the bootstrap wizard's first action is to write `stakes/{sid}/kindooManagers/{bootstrap-admin-canonical}` so `syncManagersClaims` mints the manager claim. Before that claim exists, the wizard's writes are authorised by the rule-level `isBootstrapAdmin(stakeId)` predicate, which is keyed off two fields on the parent stake doc:

- `setup_complete: false` — gates the predicate to one-shot (the wizard's final write flips this to `true` and the gate stops applying).
- `bootstrap_admin_email: <typed-form email>` — the typed-form Google identity that the wizard runs as. Compared against `request.auth.token.email`.

Without this seed, the bootstrap admin's first wizard write is denied — chicken-and-egg. The seed has to land before they sign in for the first time.

**How (Firebase console — recommended, GUI-driven):**

1. Firebase console → Firestore Database → "Start collection."
2. Collection ID: `stakes`. "Next."
3. Document ID: the stake's slug — `csnorth` for the live stake.
4. Add the following fields (all typed lowercase as field names):

   | Field | Type | Value |
   |---|---|---|
   | `stake_id` | string | `csnorth` |
   | `stake_name` | string | (whatever — the wizard Step 1 will overwrite this) |
   | `created_at` | timestamp | now |
   | `created_by` | string | the operator's canonical email |
   | `callings_sheet_id` | string | (empty string is fine — Step 1 sets this) |
   | `bootstrap_admin_email` | string | the **typed-form** email of the person who'll run the wizard, e.g. `Tad.E.Smith@gmail.com` |
   | `setup_complete` | boolean | `false` |
   | `stake_seat_cap` | number | `0` (Step 1 will overwrite) |
   | `expiry_hour` | number | `4` |
   | `import_day` | string | `MONDAY` |
   | `import_hour` | number | `6` |
   | `timezone` | string | `America/Denver` (or whichever IANA tz the stake uses) |
   | `notifications_enabled` | boolean | `true` |
   | `last_over_caps_json` | array | `[]` |
   | `last_modified_at` | timestamp | now |

   Note on `bootstrap_admin_email`: this is the **typed form**, not canonical. Match exactly what the user types in their Google account (uppercase letters, dots, plus-suffix all preserved). The rule compares against `request.auth.token.email` which Firebase Auth sets to whatever Google sends — typically the typed form as registered.

5. Click "Save."

**How (gcloud / Admin SDK — alternative, scriptable):** if you'd rather seed via an admin script, write a one-shot TypeScript file under `infra/scripts/seed-stake-doc.ts` that uses `firebase-admin` to set the doc fields above. There's no committed example today; the console path is the runbook-blessed approach.

**Verify:**

```bash
gcloud firestore documents get \
  --collection-id=stakes \
  --document-id=csnorth \
  --project=<staging-or-prod-project>
```

Expected: a JSON dump showing `setup_complete: false` and the `bootstrap_admin_email` you set.

**Once the seed is in place:** the bootstrap admin signs in via Google → SPA detects `setup_complete=false` and routes them to the wizard → the wizard works end-to-end → its final action flips `setup_complete=true`. From that point on the bootstrap-admin gate is silent and the bootstrap admin operates as a regular manager.

**Repeat per project.** Run this for `kindoo-staging` first to rehearse the wizard, then for `kindoo-prod` at Phase 11 cutover (when the live stake doc replaces the throwaway staging doc).

---

## Phase 5 — End-to-end verification

Run these commands. Every one should match its expected output. If any fails, do NOT proceed to Phase 2 / 4 work — go back and fix.

### 5.1 Both projects exist and CLI can see them

```bash
firebase projects:list
```

Expected: a table containing rows for `kindoo-staging` and `kindoo-prod`, both with "Current" or blank in the alias column.

### 5.2 Service accounts exist on both projects

```bash
gcloud iam service-accounts list --project=kindoo-staging
gcloud iam service-accounts list --project=kindoo-prod
```

Expected on each: at least three rows: `kindoo-app@<project>.iam.gserviceaccount.com`, the default compute SA `<projectnum>-compute@developer.gserviceaccount.com`, and the Firebase admin SA `firebase-adminsdk-...@<project>.iam.gserviceaccount.com`. Possibly one or two more (the Firestore service agent, Cloud Build SA, etc.) which were auto-created when you enabled APIs.

### 5.3 Required services enabled

```bash
gcloud services list --enabled --project=kindoo-staging | \
  grep -E 'firestore|cloudfunctions|firebasehosting|identitytoolkit|cloudscheduler|secretmanager'
gcloud services list --enabled --project=kindoo-prod | \
  grep -E 'firestore|cloudfunctions|firebasehosting|identitytoolkit|cloudscheduler|secretmanager'
```

Expected on each: six matching service rows. If any are missing, re-run step 1.5 for the affected project.

### 5.4 Firestore database exists

```bash
gcloud firestore databases describe \
  --database='(default)' \
  --project=kindoo-staging \
  --format="value(type,locationId)"
gcloud firestore databases describe \
  --database='(default)' \
  --project=kindoo-prod \
  --format="value(type,locationId)"
```

Expected on each: `FIRESTORE_NATIVE us-central1`.

### 5.5 PITR enabled on prod (only)

```bash
gcloud firestore databases describe \
  --database='(default)' \
  --project=kindoo-prod \
  --format="value(pointInTimeRecoveryEnablement)"
```

Expected: `POINT_IN_TIME_RECOVERY_ENABLED`.

For staging the same command will print `POINT_IN_TIME_RECOVERY_DISABLED` — that's correct, staging doesn't need PITR.

### 5.6 Backup bucket exists with lifecycle rule (prod only)

```bash
gcloud storage ls --project=kindoo-prod | grep kindoo-prod-backups
gcloud storage buckets describe gs://kindoo-prod-backups \
  --format="value(lifecycle_config)"
```

Expected: bucket listed; lifecycle output showing `'age': 90`.

### 5.7 Weekly export scheduler job exists (prod only)

```bash
gcloud scheduler jobs describe firestore-weekly-export \
  --project=kindoo-prod \
  --location=us-central1 \
  --format="value(state,schedule)"
```

Expected: `ENABLED 0 2 * * 0`.

### 5.8 Repo deploy script dry-run resolves

```bash
firebase use staging
bash infra/scripts/deploy-staging.sh --dry-run
```

Expected: every step echoed with `[dry-run]` prefix; final line `=== deploy-staging.sh complete ===`. No errors, no `Project not found` complaints.

This proves the alias resolution works end-to-end. The actual deploy doesn't run yet — that requires Phase 1 acceptance criteria from the engineering agents to be in place (workspace `build` and `test` scripts wired up).

---

## Troubleshooting

### "Project ID `kindoo-staging` already taken" during step 1.1

Project IDs are globally unique across all of Google Cloud. If `kindoo-staging` is taken (rare but possible), accept Firebase's auto-suggested fallback (typically `kindoo-staging-1`) and:

1. Note the actual project ID Firebase chose.
2. Update `.firebaserc` to point the `staging` alias at the new ID.
3. Update `infra/scripts/deploy-staging.sh` only if it has a hardcoded `--project kindoo-staging` flag (current implementation uses `--project staging` which resolves via `.firebaserc`, so no change needed).
4. Use the new ID everywhere `kindoo-staging` appears below in this runbook.

Same playbook for prod.

### "Permission denied" when running `gcloud services enable`

The most common cause is the Blaze upgrade hasn't fully propagated. Wait 60s and retry. Second-most-common: the project doesn't have a billing account linked at all — re-do step 1.3.

### "Region cannot be changed for Firestore database" after step 1.6

You created the database in the wrong region. You can't change it — you'd have to delete the entire Firebase project and recreate. **Triple-check the region before clicking Create in step 1.6.** If you've already created in the wrong region and there's no data yet (Phase 1 stage), the cheapest fix is: delete the project entirely, recreate with the right region. Phase 1 step 1.1 onward.

### "Service account `kindoo-app` already exists" during step 1.8

You're re-running the runbook. Skip the create command and proceed to the role-grant loop, which is idempotent.

### Cloud Functions deploy fails with "permission denied on Firestore" later (Phase 2+)

The default compute SA needs `roles/datastore.user` for Functions that use the Admin SDK to write Firestore. You ran step 1.9 — verify the binding still exists:

```bash
gcloud projects get-iam-policy <PROJECT_ID> \
  --flatten="bindings[].members" \
  --filter="bindings.members:<projectnum>-compute@developer.gserviceaccount.com" \
  --format="table(bindings.role)"
```

Expected: at minimum `roles/datastore.user`. If missing, re-run step 1.9.

### "Changing from an HTTPS function to a background triggered function is not allowed."

This means a previous deploy attempt failed mid-way and registered some functions with a wrong trigger type — typically because a partial-deploy failure left Firestore-document or Auth-trigger functions registered as plain HTTPS functions in the Cloud Functions registry. Recovery:

```bash
firebase functions:delete <function-names...> \
  --region us-central1 \
  --project <project-alias>
# Confirm "y" at the prompt for each (or pass --force).

firebase deploy --only functions --project <project-alias>
```

If you don't know which functions are in the bad state, use `firebase functions:list --project <project-alias>` to see all and delete the ones whose trigger type doesn't match the source code's intent.

### "$1 budget" alert is firing every month even with no real usage

Cloud Storage charges for Firestore exports show up as fractional cents. If the budget is set to $1 with 50% threshold, you'll get an alert email when the project crosses $0.50 in a month — which can happen on prod after a few months of weekly exports if the database has any size to it. Either:

- Bump the budget to $5 (still alerts on real anomalies, doesn't cry-wolf on routine backup costs), or
- Drop the 50% threshold and keep only 90% + 100%.

This is a Phase-1+ judgment call; revisit once you have a few months of actual cost data.

### `firebase use staging` says "Project not found" even after this runbook

Check `.firebaserc` matches the actual project ID. If you used a fallback ID (per the first troubleshooting entry), the alias still says `kindoo-staging` but needs to point at e.g., `kindoo-staging-1`.

### `pnpm deploy:staging --dry-run` errors at `pnpm test` or `pnpm --filter ./apps/web build`

That's not a B1 problem. Phase 1 closed with workspace `build` and `test` scripts as TODO; see `infra/runbooks/deploy.md` "Deploy script fails at `pnpm typecheck`" entry. You can confirm the deploy *script* itself parses and the alias resolves by running the bash directly:

```bash
bash -n infra/scripts/deploy-staging.sh
firebase use staging
```

Both should succeed. The pipeline middle-steps are blocked until later phases.

---

## What this runbook does NOT cover

- **Custom domain (B2 / F17)** — `stakebuildingaccess.org` chosen 2026-04-27; registration + DNS records land separately in B2 alongside Resend domain verification. Lands at the Firebase Hosting layer in Phase 11.
- **LCR Sheet sharing for the importer (B4)** — Phase 8.
- **Resend domain verification (B2 / F16)** — Phase 9.
- **Real Firestore data** — Phase 11 cutover via `infra/scripts/migrate-sheet-to-firestore.ts`.
- **CI deploy automation** — operator-triggered through the migration period; CI deploys land post-Phase-11.
- **Monitoring alert policies + log-based metrics** — separately documented in `infra/runbooks/observability.md` and applied by gcloud commands once B1 lands. They're orthogonal to project provisioning.
- **The actual deploy of the React app + Cloud Functions** — has its own concerns (esbuild bundling for the workspace:* deploy issue, the Hosting predeploy hook in `firebase.json`, etc.) that land in the Phase 2+ engineering work and are documented in `docs/changelog/phase-2-auth-and-claims.md`.

---

## Manual verification (rehearsal target)

Per `infra/CLAUDE.md` invariant 4 ("Every runbook is testable"), this runbook is meant to be walked end-to-end by an operator with no prior context. The first walkthrough is the real walkthrough — there's no staging-of-the-runbook environment. If a step is ambiguous, surprising, or wrong when you run it, edit this file in the same session you discovered the problem.

When complete, mark `[T-03]` in `docs/TASKS.md` as DONE with the date, and update `infra/runbooks/deploy.md` to drop the "Errors here usually mean B1 hasn't been done" caveats.
