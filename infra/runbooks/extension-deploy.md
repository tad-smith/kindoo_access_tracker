# Runbook: Building and deploying the SBA Chrome extension

Operator playbook for building, signing, installing, and distributing the Stake Building Access Chrome extension across `kindoo-staging` and `kindoo-prod`. Covers the full first-time setup per environment, the per-build loop, the smoke test, and the Chrome Web Store path for production.

## Overview

The extension is a Chrome MV3 add-on that surfaces SBA's pending-request queue inside a slide-over panel on `web.kindoo.tech`. A Kindoo Manager signs in once with their stake-manager Google account, and the panel renders the same queue they would see on the SPA's home page, with a "Mark Complete" button that calls back into SBA when the Kindoo-side work is done. The extension never reads Firestore directly — every SBA interaction goes through two callables (`getMyPendingRequests`, `markRequestComplete`).

Three properties distinguish the extension from the SPA:

- **Separate Firebase Auth client.** The extension runs Firebase Auth inside its service worker, distinct from the SPA's auth client. Same Firebase project, different client instance.
- **Separate GCP identity.** Each environment has its own Google OAuth "Chrome extension" client, bound to a single Chrome extension ID. The extension ID is pinned by the manifest `key` field; the keypair that produces it is generated locally per env.
- **Separate distribution.** The extension is shipped via the Chrome Web Store (production) or loaded unpacked (staging + local dev). The SPA's deploy pipeline does not touch the extension; you build and load it by hand.

Staging and production builds are designed to coexist in the same Chrome profile: distinct extension IDs, distinct names (`SBA Helper (Staging)` vs `Stake Building Access — Kindoo Helper`), and orange-tinted staging icons so you can tell them apart in the toolbar.

## Prerequisites

Installed and authenticated locally:

- `pnpm`, `node` 22+, `openssl` (default macOS install is fine).
- `firebase` CLI, logged in (`firebase login`) against an account with deploy access to `kindoo-staging` (and `kindoo-prod`, for prod work).
- `gh` CLI, authenticated, if you intend to deploy a PR branch via `--from-pr`.
- Google Chrome.

Access:

- A stake-manager Firebase Auth account in the target environment (the extension's "Not Authorized" path triggers if the signed-in Google account isn't a manager).
- Owner / Editor permission on the target GCP project (`kindoo-staging` or `kindoo-prod`) so you can create OAuth credentials.

## First-time per-env setup

Do this **once** per environment. Subsequent rebuilds reuse the keypair, the GCP OAuth client, and the `.env.<mode>` file.

The walkthrough below uses staging; for production substitute `production` for `staging` and `kindoo-prod` for `kindoo-staging`.

### 1. Generate the RSA keypair

`extension/keys/` is gitignored; the `.pem` private key never leaves your machine.

```bash
mkdir -p extension/keys
openssl genrsa -out extension/keys/staging.pem 2048
```

### 2. Derive the base64 SPKI public key

This is `VITE_EXTENSION_KEY`. It is public-by-design — it ships in the manifest as the `key` field — but treat the file containing it (`.env.staging`) as private so you don't leak the bundled OAuth client ID alongside it.

```bash
openssl rsa -in extension/keys/staging.pem -pubout -outform DER | base64 | tr -d '\n'
```

Copy the output. It is one long line of base64 with no trailing newline.

### 3. Compute the extension ID

Chrome derives the extension ID from the public key. The repo's helper script reproduces that derivation so you can register the right ID in GCP before the first build.

```bash
pnpm --filter @kindoo/extension ext-id --key <base64-public-key>
```

Expected output: a 32-character lowercase string in the alphabet `a-p`, e.g. `peipajlcmjglakepgfapofmfdignbjdp`. Copy it for step 4.

### 4. Register the OAuth client in GCP

Open the Credentials page for the target project:

- Staging: <https://console.cloud.google.com/apis/credentials?project=kindoo-staging>
- Production: <https://console.cloud.google.com/apis/credentials?project=kindoo-prod>

Then:

1. **+ CREATE CREDENTIALS → OAuth client ID.**
2. **Application type: Chrome extension.**
3. **Item ID:** paste the 32-char string from step 3.
4. **CREATE.**
5. Copy the resulting `xxxxxxxxxxxx.apps.googleusercontent.com` client ID — it is `VITE_GOOGLE_OAUTH_CLIENT_ID`.

If this is the first OAuth client in the project, GCP forces you through the OAuth consent screen first. Pick **External**, set an app name, set a support email, save, then return to Credentials and resume from step 1 above.

### 5. Fill in `extension/.env.<mode>`

Both `.env.staging` and `.env.production` are gitignored; copy from `extension/.env.example` as a starting point.

**Critical:** the five `VITE_FIREBASE_*` values are the same as the SPA uses, and the SPA's per-env files are **checked in** under `apps/web/` because the Firebase web SDK config is public-by-design. Copy verbatim from `apps/web/.env.<mode>`; do not re-derive them from the Firebase console.

```
# Copy these five from apps/web/.env.staging (or apps/web/.env.production):
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...

# Extension-only — derived in steps 2 + 4 above:
VITE_GOOGLE_OAUTH_CLIENT_ID=...
VITE_EXTENSION_KEY=...
VITE_EXTENSION_NAME=SBA Helper (Staging)
```

For production, set `VITE_EXTENSION_NAME=Stake Building Access — Kindoo Helper`.

### 6. Sanity-check the extension ID

Confirm that the extension ID you just registered in GCP matches what the build will actually produce. If these diverge, sign-in fails silently at runtime.

```bash
pnpm --filter @kindoo/extension ext-id --key "$VITE_EXTENSION_KEY"
```

The output must match the Item ID you pasted in step 4.

## Per-build steps

Every rebuild after a code change.

### 1. Bump the manifest version

Edit `extension/src/manifest.config.ts` and increment the `version` field (semver-ish: patch for fixes, minor for behavioural additions). The build bakes the version into the manifest; bumping it on every rebuild lets you verify in `chrome://extensions` that the reload picked up the new bytes.

```ts
// extension/src/manifest.config.ts
version: '0.1.2',  // was 0.1.1
```

### 2. Deploy the callables to the target env (if they changed)

The extension cannot do anything before the two callables (`getMyPendingRequests`, `markRequestComplete`) exist in the target Firebase project. The browser surfaces a missing callable as a CORS error (`No 'Access-Control-Allow-Origin' header'`) because the preflight 404s — which is misleading; the real cause is the function not being deployed.

If any of these changed since the last deploy, run the deploy:

- `functions/src/callable/getMyPendingRequests.ts`
- `functions/src/callable/markRequestComplete.ts`
- `packages/shared/src/types/extensionCallables.ts`
- Anything those import.

Staging:

```bash
pnpm deploy:staging                                # current main
# or, to test a PR branch without merging:
pnpm deploy:staging -- --from-pr <PR-number>       # checks out the PR, deploys, restores your branch
```

Production:

```bash
pnpm deploy:prod
```

`--from-pr` is staging-only by design. See `infra/runbooks/deploy.md` for the deploy script's pre-flight requirements and rollback notes.

### 3. Build the extension

```bash
# Staging:
pnpm --filter @kindoo/extension build --mode staging

# Production:
pnpm --filter @kindoo/extension build               # production is the default mode
```

Output:

- `extension/dist/staging/` for staging.
- `extension/dist/production/` for production.

### 4. Reload in Chrome

`chrome://extensions` → find the card matching the env you just built → click the circular reload icon. Confirm the **version on the card** matches the value you bumped to in step 1. If it still shows the old version, the reload picked up a stale `dist/`; rebuild and reload again.

## First-time install (staging)

For an operator who has never loaded the unpacked extension before:

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. **Load unpacked** → select `extension/dist/staging`.
4. Confirm the toolbar shows an orange-tinted SBA icon. The card name reads `SBA Helper (Staging)`.

Repeat with `extension/dist/production` after a production build to load both side-by-side.

## Smoke test

After a fresh build + reload, run through:

1. Open `https://web.kindoo.tech` and sign in to Kindoo.
2. Click the SBA toolbar icon. The slide-over appears from the right edge of the page.
3. Click **Sign in with Google** → pick a stake-manager Google account → consent on the OAuth screen. The slide-over flips to the pending queue. If the account is not a manager, the slide-over flips to a "Not Authorized" view instead.
4. Click **Mark Complete** on a pending request → confirm in the dialog → the button shows a pending state and then the card disappears from the queue.
5. Open the SPA at the target env's URL (e.g. `https://staging.stakebuildingaccess.org`) and verify the request flipped to complete.
6. Click the toolbar icon again. The slide-over hides. Click again — it reappears in the same state. Reload the page — the open/closed state persists.

## Production: Chrome Web Store distribution

Production is shipped via the Chrome Web Store. The unpacked-load path is staging-only.

The plan is two-stage:

- **Phase 1 (current):** Unlisted in the Web Store. The listing is published but search-hidden; only operators with the direct link install it. This is the right shape for SBA's single-stake v1: a handful of users, no public discovery needed.
- **Phase 2 (future):** Promote to public if the user base extends beyond a single stake.

The flow below is the **Phase 1 procedure**. Follows the staging pattern; the first prod run will validate the Web Store steps specifically.

### 1. Build the prod artifact

Complete the first-time per-env setup (above) for `kindoo-prod`, then run a clean prod build:

```bash
pnpm --filter @kindoo/extension build
ls extension/dist/production
```

### 2. Zip the build for upload

Zip the **contents** of `extension/dist/production/`, not the directory itself. The Web Store rejects a zip whose top entry is a folder.

```bash
cd extension/dist/production && zip -r ../../sba-extension-v$(node -p "require('./manifest.json').version").zip ./* && cd -
```

The resulting zip lands in `extension/sba-extension-vX.Y.Z.zip`.

### 3. Upload to the Chrome Web Store Developer Dashboard

Dashboard: <https://chrome.google.com/webstore/devconsole/>.

1. Create a new item (first time) or pick the existing SBA item.
2. Upload the zip from step 2.
3. Fill in the listing fields. Operator owns this content; it is not in scope for the engineering team:
   - Icon (use `apps/web/public/icon-512.png` or one of the production extension icons unchanged).
   - Short description.
   - Detailed description.
   - Screenshots (slide-over open on `web.kindoo.tech`).
   - Privacy policy URL.
4. Set **Visibility: Unlisted.**
5. **Submit for review.**

Web Store review can take days to weeks. Plan accordingly.

### 4. OAuth consent screen (prod GCP project)

Before any non-test user can sign in via the prod extension, the prod GCP project's OAuth consent screen must be configured. The extension uses only `openid`, `email`, and `profile` scopes — all non-sensitive — so Google's app-verification process is **not** required.

The first run on `kindoo-prod` will validate this section.

## Troubleshooting

**Symptom:** SW console shows `Uncaught ReferenceError: document is not defined` at service-worker registration.
**Likely cause:** Firebase Auth's default entry (`firebase/auth`) was imported somewhere in the SW bundle. That entry pulls in DOM helpers that crash in an MV3 service-worker context.
**Fix:** Import from `firebase/auth/web-extension` instead. The repo's current SW imports do this correctly; flag any new `firebase/auth` (non-`/web-extension`) import in code reaching the SW.

---

**Symptom:** SW console shows `document is not defined` and the SW bundle contains React.
**Likely cause:** @crxjs chunk-name collision. If the service-worker entry and the content-script entry are both named `index.ts` (or any other shared basename), @crxjs cross-wires the loader scripts and the SW ends up loading the content-script bundle.
**Fix:** Entry filenames must be distinct. The current entries are `src/background/service-worker.ts` and `src/content/content-script.ts`; never rename either back to `index.ts`.

---

**Symptom:** Sign-in fails silently, or the OAuth screen shows `bad client id: <id>`.
**Likely cause:** The OAuth client registered in GCP doesn't match the extension's actual ID.
**Fix:** Re-run `pnpm --filter @kindoo/extension ext-id --key "$VITE_EXTENSION_KEY"` and compare the output to the Item ID on the GCP OAuth client. If they differ, either rebuild with the matching key, or update the GCP client's Item ID (requires creating a new client — the Item ID isn't editable post-creation).

---

**Symptom:** `Access to fetch at '...cloudfunctions.net/...' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header` when the panel calls a callable.
**Likely cause:** The callable doesn't exist in the target env yet. The function URL returns 404 on the CORS preflight, which the browser surfaces as a CORS failure.
**Fix:** Deploy the callables: `pnpm deploy:staging` (or `:prod`). Firebase v2 `onCall` defaults `cors: true`, so if you still get CORS errors after a successful deploy, that's a real CORS issue and the callable needs explicit `cors` config.

---

**Symptom:** Loaded the extension but no toolbar icon appears.
**Likely cause:** Either the wrong `dist/` directory was loaded, or the manifest `key` field doesn't match a registered OAuth client.
**Fix:** Open `chrome://extensions`, look at the card's extension ID, and compare to the GCP OAuth client's Item ID. Mismatch → the build picked up a stale or wrong `VITE_EXTENSION_KEY`. Confirm `extension/.env.<mode>` contains the right value and rebuild.

---

**Symptom:** Reload doesn't seem to pick up new changes.
**Likely cause:** The `version` field in `manifest.config.ts` wasn't bumped, so you can't tell visually whether the reload took.
**Fix:** Check the version shown on the `chrome://extensions` card against `manifest.config.ts`. Bump the version, rebuild, reload. If the card still shows the old version, the reload is loading a stale `dist/` — re-run the build and confirm the timestamp on `extension/dist/<mode>/manifest.json` advanced.

## References

- `extension/CLAUDE.md` — engineering conventions for the extension workspace.
- `extension/.env.example` — template for the per-env env files.
- `extension/scripts/compute-extension-id.mjs` — extension-ID derivation script (`pnpm --filter @kindoo/extension ext-id`).
- `extension/scripts/tint-icons.mjs` — one-shot orange-tinted staging icon generator (`pnpm --filter @kindoo/extension icons:tint`); re-run only when the prod icons change.
- `infra/runbooks/deploy.md` — Firebase deploy pre-flight + rollback (covers `pnpm deploy:staging` / `:prod`).
- GCP Console — Credentials:
  - Staging: <https://console.cloud.google.com/apis/credentials?project=kindoo-staging>
  - Production: <https://console.cloud.google.com/apis/credentials?project=kindoo-prod>
- Chrome Web Store Developer Dashboard: <https://chrome.google.com/webstore/devconsole/>
