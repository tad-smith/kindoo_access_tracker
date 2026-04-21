# Sheet setup

How to create the backing Google Sheet and wire it up to this repository. Do this once per deployment (one sheet per stake install).

Two paths, in order of preference:

1. **Preferred — run `setupSheet()`**: create the sheet, bind the script, push code, then run a single helper that creates every tab with headers and seeds the well-known `Config` keys. The helper is idempotent — safe to re-run.
2. **Manual fallback**: if you'd rather not run code before the first push, you can create the tabs and headers by hand from the reference at the bottom of this doc.

## Path 1 — `setupSheet()` (preferred)

### Steps

1. In Google Drive as the Kindoo Manager (the deployer), **New → Google Sheets**. Name it, e.g., `Kindoo Access Tracker`. The Sheet may live in a Workspace shared drive — the auth flow's Workspace incompatibility is handled by deploying the **Identity** half as a separate Apps Script project owned by a personal Google account (see Step 12 below + `identity-project/README.md`). Main (this script) stays Workspace-bound.
2. From the sheet, **Extensions → Apps Script**. This opens a new Apps Script project that is **container-bound** to the sheet.
3. Rename the Apps Script project (top-left) to something like `Kindoo Access Tracker`.
4. Copy the **script ID only** (not the whole URL) from the editor URL. The URL looks like `https://script.google.com/.../projects/<SCRIPT_ID>/edit` (or `.../projects/<SCRIPT_ID>` from the projects list). The script ID is the long alphanumeric token between `/projects/` and the next `/` — ~57 characters, starts with `1`, may contain `-` and `_`. Don't paste the URL itself — clasp will throw "Could not find script."
5. In your local clone of this repo, copy the committed template and paste in your script ID:
   ```
   cp .clasp.json.example .clasp.json
   ```
   Then open `.clasp.json` and replace `REPLACE_WITH_YOUR_SCRIPT_ID` with the real ID. The file should end up looking like:
   ```json
   { "scriptId": "1aBc...XyZ", "rootDir": "src" }
   ```
   `.clasp.json` is gitignored — your script ID stays local. The `.clasp.json.example` template is what's committed.
6. Install dependencies, log clasp into Google, and push the code to your bound script.

   **Do these two prerequisites first** (one-time per Google account):
   - **a. Decide which Google account is the deployer.** It must be the same account that owns the bound Sheet from step 1. You'll sign clasp in as this account in a moment, and you'll need to be signed into it in your browser too.
   - **b. Enable the Apps Script API for that account.** In a browser signed in as the deployer, visit <https://script.google.com/home/usersettings> and toggle **Google Apps Script API** to **On**. (Wait ~30 seconds for it to propagate.) Skipping this step is the most common cause of `clasp push` failures. If you're juggling multiple Google accounts in your browser, use the account-switcher in the top-right of the settings page to confirm you're toggling the right one.

   Then run, in order:
   ```
   npm install      # installs @google/clasp into node_modules/
   npm run login    # one-time per machine: opens a browser to Google
   npm run push     # uploads everything in src/ to the Apps Script project
   ```

   What to expect:
   - **`npm run login`** opens your default browser to a Google OAuth page. **Sign in as the deployer account.** When the browser shows "Logged in!", switch back to the terminal — you'll see `Authorization successful`. Credentials are stored in `~/.clasprc.json` (your home directory, not the repo).
   - **First `npm run push` will prompt:** `? Manifest file has been updated. Do you want to push and overwrite? (y/N)` — answer **`y`**. The bound project starts with a default `appsscript.json`; our local `src/appsscript.json` is the source of truth (it has the webapp config, the `America/Denver` timezone, and the OAuth scopes the app needs). This prompt only re-appears on future pushes when `src/appsscript.json` changes (e.g., a later chunk adds a new OAuth scope) — code-only pushes don't ask.
   - On success, `clasp push` prints one line per file pushed (~22 files for Chunk 1) and ends with `Pushed N files.`
   - To re-push after edits during development: `npm run push` again, or `npm run push:watch` to push automatically on save.

   Troubleshooting:
   - **"User has not enabled the Apps Script API"** — you skipped prerequisite 6.b above, or you toggled it on the wrong account in the browser. Confirm with `npx clasp login --status` which account clasp is using; check the Google account-switcher on <https://script.google.com/home/usersettings> to confirm which account the toggle is set on. Both must be the deployer account.
   - **"Could not find script"** — `.clasp.json` has the wrong scriptId (e.g., you pasted the whole URL instead of just the ID).
   - **`npm run login` signed you in as the wrong Google account** — run `npx clasp logout`, then `npm run login` again and pick the deployer account.
7. Back in the Apps Script editor, refresh the page. You'll see the project has new files in the left-hand file tree, organised under `core/`, `repos/`, `services/`, `api/`, and `ui/`.
8. In the editor, open `services/Setup` and run `setupSheet`. (First run prompts for OAuth consent — click through as the deployer.) This:
   - Creates all 10 tabs in the correct order.
   - Sets headers for each.
   - Seeds `Config` with known keys (most empty).
   - Adds an `onOpen()`-installed custom menu to the sheet (`Kindoo Admin → Setup sheet…`, `…Install triggers`) so future setup-related actions don't require the script editor.
9. Switch to the sheet. Open the `Config` tab.
10. Set `bootstrap_admin_email` to the deployer's email. Leave `setup_complete` as `FALSE`.
11. **Deploy the Main web app.** In the Apps Script editor: **Deploy → New deployment**.
    - Click the gear icon (top-left of the dialog) → **Web app**.
    - **Description:** `Kindoo Access Tracker — Main`.
    - **Execute as:** `Me (<your deployer email>)`. _(Critical: this is what keeps the backing Sheet private to the deployer.)_
    - **Who has access:** **Anyone with Google account**.
    - Click **Deploy**.
    - The dialog shows the **Web app URL** ending in `/exec`. Copy it. Format: `https://script.google.com/macros/s/<MAIN_DEPLOYMENT_ID>/exec`.
    - Click **Done**.
    - Open the Sheet's `Config` tab and paste this URL into the `value` cell of the `main_url` row.

12. **Confirm `Config.session_secret` is populated.** Open the `Config` tab. The `session_secret` row should already contain ~73 characters of random hex (auto-generated by `setupSheet`). If it's empty, re-run `setupSheet()` from the Apps Script editor — it auto-generates the secret on first run. Note this value down; you'll paste it into the Identity project in the next step.

13. **Set up the standalone Identity service.** Identity is a SEPARATE Apps Script project, owned by a personal (non-Workspace) Google account. It is not bound to a Sheet, not pushed via clasp, and only ~70 lines of code. The full setup runbook lives in **`identity-project/README.md`** in this repo. Quick summary:
    - Sign into <https://script.google.com/home> as a personal Google account (not the Workspace deployer).
    - Create a new project; copy-paste `identity-project/Code.gs` and `identity-project/appsscript.json` from this repo.
    - Project Settings → Script Properties → set `session_secret` (paste from step 12) and `main_url` (paste from step 11).
    - Deploy as Web app: `Execute as: User accessing the web app`, `Who has access: Anyone with Google account`.
    - Copy the resulting `/exec` URL.
    - Open the Main Sheet's `Config` tab and paste the Identity URL into the `identity_url` row.
    - On first visit (you, as the deployer, or any user), the Identity URL prompts for OAuth consent for the email scope only — non-sensitive, immediate accept.

14. **Use the app via the Main URL.** From now on, users visit the Main URL. The Login button navigates them to the Identity URL (the personal-account project from step 13), which silently signs an HMAC token (after the one-time consent) and redirects them back to Main with the token. Subsequent sessions just re-hit Identity (no new consent prompt) and complete in <1 second.

15. **Wire up the importer (Chunk 3).** The manager "Import Now" button reads `Config.callings_sheet_id` and calls `SpreadsheetApp.openById` against it — which runs under the **deployer's** identity (the Main deployment's `executeAs: USER_DEPLOYING`). Two prerequisites:
    - Paste the callings spreadsheet's ID into `Config.callings_sheet_id`. Same format as `main_url` — just the ID, not the whole URL. Easiest source is the callings sheet's URL: `https://docs.google.com/spreadsheets/d/<ID>/edit` → copy the `<ID>` segment.
    - **Share the callings sheet with the deployer's Google account** (at minimum Viewer). The Main script runs as the deployer, so anything the deployer can't open, the importer can't either. If the callings sheet lives in a different Workspace / shared drive, use "Share → add people" and grant access to the deployer's personal email (the one running Main).
    - From the manager **Import** page, click **Import Now** once. On success you'll see a summary like `36 inserts, 0 deletes, 0 access+/0 access- (2026-04-20 14:32 MDT, 6.4s)` and `Seats` / `Access` tabs fill in. Re-clicking should report `0 inserts, 0 deletes` — that's the idempotency acceptance criterion.
    - Troubleshooting: if the callings sheet isn't accessible, the page surfaces a red toast naming the sheet ID rather than a stack trace. The most common causes are (a) `callings_sheet_id` is blank, (b) the sheet hasn't been shared with the deployer. Fix and re-click.

### Detecting a stale deployment

Apps Script's `/exec` URL serves the most recently *deployed* version, not the latest pushed code. After `npm run push` you must also do **Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy** in the editor for the change to take effect on the deployed URL. If you forget, `/exec` will keep serving the previous version's code.

To detect this without poking around: every page renders `v: <timestamp>` in a tiny footer. The timestamp is auto-stamped into `src/core/Version.gs` at the start of every `npm run push`. Compare the footer value against the value in the file (or against the timestamp `npm run push` just printed). Mismatch = the deployment hasn't been updated.

### If something goes wrong

- **`setupSheet` says "already set up"**: that's fine — it means all the tabs exist and their headers are correct. It's a no-op.
- **Header drift detected**: one of the tabs has a header that doesn't match what the code expects (e.g., someone renamed a column). `setupSheet` will log the mismatch and refuse to touch the tab. Fix by hand.
- **Triggers not installed after bootstrap**: run `TriggersService.install` from the Apps Script editor or use the `Kindoo Admin → Install triggers` menu item.
- **Login button error: "identity_url is not configured"**: the `Config.identity_url` cell is empty or you didn't deploy the Identity web app. Complete step 12.
- **Identity page error: "main_url is not configured"**: the `Config.main_url` cell is empty. Complete step 11's last sub-step (paste the Main URL into Config).
- **Login link reloads the same Login page (sign-in loop)**: the Identity deployment's `doGet` is falling through to the Main UI branch instead of dispatching to `Identity_serve`. Most likely cause: the deployment hasn't been updated to the latest code (compare the `v: <ts>` footer on Login against the value in `src/core/Version.gs` — see "Detecting a stale deployment" above). Push, then **Deploy → Manage deployments → Edit Identity deployment → Version: New version → Deploy**. To verify Identity routing is working, visit `<IDENTITY_URL>?service=identity` directly in the browser — you should land on Main with a token, not the Login page.
- **Identity page error: "Sign-in unavailable: We could not determine your Google identity"**: the user hasn't granted the Identity deployment permission yet. Have them visit the **Identity URL** directly once (not via the Main Login button) to trigger the OAuth consent prompt for the email scope, then return to Main and sign in. (Future logins for that user are silent.)
- **Login completes but lands on `NotAuthorized`**: the user's email isn't in `KindooManagers` (active=TRUE) and isn't in `Access`. Add a row, then re-sign-in. Note that emails are matched after Gmail dot/`+suffix` canonicalisation (see data-model.md `Conventions → Email`).
- **"Your sign-in token was rejected. Please sign in again."** on Main: usually means the `session_secret` was rotated (cleared in `Config` and re-run of `setupSheet`) while the user had a live token. Expected — the user just signs in again.
- **All users suddenly logged out after re-running `setupSheet`**: expected if you cleared the `session_secret` cell; `setupSheet` regenerates and all live tokens become invalid. Don't clear it without intending to log everyone out.

### If you already created an OAuth client per the OLD instructions

Earlier revisions of this doc had you create an OAuth 2.0 Client ID in Cloud Console + populate `gsi_client_id` and `gsi_client_secret` in `Config`. **None of that is used anymore.** Both attempted OAuth approaches (implicit flow, authorization code flow) were blocked by Google's `origin_mismatch` check on `*.googleusercontent.com`; see open-questions.md A-8. The current design uses no OAuth client at all.

You can safely:
- Leave the `gsi_client_id` / `gsi_client_secret` rows in your `Config` tab (they're inert — never read).
- Or delete those two rows by hand for tidiness.
- Leave the OAuth client alive in Cloud Console (it's free, no harm), or delete it.

The two new keys you need (`main_url`, `identity_url`, `session_secret`) are added by the latest `setupSheet`. Re-run `setupSheet()` once to seed them, then complete steps 11–15 above.

---

## Path 2 — Manual

Create each tab, one-by-one, in this exact order. Column headers are case-sensitive and must match the data-model doc exactly. Set the header row to freeze (View → Freeze → 1 row) and optionally bold.

### Tab order

1. `Config`
2. `KindooManagers`
3. `Buildings`
4. `Wards`
5. `WardCallingTemplate`
6. `StakeCallingTemplate`
7. `Access`
8. `Seats`
9. `Requests`
10. `AuditLog`

(Order matters only for readability — the code looks tabs up by name.)

### Tab 1 — `Config`

Headers (row 1, left to right):

```
key	value
```

Seed rows (row 2 onwards):

| key | value |
| --- | --- |
| `stake_name` | *(blank — filled by bootstrap wizard)* |
| `callings_sheet_id` | *(blank — filled by bootstrap wizard)* |
| `stake_seat_cap` | *(blank — filled by bootstrap wizard)* |
| `bootstrap_admin_email` | `<YOUR_GMAIL_ADDRESS>` |
| `gsi_client_id` | `<YOUR_OAUTH_CLIENT_ID>.apps.googleusercontent.com` |
| `setup_complete` | `FALSE` |
| `expiry_hour` | `3` |
| `last_import_at` | *(leave blank)* |
| `last_import_summary` | *(leave blank)* |

### Tab 2 — `KindooManagers`

Headers:

```
email	name	active
```

(Leave data rows empty — you'll add yourself via the bootstrap wizard.)

### Tab 3 — `Buildings`

Headers:

```
building_name	address
```

### Tab 4 — `Wards`

Headers:

```
ward_code	ward_name	building_name	seat_cap
```

### Tab 5 — `WardCallingTemplate`

Headers:

```
calling_name	give_app_access
```

### Tab 6 — `StakeCallingTemplate`

Headers:

```
calling_name	give_app_access
```

### Tab 7 — `Access`

Headers:

```
email	scope	calling
```

Leave empty — the importer populates this tab.

### Tab 8 — `Seats`

Headers (15 columns):

```
seat_id	scope	type	person_email	person_name	calling_name	source_row_hash	reason	start_date	end_date	building_names	created_by	created_at	last_modified_by	last_modified_at
```

### Tab 9 — `Requests`

Headers (15 columns):

```
request_id	type	scope	target_email	target_name	reason	comment	start_date	end_date	status	requester_email	requested_at	completer_email	completed_at	rejection_reason
```

### Tab 10 — `AuditLog`

Headers (7 columns):

```
timestamp	actor_email	action	entity_type	entity_id	before_json	after_json
```

### After manual creation

Continue from Path 1 step 11 (deploy the Main and Identity web apps, paste their URLs into `Config.main_url` / `Config.identity_url`, complete the one-time per-user OAuth consent on the Identity URL).

---

## Things to double-check before the first deploy

- [ ] The Main script is bound to the backing Sheet (Workspace shared drive is fine). Its deployment uses `executeAs: USER_DEPLOYING`.
- [ ] The Identity script is a **separate Apps Script project** owned by a personal (non-Workspace) Google account, with `executeAs: USER_ACCESSING` — see `identity-project/README.md`. Its `session_secret` Script Property matches the value in Main's Sheet `Config.session_secret` cell.
- [ ] `Config.bootstrap_admin_email` is set to the deployer's email, **as typed** (case, dots, `+suffix` preserved). The app uses canonical-on-the-fly comparison (Gmail dot/`+suffix` stripping) so dot-variants resolve, but the cell shows the typed form.
- [ ] `Config.session_secret` is populated (~73 chars). `setupSheet` auto-generates this on first run; verify it isn't empty.
- [ ] `Config.main_url` is set to the **Main** deployment's `/exec` URL. Bare form (`https://script.google.com/macros/s/<ID>/exec`), no `/a/macros/<domain>/` prefix.
- [ ] `Config.identity_url` is set to the **Identity** project's `/exec` URL (different scriptId from Main, lives in a personal Drive). Same bare form.
- [ ] `Config.setup_complete` is `FALSE`.
- [ ] Every tab's headers match the data-model doc byte-for-byte (case, spelling, underscores).
- [ ] `appsscript.json` in the deployed version has `webapp.access = "ANYONE"`. The Main deployment's `executeAs` is `USER_DEPLOYING`; the Identity deployment's `executeAs` is `USER_ACCESSING`. The deploy dialog labels `ANYONE` as "Anyone with Google account" — that's the same value, just a UI alias. (`ANYONE` requires sign-in; `ANYONE_ANONYMOUS` would not.)
- [ ] **No OAuth client in Cloud Console is required** for the current architecture (see open-questions.md A-8). If you have an old one from earlier docs revisions, it's inert — leave it or delete it.
- [ ] **Importer prerequisites (from Chunk 3 onwards):** `Config.callings_sheet_id` is set to the source callings spreadsheet's ID, and that spreadsheet has been shared with the **deployer's** Google account at minimum Viewer. The Main deployment runs as the deployer, and `SpreadsheetApp.openById` inherits those permissions.

## What the bootstrap wizard will do

Once the deployer first visits the `/exec` URL signed in as the bootstrap admin, the wizard will:

1. Ask for stake name, callings-sheet ID, stake seat cap → writes to `Config`.
2. Ask for at least one Building → writes to `Buildings`.
3. Ask for at least one Ward → writes to `Wards`.
4. Optionally ask for additional Kindoo Managers → writes to `KindooManagers`.
5. Install daily expiry and weekly import triggers.
6. Flip `Config.setup_complete = TRUE`.
7. Redirect to the manager dashboard.

No other users can access the app until step 6 finishes.
