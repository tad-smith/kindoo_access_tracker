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
5. In the Apps Script editor, open `core/Setup` and run `setupSheet()` once. This creates every tab with the correct headers. (If preferred, this step can be triggered from a custom menu — see [`docs/sheet-setup.md`](docs/sheet-setup.md).)
6. Create an OAuth 2.0 Client ID for Google Sign-In (full walkthrough in [`docs/sheet-setup.md`](docs/sheet-setup.md#path-1--setupsheet-preferred), step 11): Google Cloud Console → Credentials → OAuth client ID → Web application; add `https://script.google.com` (and later your custom domain) to Authorized JavaScript origins.
7. Open the Sheet's `Config` tab and set `bootstrap_admin_email` to your address and `gsi_client_id` to the OAuth client ID you just created. You'll finish setup via the in-app bootstrap wizard after the first deploy.
8. Deploy the web app:
   ```
   npm run deploy
   ```
   Note the `/exec` URL printed — that's the app URL. Access setting: `Anyone with Google account`.
9. Open the URL in a browser while signed in as the bootstrap admin. Google Sign-In prompts once, then the first-run wizard walks you through the rest of the configuration.

### Day-to-day

- Edit files under `src/`.
- `npm run push` to sync to Apps Script.
- `npm run push:watch` to sync on save.
- `npm run open` opens the script in the Apps Script editor.
- `npm run logs` tails execution logs.
- `npm run deploy` creates a new deployment version. `clasp deployments` lists them.

### Production domain

The app is also served at `kindoo.csnorth.org` via a Cloudflare Worker that proxies to the Apps Script `/exec` URL. Worker setup is Chunk 11 of the build plan — the `/exec` URL works fine during development.

## Conventions

- **`docs/spec.md` is the live source of truth.** Code and spec change together, in the same commit. Per-chunk changelogs in [`docs/changelog/`](docs/changelog/) record the "why" behind each change — reading the latest chunk file plus `spec.md` is the catch-up recipe.
- **Never commit `.clasprc.json` or `.clasp.json`.** The first holds your personal clasp OAuth credentials; the second holds your local scriptId. Both are gitignored. The committed `.clasp.json.example` is the template.
- **No secrets in source.** The OAuth Client ID is not a secret (Google's threat model doesn't treat it as one), but it still lives in `Config.gsi_client_id` in the Sheet so it can be rotated without a redeploy. The callings-sheet ID and the backing-sheet ID are runtime config. Member data never enters the repo — it's all in the Sheet.
- **Apps Script has a flat namespace.** Subdirectories under `src/` become folder prefixes in the Apps Script editor (e.g. `repos/SeatsRepo`), but all functions still share one global scope. Name exported functions defensively (`Seats_getAll`, not `getAll`).
- **Every write goes through `LockService`.** See [`docs/architecture.md`](docs/architecture.md#lockservice-strategy).
- **Every write emits an `AuditLog` row.** No exceptions, including automated jobs (use actor `"Importer"` or `"ExpiryTrigger"`). Callers pass the actor explicitly — `AuditRepo.write` never falls back to `Session.getActiveUser`, because that's the deployer, not the authenticated user (see [`docs/architecture.md` §5](docs/architecture.md)).

## Help and feedback

- `/help` — help with using Claude Code.
- Report issues: <https://github.com/anthropics/claude-code/issues>.
