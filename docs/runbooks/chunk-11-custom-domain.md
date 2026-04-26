# Runbook — Chunk 11: custom domain via iframe wrapper

> **What this delivers.** `https://kindoo.csnorth.org` loads the app with no
> "This application was created by a Google Apps Script user" banner.
>
> **How.** A static `docs/index.html` page on GitHub Pages contains a
> full-viewport iframe pointing at the Main Apps Script `/exec` URL. Both
> Apps Script `doGet` deployments (Main and Identity) already set
> `HtmlService.XFrameOptionsMode.ALLOWALL` on every return path (verified
> in this branch — see Phase 1 audit), so cross-origin iframe embedding
> is permitted. The Apps Script `script.google.com` outer wrapper (the
> banner-bearing page) is no longer loaded at the top frame, so the
> banner is gone.
>
> **Estimated wall-clock time.** ~60–90 minutes, most of it waiting on
> DNS propagation + GitHub Pages HTTPS provisioning. Active operator
> work is ~20 minutes spread across the steps.

## Prerequisites

- Repo `kindoo_access_tracker` on GitHub with `main` branch up to date
  with the local working tree.
- Squarespace login for `csnorth.org` DNS administration.
- Access to the Apps Script project for both Main and Identity
  deployments (the editor / clasp).
- Access to the backing Sheet's `Config` tab (for Step 9 main_url edit).
- A second Google account (e.g. a non-manager bishopric tester) for the
  multi-user verification in Step 10.

## Pre-deploy checks (do before Step 1)

Before any external-system change, sanity-check the repo state:

- [ ] `git status` shows `main` is clean (or only the auto-stamped
      `src/core/Version.gs` modified — that's fine, it bumps on push).
- [ ] `grep -cn setXFrameOptionsMode src/core/Main.gs identity-project/Code.gs`
      reports `1` for `Main.gs` (the single Main `doGet` return) and `2`
      for `Code.gs` (one on the success return at line 117, one in the
      shared `Identity_errPage_` helper at line 154 that all three error
      branches funnel through).
- [ ] `docs/index.html` exists, contains the `AKfycb_REPLACE_ME` iframe
      `src` placeholder, and includes the same-origin query-string
      forwarder `<script>` block (so deep links and post-sign-in
      `?token=…` landings flow through to Main's `doGet`).

If any of these fail, stop and resolve before proceeding.

## Trade-offs accepted by this approach

Documented in `docs/architecture.md` §11 (rewritten in this chunk):

- **Browser back-button at the top frame leaves the app**, rather than
  navigating within it. The Chunk 10.6 in-app `pushState` is now
  inside a nested iframe context — back / forward still work *inside*
  the app (clicking nav links pushes iframe history), but the top
  frame's back button takes the user away from `kindoo.csnorth.org`
  entirely. Accepted because users do not typically use browser back
  in this app.
- **The auth flow's "Continue" click on Identity remains.** That click
  is required by the Apps Script iframe sandbox's user-activation rule
  for cross-origin top-frame navigation; nothing about the wrapper
  changes it. Out of scope for Chunk 11.
- **One nested iframe boundary remains.** Apps Script wraps `doGet`
  output in its own internal iframe on `*.googleusercontent.com`; the
  wrapper iframe at `kindoo.csnorth.org` sits one level above that.
  This is fine for every supported flow.

---

## Step 1 — Audit existing Squarespace DNS

**What.** Capture a snapshot of the current `csnorth.org` DNS records so
nothing is touched accidentally.

**How.**

1. Log into `domains.squarespace.com` with the account that holds the
   `csnorth.org` domain.
2. Open `csnorth.org` → DNS Settings.
3. Take a screenshot or full-record export of the zone.
4. Confirm there is **no existing `kindoo` host** (no `kindoo.csnorth.org`
   A / AAAA / CNAME record). If there is — stop and reconcile before
   proceeding; the wrapper deploy assumes the host is unused.
5. Identify and **leave untouched** every Workspace email record:
   any `MX`, `TXT` (SPF / DMARC / Google site-verification), or
   `selector._domainkey.csnorth.org` (DKIM) record. Touching these
   would break Workspace mail and the `@csnorth.org` Google Groups.

**Verify.**

```sh
dig +short kindoo.csnorth.org A
dig +short kindoo.csnorth.org CNAME
```

Both should return empty (no record yet).

**Rollback.** None — read-only step.

---

## Step 2 — Enable GitHub Pages on `kindoo_access_tracker`

**What.** Configure GitHub Pages to serve `docs/` from the `main`
branch at the custom domain `kindoo.csnorth.org`.

**How.**

1. On GitHub, open `Settings → Pages` for the `kindoo_access_tracker`
   repo.
2. **Source:** branch = `main`, folder = `/docs`. Save.
3. **Custom domain:** enter `kindoo.csnorth.org`. Save.
   GitHub will run a DNS check immediately and warn that the host
   doesn't resolve — that's expected; we add the CNAME in Step 3.
4. **Enforce HTTPS:** leave UNCHECKED for now. The checkbox is
   greyed-out until the certificate provisions, which can't happen
   until DNS resolves. We come back to this in Step 4.
5. Saving the custom domain creates a `docs/CNAME` file on `main`
   containing `kindoo.csnorth.org`. Pull or refresh local `main` so
   subsequent commits include it.

**Verify.**

- `Settings → Pages` shows the custom domain entered, with a yellow /
  red banner about DNS not resolving.
- `git pull` then `cat docs/CNAME` shows `kindoo.csnorth.org` on a
  single line.

**Rollback.** `Settings → Pages → unset custom domain` and revert the
auto-created `docs/CNAME` file.

---

## Step 3 — Add the Squarespace CNAME record

**What.** Point `kindoo.csnorth.org` at GitHub Pages.

**How.**

1. Squarespace `csnorth.org` → DNS Settings → Add record.
2. **Type:** `CNAME`.
3. **Host:** `kindoo` (Squarespace appends `.csnorth.org` automatically).
4. **Points to / Data:** `<github-username>.github.io`
   (replace `<github-username>` with the GitHub user/org that owns
   `kindoo_access_tracker`; no trailing dot in the Squarespace UI).
5. **TTL:** default.
6. Save.

> **Touch nothing else.** The MX, SPF (TXT), DKIM
> (`selector._domainkey`), and DMARC (`_dmarc TXT`) records must all
> remain exactly as captured in Step 1.

**Verify.**

```sh
dig +short kindoo.csnorth.org CNAME
# Expect: <github-username>.github.io.
```

Propagation typically takes 5–30 minutes; re-run `dig` until it
returns the CNAME. If it stays empty after 60 minutes, double-check
the host field in Squarespace (`kindoo` not `kindoo.csnorth.org`) and
that you saved the record.

**Rollback.** Delete the CNAME record in Squarespace.

---

## Step 4 — Verify GitHub Pages health + provision HTTPS

**What.** Confirm GitHub Pages picks up DNS, then turn on
`Enforce HTTPS`.

**How.**

1. Wait until `dig +short kindoo.csnorth.org CNAME` returns the
   GitHub Pages target (Step 3 verify).
2. Return to `Settings → Pages`. The DNS warning should clear within
   a few minutes; if not, click "Check again" if available.
3. GitHub provisions a Let's Encrypt cert automatically once DNS
   resolves. Wait for the `Enforce HTTPS` checkbox to become
   enable-able (5–15 minutes after DNS propagated). Tick it.
4. Hit `https://kindoo.csnorth.org` in a browser.

**Verify.**

- `https://kindoo.csnorth.org` loads (no cert warning).
- The page renders the wrapper HTML; the iframe inside is empty /
  refused — that's expected because the iframe `src` is still the
  placeholder `AKfycb_REPLACE_ME`. We replace it in Step 6.
- DevTools → Network shows the wrapper HTML served with HTTP/2 from
  GitHub Pages (`server: GitHub.com`).

**Rollback.** Untick `Enforce HTTPS` (HTTP still serves while the cert
remains issued; GitHub keeps the cert around for ~24 h).

---

## Step 5 — Confirm the live Apps Script deployments serve `ALLOWALL`

**What.** Make sure the running Main and Identity `/exec` URLs are
serving code that sets `setXFrameOptionsMode(ALLOWALL)` on every
`doGet` return path. **The repo already has ALLOWALL on both projects
(verified during Phase 1 audit).** This step is therefore a *push +
verify* step, not a code-change step.

**How.**

1. Push the latest `main` to Apps Script:
   ```sh
   npm run push
   ```
   (`scripts/stamp-version.js` will bump `src/core/Version.gs`; that's
   normal and produces an uncommitted diff you can commit afterwards
   if desired.)
2. **Do NOT create a new deployment.** Open Apps Script editor for the
   Main project → Deploy → Manage deployments → Edit the existing
   active deployment → Deploy → "New version". This produces a new
   *version* but **preserves the existing `/exec` URL**. New
   deployments would mint a fresh URL, invalidating
   `Config.main_url`, the Identity project's `main_url` Script
   Property, and every shortcut/bookmark anyone has.
3. Repeat for the Identity project: open its Apps Script editor (it
   lives in a personal Google account; see
   `identity-project/README.md`), paste in any updated `Code.gs` (the
   identity project is **not pushed via clasp** — it's copy-paste).
   The current `identity-project/Code.gs` in the repo already has
   ALLOWALL on every return path; copy-paste only if the editor
   contents drift from the repo. Then Deploy → Manage deployments →
   Edit → New version on the existing deployment.

**Verify.**

1. Open the **Main** `/exec` URL directly in a browser (the raw
   `script.google.com/macros/s/<id>/exec`). The app loads — the
   pre-Chunk-11 banner is still visible because we're hitting Apps
   Script's outer wrapper directly, but the app itself works.
2. Open **DevTools → Network**, reload the Main `/exec`, click the
   top-level document response, and inspect response headers. The
   `X-Frame-Options` header should be **absent** (ALLOWALL removes
   it). If you see `X-Frame-Options: DENY` or `SAMEORIGIN`, the
   deployed version is older than the ALLOWALL change — re-run
   `npm run push` and re-deploy a new version of the existing
   deployment, then re-check.
3. Also load the **Identity** `/exec` URL directly. It will redirect
   you toward Main with a `?token=...` (because Identity's job is to
   sign the redirect). Capture the network response for
   Identity's `/exec` itself (the first hop) — same check: no
   `X-Frame-Options` header.

**Rollback.** If a regression slips in, revert the relevant `.gs`
file to the prior version and Deploy → New version on the existing
deployment.

---

## Step 6 — Replace the placeholder iframe `src` with the real Main URL

**What.** Edit `docs/index.html`, replace the placeholder iframe `src`
with the actual Main `/exec` URL, commit, push.

**How.**

1. Read the Main deployment's `/exec` URL from the Apps Script editor
   (Manage deployments → copy the active Web app URL) **or** from the
   Sheet's `Config` tab `main_url` cell — they should match.
2. Local edit:
   ```sh
   sed -i '' \
     "s|https://script.google.com/macros/s/AKfycb_REPLACE_ME/exec|<MAIN_EXEC_URL>|" \
     docs/index.html
   ```
   (Or open the file in an editor and replace by hand. Place the URL
   inline; the file is short.)
3. `git diff docs/index.html` — confirm the only change is the
   `src=` URL.
4. `git add docs/index.html` and commit with message
   `Chunk 11: replace wrapper iframe src with Main /exec URL`.
5. `git push origin main`.
6. GitHub Pages redeploys automatically; takes ~1–2 minutes.

**Verify.**

- Hit `https://kindoo.csnorth.org` in a fresh browser tab. The app's
  Login page renders inside the iframe — because the wrapper origin
  has no `sessionStorage.jwt` yet.
- DevTools → Elements → confirm the iframe `src` is the real `/exec`
  URL.
- DevTools → Network → reload — the iframe document response should
  have no `X-Frame-Options` header (Step 5 verified the same; this
  re-verifies that the wrapper actually loaded it).
- **Quick query-string-forwarder check.** Hit
  `https://kindoo.csnorth.org/?p=mgr/seats` in DevTools-open. Even
  though you're not signed in (Login page still renders), DevTools →
  Network → click the iframe document request and confirm the
  request URL is `…/exec?p=mgr/seats` — the wrapper's same-origin
  forwarder copied the query string into the iframe `src`. If the
  request URL is just `…/exec` (no `?p=`), the JS forwarder didn't
  run; check Console for errors and confirm `docs/index.html`
  contains the `<script>` block.

**Rollback.** Revert the `docs/index.html` commit on `main` and push;
GitHub Pages restores the placeholder. The wrapper is broken (iframe
fails to load) but `kindoo.csnorth.org` itself stays up.

---

## Step 7 — First end-to-end auth test (pre-`main_url` change)

**What.** Confirm the auth round-trip still works *before* changing
`Config.main_url`. At this step the Continue click on Identity sends
the user to the raw Main `/exec` URL (since `main_url` is still that
value). That's the expected interim state.

**How.**

1. Open an **incognito** browser window (no `sessionStorage.jwt`).
2. Navigate to `https://kindoo.csnorth.org`. The Login page renders
   inside the wrapper iframe.
3. Click "Sign in with Google". Top frame navigates to Identity's
   `/exec`. (The wrapper is gone for this hop — Identity is on
   `script.google.com`.)
4. Identity reads `Session.getActiveUser` and renders the Continue
   page. Click Continue.
5. Top frame navigates to **the raw Main `/exec` URL** with
   `?token=<signed>`. The app loads. The banner is visible at this
   step because we're at the raw `/exec` URL, not the wrapper.
6. The Dashboard (or role-default page) renders for the signed-in
   user.

**Verify.**

- Auth completed without errors; the user lands on their default page.
- Address bar shows `script.google.com/macros/...` (not yet
  `kindoo.csnorth.org`) — that's expected at this step.

**Rollback.** None; nothing has been changed in this step.

> **If sign-in fails here**, do not proceed to Step 8. Likely causes:
>
> - The Identity project's `main_url` Script Property is set to
>   something other than the Main `/exec` URL — fix it in
>   Identity's Apps Script editor (Project Settings → Script
>   Properties).
> - Identity's `session_secret` Script Property does not match the
>   Main Sheet's `Config.session_secret` — copy from the Sheet to the
>   Script Property.
> - The user hasn't yet authorised the Identity service to read
>   their email — they'll see a Google consent prompt; clicking
>   Allow self-heals.

---

## Step 8 — Update `Config.main_url` to the wrapper origin

**What.** Change `Config.main_url` from the raw Main `/exec` URL to
`https://kindoo.csnorth.org`. This is the **flip-the-switch step**:
afterward, every Identity → Main redirect lands at the wrapper origin
instead of the raw `/exec` URL, so the user ends up inside the
wrapper iframe with no banner.

**Important.** `main_url` is in `CONFIG_PROTECTED_KEYS_` in
`src/repos/ConfigRepo.gs` — the manager Configuration page renders it
read-only. The edit must be made **directly in the bound Sheet's
`Config` tab**, not through the app UI. The deployer (who has Sheet
write access) makes the change.

**This step is the most reversal-sensitive one in the runbook.** Once
`main_url` points at the wrapper, the auth round-trip's final hop
lands at `kindoo.csnorth.org`. If the wrapper is broken (DNS issue,
GitHub Pages outage, missed iframe URL replace from Step 6, missing
ALLOWALL on a doGet path), users on a fresh sign-in will not reach
the app — they'll land on whatever `kindoo.csnorth.org` currently
serves. Make sure Steps 1–7 verified clean before doing this step.

**How.**

1. Open the bound Sheet (Apps Script editor → Resources → backing
   spreadsheet, or open the Sheet in Drive directly).
2. Go to the `Config` tab.
3. Find the row whose `key` cell is `main_url`.
4. Edit the `value` cell from the raw `/exec` URL to:
   `https://kindoo.csnorth.org`
5. Hit Enter to commit the cell edit.
6. **No audit row will be written for this edit** — direct Sheet
   edits bypass `AuditRepo`. That's a known property of the protected
   Config keys (open-questions.md C-4); document the change in the
   chunk-11 changelog instead.

**Verify.**

- Re-open the `Config` tab, confirm the `main_url` value reads
  `https://kindoo.csnorth.org` exactly (no trailing slash, no
  trailing whitespace).
- The Apps Script `Config_get('main_url')` cache TTL is 60 s
  (`Config_getAll`, see `architecture.md` §7.5). The new value is
  picked up by Main's `doGet` and `Identity_serve`'s redirect within
  60 seconds without any reinstall step. (Identity reads `main_url`
  from its own Script Properties, NOT from the Sheet. **If
  `Config.main_url` is being updated to the wrapper, the matching
  Script Property `main_url` in the Identity project must be updated
  to the same value — otherwise Identity will keep redirecting to the
  raw `/exec` URL.**)
7. **Update Identity's `main_url` Script Property to
   `https://kindoo.csnorth.org`** — Apps Script editor for the
   Identity project → Project Settings → Script Properties → edit the
   `main_url` value to match the Sheet.

**Rollback.** Two cells, both edited back:
1. The Sheet's `Config.main_url` reverts to the raw Main `/exec` URL.
2. Identity project's `main_url` Script Property reverts to the same.
After both are reverted, users on next sign-in land back on the raw
`/exec` URL — banner visible but the app works. Cache TTL applies (up
to 60 seconds before the Sheet revert is observed).

---

## Step 9 — Final end-to-end auth test (post-`main_url` change)

**What.** Repeat Step 7's flow with `main_url` now pointing at the
wrapper. The full success criterion for Chunk 11 is met when this
test passes.

**How.**

1. Open a **fresh** incognito browser window.
2. Navigate to `https://kindoo.csnorth.org`. Login page renders inside
   the iframe.
3. Click "Sign in with Google". Top frame navigates to Identity.
4. Click Continue on Identity. Top frame navigates to
   `https://kindoo.csnorth.org/?token=<signed>`.
5. The wrapper iframe loads Main with the token in the query string.
   Main verifies the HMAC, drops the token into `sessionStorage.jwt`,
   reloads the iframe to bare `https://kindoo.csnorth.org`. The
   Dashboard (or role-default page) renders.

**Verify.**

- Address bar shows `https://kindoo.csnorth.org` (no `?token`, no
  `script.google.com`).
- The "This application was created by a Google Apps Script user"
  banner is **not visible** anywhere in the viewport.
- Dashboard cards render correctly (Pending / Recent Activity /
  Utilization / Warnings / Last Operations).
- Clicking a nav link inside the app (e.g. "All Seats") swaps the
  content area client-side (Chunk 10.6's pushState) without a full
  reload. The iframe URL changes; the top-frame URL stays at
  `https://kindoo.csnorth.org`.

**Rollback.** Step 8 rollback (revert both `main_url` values).

---

## Step 10 — Smoke test of full app functionality

**What.** Walk both a manager and a non-manager (bishopric) account
through the typical flows to catch regressions.

**How (manager account).**

1. From `https://kindoo.csnorth.org`, signed in as a manager:
2. Dashboard → confirm all five cards render with real data.
3. Click "All Seats" in nav → roster table loads.
4. Apply a filter (e.g. ward = CO) → table updates client-side.
5. Click "New Request" or any other deep-linkable page → page swaps;
   in-app browser back returns to the prior page.
6. Submit a test request (an `add_temp` against a test member email
   you can clean up after); receive the manager-notification email.
7. Mark the request complete; receive the requester-completion
   email.
8. Audit Log → filter by `entity_type=Seat` and confirm the
   complete + insert rows appear.
9. **Already-signed-in deep-link test.** From the same browser
   session (so `sessionStorage.jwt` is set on the wrapper origin),
   open `https://kindoo.csnorth.org/?p=mgr/seats&ward=CO` in a new
   tab. The wrapper's same-origin query-string forwarder copies
   `?p=mgr/seats&ward=CO` into the iframe `src`; the user lands on
   All Seats with the CO ward filter pre-applied.
   (Note: a deep link opened in a fresh incognito window — i.e. with
   no `sessionStorage.jwt` — would lose the `?p=` through the
   sign-in round-trip, because Identity's redirect carries only
   `?token=…`. That's a known gap documented in `open-questions.md`
   CF-2 and out of scope for Chunk 11.)

**How (bishopric account, separate incognito window).**

1. Sign in as a bishopric member of one ward.
2. Roster loads scoped to their ward only.
3. Submit an add request; confirm it appears under "My Requests".
4. Confirm the manager-notification email arrived in the manager's
   inbox.

**Verify.**

- Every nav link works without a full top-frame reload.
- Modals (e.g. Mark Complete confirmation) open / close cleanly
  inside the wrapper iframe.
- Toast notifications surface inside the iframe (visible without
  scrolling).
- Filter URLs deep-link correctly *for already-signed-in users*:
  pasting `https://kindoo.csnorth.org/?p=mgr/audit&action=over_cap_warning`
  into a new tab of the same browser session lands on the Audit Log
  filtered. (Pre-sign-in deep links lose `?p=` through the auth
  round-trip — known gap, see `open-questions.md` CF-2.)
- Email send-and-receive works (notifications arrive at
  `@gmail.com` / `@csnorth.org` recipients).

**How (Workspace email + Groups regression check).**

This step verifies the Step 1–3 DNS work didn't accidentally break
mail. Should be fast.

1. From an external account (not a Group member), send an email to
   one of the active `@csnorth.org` Google Group addresses (e.g. one
   used in `KindooManagers` if the team uses a Group alias).
2. Confirm delivery to the Group's recipients.
3. Confirm an `@csnorth.org` user can send mail out and receive
   replies.

**Rollback.** None — read-only / no-op tests at this point.

---

## Rollback summary (worst case)

If Chunk 11 has shipped fully but a problem surfaces post-cutover:

1. **Revert `main_url`** in both the Sheet's `Config.main_url` cell
   and Identity's `main_url` Script Property to the raw Main `/exec`
   URL. Wait up to 60 seconds for the Config cache to expire. Users
   are now back on the unwrapped `/exec` experience — the banner is
   visible but the app works.
2. **Optionally** revert `docs/index.html` to the placeholder by
   reverting the Step 6 commit; GitHub Pages redeploys in ~2 minutes.
   `https://kindoo.csnorth.org` will then 404 inside the iframe but
   the wrapper page itself still loads.
3. **Squarespace CNAME** can stay in place — pointing `kindoo` at
   GitHub Pages is harmless when the wrapper is reverted, and
   re-removing it would force a re-propagation cycle when re-trying.

The cutover is fully reversible at the `main_url` step alone — Steps
1–7 are additive (new DNS host, new GitHub Pages site, new wrapper
HTML, ALLOWALL was always there). The only behaviour-affecting step
is Step 8.

## Troubleshooting

### Symptom: `https://kindoo.csnorth.org` shows a Google
*"We're sorry, but you do not have access to this page"* 403 inside the iframe

**First thing to try: redeploy a new version of the existing Main
deployment.** Apps Script editor → Deploy → Manage deployments → Edit
the existing active Main deployment → Deploy → New version. Preserves
the `/exec` URL. This resolves the most common class of cause —
**the live deployment is serving an older version of the source code
than `npm run push` synced.** `clasp push` updates the script source
in the project; it does *not* bump the live `/exec` deployment to
that source. Only the editor-side "New version" step does that. It is
easy to read Step 5 of this runbook as a no-op when ALLOWALL "is
already in the code" and skip the editor half — leaving the live
deployment pinned to whatever version was last associated with it.

After redeploying, re-test in a freshly-opened incognito window. The
iframe should now render the app's Login page (or, for an
already-Google-signed-in user, deep-link straight to the role default
post-`Config.main_url` cutover).

If the redeploy doesn't fix the 403, escalate to one of:

- **Confirm Main's deployment URL in the wrapper matches `Config.main_url`'s
  pre-cutover value.** Open `docs/index.html` and the Apps Script editor
  → Deploy → Manage deployments. The iframe `src` should be the active
  Main deployment's `/exec` URL. A wrapper iframe pointing at a
  different (older or new-but-unintended) deployment URL would explain
  divergent behaviour.
- **Confirm ALLOWALL is on the live deployment.** Open the raw Main
  `/exec` URL directly in a browser, DevTools → Network → top-level
  document response → response headers should NOT include
  `X-Frame-Options`. If it shows `X-Frame-Options: DENY` or
  `SAMEORIGIN`, the deployed version predates ALLOWALL — the redeploy
  is the fix; if redeploy didn't take, check that the editor's
  "Manage deployments" actually saved the new version (the dialog can
  be cancelled mid-way).
- **Last resort, change Main's `webapp.access` to `ANYONE_ANONYMOUS`.**
  In `src/appsscript.json`, change `"access": "ANYONE"` to
  `"access": "ANYONE_ANONYMOUS"`. Push + redeploy. Removes the
  Apps-Script-side Google-sign-in gate entirely; the HMAC token flow
  remains the actual authentication. This is the right fix only if
  the 403 is genuinely the gate firing on a signed-out user inside
  the iframe (the gate's redirect to `accounts.google.com` cannot
  render in an iframe — Google's sign-in page sets its own
  `X-Frame-Options`). If a redeploy of current source fixes the
  problem, the manifest change is unnecessary.

### Symptom: iframe loads but the post-sign-in `?token=…` doesn't reach Main

`Config.main_url` is the wrapper origin AND Identity's `main_url` Script
Property must be the wrapper origin. If only one of the two was updated
in Step 8, Identity's redirect lands on whichever URL the Script Property
holds — which may be the raw `/exec`, breaking the round-trip. Fix: set
both. Apps Script editor for the Identity project → Project Settings →
Script Properties → confirm `main_url = https://kindoo.csnorth.org`.

### See also

- `docs/open-questions.md` CF-5 — the `clasp push` ≠ deployment
  update gotcha, recorded so future operators can find this fix
  quickly without rediscovering it.

## After verification

When Step 9 + 10 pass cleanly, return to Claude with the verification
results so the chunk-11 changelog can be written from measured outcomes
(Phase 2 of the chunk).
