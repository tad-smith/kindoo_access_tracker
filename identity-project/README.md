# Kindoo Identity Service — standalone project

A tiny Apps Script project that runs as the signed-in user, reads their
email, HMAC-signs it, and hands it back to the Workspace-owned Main
project of Kindoo Access Tracker.

This project is **deliberately separate** from the main Kindoo Apps
Script project. It lives in a **personal Google Drive** (not a
Workspace), has no bound Sheet, has no `clasp` configuration, and
contains only the two source files in this directory.

## Why this exists

The Main Kindoo script is bound to a backing Sheet in a Workspace
shared drive. That means its linked Cloud project is Workspace-owned,
and the Workspace tenant blocks consumer-Gmail users from authorizing
an `executeAs: USER_ACCESSING` deployment on that script — regardless
of "Who has access = Anyone with Google account", OAuth consent
screen being External + In production, Workspace Admin App access
controls being unrestricted, bare URL forms, and incognito browsing.
The block is at a level the deployment dialog can't override.

Splitting Identity into a personal-account project removes the
Workspace constraint for the sign-in flow while letting the Sheet
(and therefore Main) stay Workspace-owned. Main and Identity share a
single HMAC `session_secret` manually synchronized between two
locations; see "Rotating session_secret" below.

See `docs/architecture.md` D1 / D10 and `docs/open-questions.md` D-3
for the full discovery trail.

## Contract with Main

Identity signs a two-segment token:

```
<base64url(JSON({email, exp, nonce}))>.<base64url(HMAC-SHA256(payload, session_secret))>
```

Main's `Auth_verifySessionToken` (in `src/core/Auth.gs`) re-computes
the HMAC using its own copy of `session_secret` (read from the Main
Sheet's `Config.session_secret` cell) and accepts the token on match.
Payload TTL is 3600 seconds.

Both sides must use the same `session_secret` value. They are manually
kept in sync — see "Rotating session_secret" below.

## First-time setup

You need:
- A personal (non-Workspace) Google account with Drive access. Can be
  the deployer's personal Gmail, e.g. `first.last@gmail.com`.
- The Main Kindoo deployment already set up (Workspace-bound Sheet,
  Main deployed, `Config.session_secret` auto-generated, `Config.main_url`
  populated).

### Steps

1. In a browser, sign in to <https://drive.google.com> as the personal
   account.

2. Create a new Apps Script project:
   - <https://script.google.com/home> → **New project**.
   - The editor opens with a blank `Code.gs`.
   - Rename the project (top-left, default "Untitled project") to
     `Kindoo Identity Service`.

3. Paste the source files:
   - Select all content in the default `Code.gs` → Delete.
   - Copy the entire contents of `identity-project/Code.gs` from this
     repo → paste into the editor's `Code.gs`.
   - In the left sidebar, click **Project Settings** (gear icon).
     Enable **"Show `appsscript.json` manifest file in editor"**.
   - Go back to the editor. A new `appsscript.json` tab appears.
     Replace its contents with the contents of
     `identity-project/appsscript.json` from this repo.
   - Save (Ctrl/Cmd-S).

4. Set the two Script Properties (the shared state with Main):
   - **Project Settings** → scroll to **Script Properties** →
     **Add script property**.
   - Key: `session_secret`. Value: paste the current value from the
     Main Sheet's `Config.session_secret` cell.
   - Add another: Key: `main_url`. Value: paste from the Main Sheet's
     `Config.main_url` cell (the `/exec` URL, bare form —
     `https://script.google.com/macros/s/<ID>/exec`).
   - Save.

5. Deploy as web app:
   - **Deploy → New deployment → ⚙ → Web app**.
   - **Description:** `Kindoo Identity Service`.
   - **Execute as:** `User accessing the web app`.
   - **Who has access:** `Anyone with Google account`.
   - Click **Deploy**.
   - Authorize when Google prompts (you'll see the OAuth consent for
     the `userinfo.email` scope — click **Allow**).
   - Copy the Web app URL shown in the success dialog. Format:
     `https://script.google.com/macros/s/<IDENTITY_DEPLOYMENT_ID>/exec`.

6. Wire Main to use the new Identity URL:
   - Open the Main Sheet's `Config` tab.
   - Replace `identity_url` with the URL from step 5.
   - No redeploy of Main needed — Main reads `Config.identity_url`
     fresh on every request.

7. Test sign-in:
   - Open Main's `/exec` URL in an incognito window, signed in as a
     consumer-Gmail account (any Gmail account).
   - Click **Sign in with Google**.
   - First-time users: Google shows "Kindoo Identity Service wants to:
     View your email address" — click **Allow**. (Second and
     subsequent sign-ins are silent.)
   - The top frame navigates to Main's `/exec?token=<signed-token>`,
     Main verifies the HMAC, and the Hello page appears.

## Rotating `session_secret`

The shared secret is the only piece of state these two projects
coordinate on. Rotation invalidates every live session token (which
is the whole point of rotating).

Procedure:

1. In the Main Sheet's `Config` tab, **clear** the `session_secret`
   cell (delete its contents, leave the row).
2. Open the Main Apps Script editor and run `setupSheet`. The
   "ensure session_secret" step detects the empty cell and
   auto-regenerates a fresh ~73-char value.
3. Copy the new `session_secret` value from the Sheet.
4. Open this Identity project's Apps Script editor → Project Settings
   → Script Properties. Edit the `session_secret` value and paste the
   new one. Save.
5. No redeploy of either project is needed — both read their copy
   fresh on every request.

All existing live tokens are now invalid; users will be bounced back
through the Identity round-trip on their next action (silent for
returning users who've already granted the email-scope consent).

## Changing `main_url`

If you re-deploy Main to a new URL (creating a new deployment instead
of editing the existing one), the path is:

1. Update the Main Sheet's `Config.main_url` cell to the new URL.
2. Update this Identity project's `main_url` Script Property to the
   same value.
3. No code change needed.

## Changing Identity code

If the token format ever changes (e.g., a different payload schema or
a stronger signing scheme), both sides move in lockstep. The sequence is:

1. Change the Identity code in this repo (`identity-project/Code.gs`).
2. Change the Main code in this repo (`src/core/Auth.gs`).
3. Copy-paste the new `Code.gs` into the Identity Apps Script editor.
   Save. Redeploy Identity (Manage deployments → Edit → Version: New
   version → Deploy).
4. `npm run push` in this repo, then redeploy Main (Edit → Version:
   New version → Deploy).
5. Users' live tokens may or may not survive — if the payload schema
   changed, they'll be bounced to re-sign-in.

Do steps 3 and 4 close together; tokens issued by one and verified
by the other during the window will fail.

## Does this need `clasp`?

No. This directory is here for version control and copy-paste reference
only. There's no `.clasp.json`; `npm run push` in the main repo does
not touch this directory (it only pushes `src/`). Updates to Identity
are copy-paste into the editor.

If you'd prefer to manage Identity via clasp anyway, the shape would
be: add a second repo with its own `.clasp.json` pointing at the
personal-account Identity scriptId, or reorganize this one with two
`.clasp.*.json` configs and corresponding npm scripts. Not required.
