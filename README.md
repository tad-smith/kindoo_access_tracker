# Kindoo Access Tracker

A Google Apps Script web app used by a stake of The Church of Jesus Christ of Latter-day Saints to manage Kindoo door-access seat assignments across its wards.

## What it does

- Tracks three kinds of seats per ward and per stake pool: **automatic** (from LCR callings), **manual**, **temporary** (with end dates).
- Lets bishoprics request manual/temp adds and removals for their own ward.
- Lets the stake presidency do the same against the stake pool.
- Gives Kindoo Managers a queue to work through, mirror into Kindoo by hand, and mark complete.
- Weekly imports automatic seats from the existing stake callings spreadsheet.
- Daily job expires temp seats whose end date has passed.
- Emails requesters and managers at the relevant lifecycle points.

Specification: [`docs/spec.md`](docs/spec.md) (live — always describes the current system). Architecture: [`docs/architecture.md`](docs/architecture.md). Data model: [`docs/data-model.md`](docs/data-model.md). Build order: [`docs/build-plan.md`](docs/build-plan.md). Per-chunk history: [`docs/changelog/`](docs/changelog/).

## Project layout

```
.
├── src/                     # Apps Script source (what clasp pushes)
│   ├── appsscript.json      # manifest
│   ├── core/                # entry point, router, auth, lock, utils
│   ├── repos/               # one module per Sheet tab (data access)
│   ├── services/            # importer, expiry, requests, email, setup
│   ├── api/                 # server endpoints called from client via google.script.run
│   └── ui/                  # HTML templates (shared + per-role pages)
├── docs/
│   ├── spec.md              # live source of truth — updated with every behaviour change
│   ├── architecture.md, data-model.md, build-plan.md, open-questions.md, sheet-setup.md
│   └── changelog/           # per-chunk journal of deviations & rationale
├── .clasp.json.example      # committed template — copy to .clasp.json and add your scriptId
├── .clasp.json              # (gitignored) your local clasp binding
├── package.json             # clasp dev dependency, npm scripts
└── README.md
```

## Local dev workflow

### First-time setup

1. Install dependencies:
   ```
   npm install
   ```
2. Create the backing Google Sheet and its bound Apps Script project. Full instructions: [`docs/sheet-setup.md`](docs/sheet-setup.md). Summary:
   1. In Google Drive, **New → Google Sheets**. Name it (e.g. `Kindoo Access Tracker — CS North`).
   2. In the sheet, **Extensions → Apps Script**. This creates a bound script project.
   3. Copy the script ID from the Apps Script editor URL (`…/projects/<SCRIPT_ID>/edit`).
3. Wire clasp to that script:
   1. Log in: `npm run login` (runs `clasp login` in a browser).
   2. Copy the template: `cp .clasp.json.example .clasp.json`. `.clasp.json` is gitignored so your scriptId stays local.
   3. Put the script ID into `.clasp.json` (`scriptId` field).
4. Push the code:
   ```
   npm run push
   ```
5. In the Apps Script editor, open `services/Setup` and run `setupSheet()` once. This creates every tab with the correct headers and auto-generates `Config.session_secret`. (If preferred, this step can be triggered from the `Kindoo Admin → Setup sheet…` custom menu added by `onOpen()` — see [`docs/sheet-setup.md`](docs/sheet-setup.md).)
6. Open the Sheet's `Config` tab and set `bootstrap_admin_email` to your address.
7. Deploy **two** web apps from the same script project (full walkthrough in [`docs/sheet-setup.md`](docs/sheet-setup.md#path-1--setupsheet-preferred), steps 11–14):
   - **Main** — `executeAs: Me`, access: `Anyone with Google account`. Paste its `/exec` URL into `Config.main_url`.
   - **Identity** — `executeAs: User accessing the web app`, access: `Anyone with Google account`. Paste its `/exec` URL into `Config.identity_url`.
   No OAuth Client ID in Google Cloud Console is needed; identity comes from `Session.getActiveUser()` on the Identity deployment, signed with `Config.session_secret` (HMAC) so Main can trust the result. See [`docs/architecture.md`](docs/architecture.md) D10 + [`docs/open-questions.md`](docs/open-questions.md) A-8 for why this two-deployment shape is necessary.
8. Visit the Identity URL once directly in a browser, signed in as the bootstrap admin, to grant the one-time per-user OAuth consent for the email scope. Then visit the Main URL — Google Sign-In completes via the Identity round-trip, and the first-run wizard (Chunk 4) walks you through the rest of the configuration.

### Day-to-day

- Edit files under `src/`.
- `npm run push` to sync to Apps Script. Stamps `src/core/Version.gs` with the current UTC timestamp before pushing — the value renders as a tiny footer on every page.
- `npm run push:watch` to sync on save (timestamp stamped once at the start).
- `npm run open` opens the script in the Apps Script editor.
- `npm run logs` tails execution logs.
- `npm run deploy` creates a *new* deployment (new ID, new URL — usually not what you want). For ongoing dev, **update the existing deployment** via the Apps Script editor: **Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy**. Without that step, `/exec` keeps serving the previously-deployed code even after `clasp push`.

### Detecting a stale deployment

Apps Script's `/exec` URL serves the most recently *deployed* code, not the head. If you push but forget to update the deployment, you're testing yesterday's code. To detect this:

1. After `npm run push`, note the timestamp printed by `stamp-version`.
2. Open `/exec` in the browser — the footer shows `v: <timestamp>`.
3. If the footer's timestamp is older than what was just printed, the deployment hasn't been updated. Update it via the editor as described above.

### Production domain

The app is also served at `kindoo.csnorth.org` via a Cloudflare Worker that proxies to the Apps Script `/exec` URL. Worker setup is Chunk 11 of the build plan — the `/exec` URL works fine during development.

## Conventions

- **`docs/spec.md` is the live source of truth.** Code and spec change together, in the same commit. Per-chunk changelogs in [`docs/changelog/`](docs/changelog/) record the "why" behind each change — reading the latest chunk file plus `spec.md` is the catch-up recipe.
- **Never commit `.clasprc.json` or `.clasp.json`.** The first holds your personal clasp OAuth credentials; the second holds your local scriptId. Both are gitignored. The committed `.clasp.json.example` is the template.
- **No secrets in source.** `Config.session_secret` (the HMAC signing secret for session tokens — auto-generated by `setupSheet`), the callings-sheet ID, and the backing-sheet ID are all runtime config in the Sheet. Member data never enters the repo — it's all in the Sheet.
- **Apps Script has a flat namespace.** Subdirectories under `src/` become folder prefixes in the Apps Script editor (e.g. `repos/SeatsRepo`), but all functions still share one global scope. Name exported functions defensively (`Seats_getAll`, not `getAll`).
- **Every write goes through `LockService`.** See [`docs/architecture.md`](docs/architecture.md#lockservice-strategy).
- **Every write emits an `AuditLog` row.** No exceptions, including automated jobs (use actor `"Importer"` or `"ExpiryTrigger"`). Callers pass the actor explicitly — `AuditRepo.write` never falls back to `Session.getActiveUser`, because that's the deployer, not the authenticated user (see [`docs/architecture.md` §5](docs/architecture.md)).

## Help and feedback

- `/help` — help with using Claude Code.
- Report issues: <https://github.com/anthropics/claude-code/issues>.
