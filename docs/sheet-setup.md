# Sheet setup

How to create the backing Google Sheet and wire it up to this repository. Do this once per deployment (one sheet per stake install).

Two paths, in order of preference:

1. **Preferred — run `setupSheet()`**: create the sheet, bind the script, push code, then run a single helper that creates every tab with headers and seeds the well-known `Config` keys. The helper is idempotent — safe to re-run.
2. **Manual fallback**: if you'd rather not run code before the first push, you can create the tabs and headers by hand from the reference at the bottom of this doc.

## Path 1 — `setupSheet()` (preferred)

### Steps

1. In Google Drive as the Kindoo Manager (the deployer), **New → Google Sheets**. Name it, e.g., `Kindoo Access Tracker — CS North`.
2. From the sheet, **Extensions → Apps Script**. This opens a new Apps Script project that is **container-bound** to the sheet.
3. Rename the Apps Script project (top-left) to something like `Kindoo Access Tracker`.
4. Copy the script ID from the editor URL: `https://script.google.com/.../projects/<SCRIPT_ID>/edit`.
5. In your local clone of this repo, put the script ID into `.clasp.json`:
   ```json
   { "scriptId": "<SCRIPT_ID>", "rootDir": "src" }
   ```
6. Log in to clasp and push:
   ```
   npm install
   npm run login
   npm run push
   ```
7. Back in the Apps Script editor, refresh the page. You'll see the project has new files.
8. In the editor, open `services/Setup` and run `setupSheet`. (First run prompts for OAuth consent — click through as the deployer.) This:
   - Creates all 10 tabs in the correct order.
   - Sets headers for each.
   - Seeds `Config` with known keys (most empty).
   - Adds an `onOpen()`-installed custom menu to the sheet (`Kindoo Admin → Setup sheet…`, `…Install triggers`) so future setup-related actions don't require the script editor.
9. Switch to the sheet. Open the `Config` tab.
10. Set `bootstrap_admin_email` to the deployer's email. Leave `setup_complete` as `FALSE`.
11. **Create an OAuth 2.0 Client ID** (one-time per deployment — needed for Google Sign-In):
    1. Open <https://console.cloud.google.com/apis/credentials>, sign in as the deployer, and select (or create) a project — a default project is fine.
    2. If prompted, configure the OAuth consent screen: User Type **External**, app name `Kindoo Access Tracker`, user support email = deployer, developer contact email = deployer. Scopes: leave defaults (`openid`, `email`, `profile`). Publishing status: click **Publish app**. The three default scopes don't require Google verification, so publication is immediate (no review wait, no test-users list to maintain).
    3. **Credentials → + Create Credentials → OAuth client ID**. Application type: **Web application**. Name it `Kindoo Access Tracker`.
    4. **Authorized JavaScript origins** — add `https://script.google.com`. You'll add `https://kindoo.csnorth.org` in Chunk 11 when the custom domain goes live.
    5. **Authorized redirect URIs** — leave empty; we use GSI popup/One-Tap, not redirect flow.
    6. Create. Copy the **Client ID** (looks like `1234567890-abcdefghijklmnop.apps.googleusercontent.com`).
    7. Back in the sheet's `Config` tab, set `gsi_client_id` to that value.
12. Deploy the web app: **Deploy → New deployment → Web app**, execute as `Me (<your email>)`, who has access `Anyone with Google account`. Note the `/exec` URL.
13. Open the `/exec` URL in a browser while signed in as the bootstrap admin. You'll be prompted to sign in with Google (GSI); after that, the first-run wizard finishes the rest (stake name, callings-sheet ID, buildings, wards, additional managers).

### If something goes wrong

- **`setupSheet` says "already set up"**: that's fine — it means all the tabs exist and their headers are correct. It's a no-op.
- **Header drift detected**: one of the tabs has a header that doesn't match what the code expects (e.g., someone renamed a column). `setupSheet` will log the mismatch and refuse to touch the tab. Fix by hand.
- **Triggers not installed after bootstrap**: run `TriggersService.install` from the Apps Script editor or use the `Kindoo Admin → Install triggers` menu item.
- **"Error 400: invalid_request — Origin not allowed" from GSI**: the origin the browser is on (e.g., `script.googleusercontent.com` when opened in an iframe) isn't in the OAuth Client ID's authorized JavaScript origins. Add it in Google Cloud Console → Credentials → the client → Authorized JavaScript origins. Changes can take a few minutes to propagate.
- **Everyone gets logged out after editing `Config.gsi_client_id`**: expected. Tokens are signed for a specific audience; the new client_id means old tokens no longer verify. Users just need to sign in again.
- **OAuth consent screen still in "Testing" mode and unapproved users can't sign in**: click **Publish app** on the consent screen. The `openid`/`email`/`profile` scopes don't require Google verification; publication is immediate.

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
building_id	name	address
```

### Tab 4 — `Wards`

Headers:

```
ward_id	name	ward_code	building_id	seat_cap
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
seat_id	scope	type	person_email	person_name	calling_name	source_row_hash	reason	start_date	end_date	building_ids	created_by	created_at	last_modified_by	last_modified_at
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

Continue from Path 1 step 11 (create the OAuth 2.0 Client ID, paste it into `Config.gsi_client_id`, deploy the web app, open the `/exec` URL, run the bootstrap wizard).

---

## Things to double-check before the first deploy

- [ ] `Config.bootstrap_admin_email` is set to the deployer's email. You can type it however you like — the app canonicalises on read (lowercase + Gmail dot/`+suffix` stripping) before comparing against the GSI-verified identity.
- [ ] `Config.gsi_client_id` is set to the OAuth 2.0 Client ID you created in Google Cloud Console.
- [ ] The OAuth Client ID's **Authorized JavaScript origins** include `https://script.google.com`.
- [ ] The OAuth consent screen's publishing status is **In production** (not Testing).
- [ ] `Config.setup_complete` is `FALSE`.
- [ ] Every tab's headers match the data-model doc byte-for-byte (case, spelling, underscores).
- [ ] The backing sheet is owned by the deployer account.
- [ ] `appsscript.json` in the deployed version has `webapp.access = "ANYONE_WITH_GOOGLE_ACCOUNT"` and `executeAs = "USER_DEPLOYING"`.

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
