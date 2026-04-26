# Open questions

Things in the spec that are ambiguous, underspecified, or likely to bite us during implementation. Ordered by severity. Each entry lists: the uncertainty, why it matters, and my best-guess answer so we can proceed if we have to.

Tagged `[P0]` = would block or need to reopen a decision inside Chunk 1–3; `[P1]` = answerable during the relevant chunk; `[P2]` = low-risk, answerable at build time.

---

## Auth and identity

### A-1 `[RESOLVED 2026-04-19]` Users sign in with consumer Gmail accounts, not a shared Workspace domain.

Confirmed by the project owner. Downstream consequences:

- `Session.getActiveUser().getEmail()` can't be used — it returns empty cross-customer. It has been removed from the auth plan.
- Auth pivots to **Google Sign-In (GSI) with server-side JWT verification**. See architecture.md D10 and §§4–5.
- `webapp.access` is `ANYONE` in the manifest, shown as "Anyone with Google account" in the deploy dialog (D2 updated).
- A one-time OAuth 2.0 Client ID setup in Google Cloud Console is added to the deployment steps (sheet-setup.md).
- `Config.gsi_client_id` is a new required key; seeded manually before first deploy.
- Chunk 1 scope grows to include: `Login.html`, `verifyIdToken` with JWKS caching, token-plumbing through `rpc`, and every `api/` endpoint taking the JWT as its first argument.

New open questions created by the GSI pivot are tracked as A-3, A-4, A-5 below.

### A-3 `[P1]` Token lifetime and re-login UX

GSI ID tokens are valid for 1 hour. Our plan stores the JWT in `sessionStorage`; when it expires mid-session, the next `rpc` call will fail and the client will prompt re-login.

**Best guess:** Acceptable. This is internal, weekly-use software — a re-login prompt once per session is fine. If it becomes annoying, we can move to the full GSI OAuth flow with a refresh token, or use the JavaScript library's silent token refresh.

### A-4 `[P1]` `aud` verification with a Config-held client_id

Verification requires `aud === Config.gsi_client_id`. If a manager edits that key mid-session, everyone's tokens are rejected until they re-sign-in. Not a bug — just behaviour to document for the Configuration page.

**Best guess:** Add an inline warning on the Config page next to `gsi_client_id`: "Changing this value will log out every user." Soft-UX guard, no code-level lock needed.

### A-5 `[P1]` GSI on a Cloudflare-Workered custom domain

The Google OAuth Client ID needs the exact origin allowlisted. If we proxy through `kindoo.csnorth.org`, that's the origin GSI sees — even though the server hop ends at `script.google.com`. The Client ID must therefore list:

- `https://kindoo.csnorth.org` (the user-visible origin)
- `https://script.google.com` (the Apps Script execution domain)

And any intermediate redirect URIs if we ever move beyond the popup/One-Tap flow.

**Best guess:** Straightforward; add to the Cloudflare Worker runbook in Chunk 11. The interaction with the OAuth-redirect concern in CF-1 is independent — GSI is popup/JS-based and doesn't use the server-side OAuth redirect that Apps Script's "Sign in to run this" uses.

### A-2 `[P1]` What email address sends the notifications?

`MailApp.sendEmail()` always sends from the effective user — which, with `executeAs: USER_DEPLOYING`, is the deployer. Replies go back to the deployer's inbox.

**Best guess:** Acceptable; deployer is a Kindoo Manager and will forward or triage replies.

**If wrong:** We'd need to add a shared mailbox or use `GmailApp` with delegation, which changes the OAuth scope surface.

### A-6 `[RESOLVED 2026-04-19]` Personal Email column = user's Gmail sign-in address

Confirmed. The `Personal Email` column in the callings sheet is the Gmail the person actually signs in with. The importer writes it (lowercased) into `Access`; role resolution matches the GSI-verified email claim against that same value. One possible wrinkle noted in I-8 below.

### A-7 `[RESOLVED 2026-04-19]` OAuth consent screen publishing status

**Publish the app** (not Testing). The `openid`/`email`/`profile` scopes don't require Google verification, so publication is immediate. Test-users list is irrelevant and removed from the deployment checklist.

### A-8 `[RESOLVED 2026-04-19]` All browser-initiated Google OAuth from inside Apps Script HtmlService is blocked — switch to two-deployment Session+HMAC

**Discovery (Chunk 1).** The Chunk 0 plan called for Google Identity Services' (`gsi/client`) drop-in button rendered in `Login.html`. **Three pivots** showed that *no* browser-initiated Google OAuth flow can succeed from inside an Apps Script HtmlService iframe.

#### Why no browser-initiated OAuth works

1. Apps Script HtmlService (the only HTML rendering option for an Apps Script web app) sandboxes user-supplied HTML inside a per-script iframe on `https://n-<hash>-script.googleusercontent.com`. That's the origin `window.location.origin` returns inside the page — `script.google.com` is the *parent* frame.
2. GSI's `google.accounts.id.initialize` checks the iframe's origin against the OAuth Client ID's Authorized JavaScript origins.
3. Cloud Console rejects `*.googleusercontent.com` origins with "Invalid Origin: uses a forbidden domain." Permanent denylist (rationale: googleusercontent.com hosts user-uploaded content across many Google products, so allowing it as an OAuth origin would let arbitrary user content impersonate any app). No workaround at the OAuth-client-config level.
4. **First pivot (didn't work):** OAuth 2.0 *implicit* flow (`response_type=id_token`) with a same-tab redirect to `accounts.google.com`. Hypothesis: `accounts.google.com` only checks `redirect_uri`, not the calling page's origin. **Wrong.** `accounts.google.com/o/oauth2/v2/auth` inspects the request's `Origin` / `Referer` for *all* browser-initiated flows and rejects with `origin_mismatch` (HTTP 400) when the origin isn't on the JS-origin allowlist.
5. **Second pivot (also didn't work):** OAuth 2.0 *authorization code* flow (`response_type=code`) with server-side token exchange. The server-side exchange (`UrlFetchApp.fetch` POST to `oauth2.googleapis.com/token`) does escape the origin check — Google validates only the `redirect_uri` for that POST. **But the initial browser GET to `accounts.google.com/o/oauth2/v2/auth` happens first, and that request still gets `origin_mismatch`.** The second pivot died in the same place as the first.
6. We also tried `<meta name="referrer" content="no-referrer">`, `rel="noreferrer"` on anchors, and programmatic-anchor-click navigation. All failed: modern browsers leak the iframe origin via `Sec-Fetch-Site` and other headers we can't suppress from JS. Google's debug page after the failure showed `origin: https://n-<hash>-script.googleusercontent.com` directly.

#### Resolution: two-deployment `Session.getActiveUser` + HMAC-signed session token

The only Apps-Script-native primitive that returns the user's email reliably for consumer Gmail is `Session.getActiveUser` under `executeAs: USER_ACCESSING`. The catch — covered in the original D10 reasoning — is that `USER_ACCESSING` makes the script run with the user's permissions, so the user would need read access to the backing Sheet, breaking the privacy model.

The fix: **split identity into a separate deployment** of the same script project.

- **Main deployment** (`executeAs: USER_DEPLOYING`, URL stored in `Config.main_url`): renders all UI, reads/writes the backing Sheet under the deployer's identity (so the Sheet stays private to the deployer).
- **Identity deployment** (`executeAs: USER_ACCESSING`, URL stored in `Config.identity_url`): runs `Session.getActiveUser().getEmail()`, HMAC-signs `{email, exp, nonce}` with `Config.session_secret`, renders a tiny HTML page that navigates the top frame back to Main with the token in the query string.

Same script project, same `appsscript.json`, same code — just two different deployments with different `executeAs` settings. `Main.doGet` routes by comparing `ScriptApp.getService().getUrl()` against `Config.identity_url` (and accepts `?service=identity` as an explicit override for smoke-testing fresh Identity deployments before their URL is in Config).

The HMAC signature lets Main *trust* what Identity returns without sharing a database — the only shared state is `Config.session_secret`, which both deployments read from the same Sheet (because both are deployments of the same script project bound to the same Sheet).

#### Sign-in flow

1. User visits Main `/exec`. No session token → render Login button.
2. Click → top navigates to Identity `/exec`.
3. Identity deployment runs:
   - `Session.getActiveUser().getEmail()` returns the user's email (works for consumer Gmail because the script runs as the user).
   - First-time per user: Google prompts the standard "Kindoo Access Tracker wants to: View your email address" consent. Non-sensitive scope, no Google review required, immediate accept.
   - HMAC-sign `{email, exp, nonce}` with `Config.session_secret` (HMAC-SHA256 via `Utilities.computeHmacSha256Signature`).
   - Token format: `<base64url(payload)>.<base64url(sig)>` — two segments, distinguishable from a JWT.
   - Render HTML that does `window.top.location.replace(MAIN_URL + '?token=…')`.
4. Top navigates back to Main `/exec?token=…`. Main's `doGet` verifies the HMAC, drops the token into the rendered Layout HTML as `INJECTED_TOKEN`. Client stashes it in `sessionStorage`, reloads top to clean `MAIN_URL` (strips `?token` from address bar).
5. Subsequent rpc calls pass the token; server re-verifies HMAC + checks `exp` on each call. HMAC re-verify is pure local CPU — no network — so cheap.

#### Cost vs. benefit

**Removed:**
- No OAuth client in Cloud Console at all (no `gsi_client_id`, no `gsi_client_secret`, no Authorized JS origins / redirect URIs to manage).
- No JWT/JWKS code (~150 lines of BigInt RSA verifier + JWKS cache deleted from `Auth.gs` + `Utils.gs`).
- No third-party identity dependency — Google's own `Session.getActiveUser` is the source of truth.
- Cloudflare Worker (Chunk 11) gets simpler too: no auth-redirect concerns, since auth is internal to script.google.com.

**Added:**
- Second web app deployment (~2 minutes one-time setup; Apps Script supports multiple deployments per project).
- Two new `Config` keys (`main_url`, `identity_url`) + an auto-generated `session_secret`.
- One-time per-user OAuth consent on the Identity deployment for the email scope. UI: standard "Kindoo Access Tracker wants to: View your email address" — non-scary, immediate accept.

#### Spec impacts

Reflected in:
- `spec.md` §2 (Auth bullet rewritten for the two-deployment Session+HMAC pattern; no OAuth)
- `architecture.md` D10 (rewritten with all three failed approaches called out as discoveries) + §4 (request-lifecycle Mermaid diagram redrawn with two top frames + two iframes for the round-trip) + §3 directory structure (`services/Identity.gs` added) + §12 quick-reference table (rows updated)
- `data-model.md` Config tab (`gsi_client_id` and `gsi_client_secret` removed; `main_url`, `identity_url`, `session_secret` added)
- `sheet-setup.md` steps 11–15 (rewritten: deploy Main, deploy Identity, paste URLs into Config, one-time per-user consent on Identity)
- `services/Setup.gs` (drop OAuth keys; seed new keys; auto-generate `session_secret`)
- `services/Identity.gs` (new file)
- `core/Auth.gs` (delete `Auth_verifyIdToken` / JWKS / `Auth_exchangeAuthCode`; add `Auth_signSessionToken` / `Auth_verifySessionToken`)
- `core/Utils.gs` (delete BigInt RSA helpers; add `Utils_base64UrlEncode` / `Utils_base64UrlEncodeBytes`)
- `chunk-1-scaffolding.md` deviation list (all three pivots recorded)

#### Future-proofing

- **Token expiry:** session tokens last 1 hour by default (matching what GSI's id_token TTL would have been). After expiry, the user is bounced back through the Identity deployment, which is silent for consumer Gmail (no re-prompt) since `Session.getActiveUser` returns immediately. Net UX impact: a brief redirect every hour.
- **Cloudflare Worker (Chunk 11):** the worker proxies `kindoo.csnorth.org/*` to Main `/exec`. The Identity URL stays on `script.google.com` directly (the user briefly sees `script.google.com` in the address bar during the round trip; acceptable since it's clearly a Google-owned domain). Re-evaluate at Chunk 11.
- **`session_secret` rotation:** clear the Config cell and re-run `setupSheet`. All live tokens become invalid (users re-sign-in). Document as the rotation procedure.

### A-9 `[RESOLVED 2026-04-19]` `webapp.access` manifest enum value

The Chunk 0 docs/manifest used `"ANYONE_WITH_GOOGLE_ACCOUNT"`, which is the *deploy dialog's human-readable label* — not the manifest enum. The actual enum is **`ANYONE`** (sign-in required; `ANYONE_ANONYMOUS` is the no-sign-in variant). Surfaced when `clasp push` rejected the manifest with `Expected one of [UNKNOWN_ACCESS, DOMAIN, ANYONE, ANYONE_ANONYMOUS, MYSELF]`. Behaviour intent unchanged — sign-in required, no domain restriction. Spec corrected in `spec.md` §2, `architecture.md` D2, `build-plan.md` Chunk 1, `sheet-setup.md` checklist.

---

## Importer

### I-1 `[RESOLVED 2026-04-19]` Importer atomicity on partial failure — agreed

Approach confirmed: build the full per-tab diff in memory before applying anything. If parse fails for a tab, skip that tab's mutations and emit an `import_error` audit row with actor `Importer`. Lock is acquired once and covers all applies. Other tabs in the same run proceed.

### I-2 `[RESOLVED 2026-04-20]` Missing tab in the callings sheet

**Decision (Chunk 3):** Skip. Wards whose `ward_code` does not match a tab in the callings spreadsheet keep their existing auto-seats and Access rows untouched. The importer records the list of unmatched ward_codes in the `import_end` audit payload's `warnings` field and surfaces them on the Import page's "Warnings from last run" details block. No per-ward audit row is written — the `import_end` bracket carries the full warning list, which is enough for triage and avoids cluttering AuditLog on every run with repeat warnings.

This matters because a tab rename in the callings sheet (human typo) would otherwise delete every auto-seat for that ward. The implementation therefore only diffs scopes that actually appeared in the current run (`scopesSeen`). Scopes not in that set are inert.

### I-3 `[P1]` Multi-person callings: multiple rows vs. extra email columns

Spec says multi-person callings use extra columns to the right of `Personal Email`. But what if the source sheet instead has multiple rows with the same `Position`? (e.g., "CO Elders Quorum Counselor" on two separate rows.)

**Best guess:** Treat both representations identically — union all `(calling, email)` pairs from all rows. No harm in being permissive.

### I-4 `[RESOLVED 2026-04-19]` `Organization` and `Forwarding Email` columns

Confirmed — **`Forwarding Email` is used for other (non-Kindoo) purposes and we never read it in this app.** `Organization` likewise ignored. Importer reads `Personal Email` + rightward cells only.

### I-5 `[RESOLVED 2026-04-20]` Prefix mismatches

**Decision (Chunk 3):** Skip, with the row captured in the `import_end` payload's `warnings` field (e.g. `Tab "CO" row 14: Position "ST Bishop" does not start with expected prefix "CO " — skipped.`). Warnings surface on the manager Import page's collapsible "Warnings from last run" block; no per-row audit row is written (same rationale as I-2). A mis-prefixed row is almost always a human typo in LCR, not a legitimate assignment, and guessing the "real" scope would mask the typo.

### I-6 `[P1]` Row-with-no-matching-template

A `(calling, email)` pair where `calling` isn't in the template — spec says filter out. Confirmed.

### I-9 `[P1]` `[GoogleAccount: <gmail>]` bracketed syntax in Personal Email(s) cells

Surfaced 2026-04-20. The real LCR-exported callings sheet's column-D header text reads roughly:

> "Personal Email(s) — Note: If someone sends email to a non-Google account, you can add the Google account only for access purposes. Add this following their email address: `[GoogleAccount: <GMAIL ACCOUNT>@gmail.com]`"

So a cell may contain e.g. `first.last@workplace.com [GoogleAccount: flast@gmail.com]` — the real email the user will sign in with is inside the brackets. The importer as currently written (Chunk 3) runs `Utils_cleanEmail` on the whole cell (trim only), which preserves the bracket syntax literally. Consequences:

- `Seats.member_email` and `Access.email` store the bracket-laden string rather than the gmail address.
- `source_row_hash` is computed over the canonicalised bracket string, so it's stable across runs (no phantom delta), but it doesn't match the canonical form the user's session token will carry when they sign in — they'd fail role resolution.

**Best guess:** if a cell contains `[GoogleAccount: X]`, extract `X` as the email to use for both storage and hashing; also emit the full bracket-stripped address (the non-Google part) as an additional email if useful? Or prefer the GoogleAccount unconditionally since that's what sign-in uses. Needs a pass in a follow-up chunk (3.1 bugfix or roll into Chunk 4/6 where manual requests land).

**Not fixed in Chunk 3** — user's immediate request was to relax header validation, which is done. Record here so the next import with a bracketed cell shows up as a miss in Access-membership tests and we remember why.

### I-7 `[RESOLVED 2026-04-20]` Empty rows at the bottom of the callings sheet

**Decision (Chunk 3):** Iterate through the tab's full `getDataRange().getValues()` output and skip any row whose `Position` cell is blank. No "stop at first blank" heuristic — interior blank rows (if any) are also skipped, which is the desired behaviour. Trivial as predicted.

### I-8 `[RESOLVED 2026-04-19, REVISED 2026-04-19]` Gmail address canonicalisation — compare canonical, store as typed

Confirmed to be a real problem in the LCR data. **Ship v1 with Gmail-aware comparison baked in, not as a reactive fix** — but **store what the user typed, not the canonical form**.

**Rule** — `Utils_normaliseEmail(email)` (used only for comparison):

1. Trim; lowercase; if no `@`, return as-is.
2. Split into `local@domain`.
3. If `domain ∈ {"gmail.com", "googlemail.com"}`:
   - Strip everything from the first `+` onward in `local`.
   - Remove every `.` from `local`.
   - Force `domain = "gmail.com"` (canonicalise the googlemail alias).
4. Return `local + "@" + domain`.

**Where the canonical form is used:**
- `Utils_emailsEqual(a, b)` — boolean comparison helper. Repos call this for unique-row lookups (`KindooManagers_getByEmail`, `Access_getByEmail`), uniqueness checks on insert, and the importer's diff sets.
- `Utils_hashRow(scope, calling, email)` — the importer's `source_row_hash` is computed on the canonical email so it's stable across format wobbles in the callings sheet (per D5).

**Where the typed form is used (everything else):**
- All email *cells* in the Sheet: `KindooManagers.email`, `Access.email`, `Seats.member_email`, `Requests.{member,requester,completer}_email`, `AuditLog.actor_email`, `Config.bootstrap_admin_email`. The repo `_insert` / `_update` paths call `Utils_cleanEmail` (trim only) and write the trimmed-but-otherwise-untouched value.
- The `email` claim signed into the HMAC session token by `Identity_serve`. `Auth_signSessionToken` no longer calls `Utils_normaliseEmail`. `Auth_verifySessionToken` returns the email as it was signed.
- `principal.email` flowing through the API layer and into `AuditLog.actor_email` — the user sees their own typed address in audit history, not a normalised one.

**Workspace addresses** are unaffected — dots there are significant; the rule only fires for `@gmail.com` / `@googlemail.com`. So `first.last@example.org` and `firstlast@example.org` are *different* people.

**Why the revision (2026-04-19, mid-Chunk 2):** the original rule canonicalised on write too, so a manager who typed `first.last@gmail.com` saw `firstlast@gmail.com` back in the UI and the Sheet — wrong for display, wrong for any future "email this person" path, wrong as a record of what was actually entered. The new rule uses canonicalisation only for matching; storage round-trips the typed form.

**Migration:** if any existing row already contains a canonicalised email from before the revision, edit the cell by hand to the original typed form. (For Chunk-2 development, the only affected row is whichever `KindooManagers.email` was added before the revision.)

---

## Request lifecycle

### R-1 `[RESOLVED 2026-04-21]` Race: complete a `remove` when the seat is already gone

**Decision (Chunk 7):** auto-complete the request and stamp a note. Concretely, when `RequestsService_complete` runs against a `remove` request and `Seats_getActiveByScopeAndEmail` returns no removable row (auto-only matches don't count — those would have been rejected at submit per R-3), the service:

1. Flips the Request to `complete` with `completer_email` / `completed_at` set.
2. Stamps `Requests.completion_note` with the literal `"Seat already removed at completion time (no-op)."` — distinct from `rejection_reason` so the audit log can tell a no-op apart from a manager-initiated rejection.
3. Emits ONE AuditLog row (`complete_request` on the Request — there is no Seat to delete and therefore no Seat audit row, which is correct: nothing actually changed).
4. Returns `{ request, noop: true }`. The API layer still sends `notifyRequesterCompleted`, whose body reads `request.completion_note` and surfaces the no-op so the requester knows nothing visibly changed.

The note column added in Chunk 7 means we never overload `rejection_reason`; the latter stays scoped to `rejected` outcomes for clean filtering.

Sources of the race covered: (a) two managers completing duplicate remove requests near-simultaneously (the duplicate-pending guard in `RequestsService_submit` makes (a) rare, but possible if a stale roster smuggled past the client check); (b) Chunk 8's daily expiry trigger removing a temp seat between submit and Complete; (c) belt-and-braces against a defensive Sheet hand-edit. (See `chunk-7-removals.md` "Decisions made" for the storage-column choice rationale and the tested behaviour.)

### R-2 `[P1]` Race: complete `add_manual` when the member already has a manual seat

Between submission and completion, another manager might complete a duplicate request. When the second request is completed, should we insert a second `Seats` row, merge, or reject?

**Best guess:** At completion time, if an active seat already exists for `(scope, member_email)`, flip the request to `complete` but skip the `Seats` insert, and note "already present — request closed without change" in an audit row. Emailing the requester that it's "done" is truthful.

### R-3 `[P1]` Can you request a `remove` against an `auto` seat?

The spec hides the X button for auto rows, so the UI path is closed. But a determined user could craft an API call.

**Best guess:** Server-side reject — only manual/temp seats are removable via request. Auto seats update via LCR.

### R-4 `[P1]` Requester-scoped "My Requests"

Is "My Requests" only the requests *you* submitted, or all pending requests for your ward?

**Best guess:** Strictly what you submitted. A bishopric counsellor's page shows their own requests, not the bishop's.

### R-5 `[RESOLVED 2026-04-22]` `building_names` on a new request

Requester form has a `comment` field for multi-building notes; managers adjust `building_names` on the inserted Seat. Confirm this is the intended flow.

**Resolution.** The flow differs by scope:

- **Bishopric submits:** form hides the building selector. `Requests.building_names` stored empty. On manager Complete, the dialog pre-ticks the ward's default `building_name` (from `Wards.building_name`); the manager can adjust.
- **Stake submits:** form shows a building checkbox group (every `Buildings.building_name`). At-least-one tick is **required** on submit (client + server guards). `Requests.building_names` carries the comma-separated selection. On manager Complete, the dialog pre-ticks what the requester chose; the manager can adjust.
- **Both scopes:** the manager's Complete dialog enforces at-least-one ticked before Confirm enables; `RequestsService_complete` re-checks server-side. Managers can also adjust post-insert via the All Seats inline edit.

`remove` requests carry no buildings (no Seat is inserted).

Landed in the post-Chunk-10.6 polish pass; a new `building_names` column was added to the `Requests` tab at position 10. See spec.md §5 and data-model.md Tab 9.

### R-6 `[RESOLVED 2026-04-19]` Manager self-approval

A Kindoo Manager who is also a bishopric member (or in the stake presidency) may complete/reject requests they themselves submitted. No code guard required; the requests queue treats every active manager equally.

---

## Temp seats

### T-1 `[P1]` Future-dated temp seats

Can `start_date > today`? If so, does the seat count against the cap before its start date?

**Best guess:** Allow future start dates; count them against the cap from the moment they exist, since Kindoo needs the provisioning now.

### T-2 `[P1]` Same-day expiry semantics

Spec says delete when `end_date < today`. So a seat with `end_date = today` is still alive on its end date and disappears the following morning. Confirm with stakeholders so the UX text is right.

---

## Roles

### AR-1 `[P1]` Manager who is also a bishopric member

A Kindoo Manager appointed from within a ward's bishopric holds both roles. The spec says "UI shows the union". Should the manager-tab role-switcher offer "view as bishopric of ward X" mode, or is the nav-union enough?

**Best guess:** Nav-union is enough for v1. No "view as" switcher.

### AR-2 `[P1]` Access row with `give_app_access=true` but no matching active `Seats` row

Importer upserts `Access` independently of `Seats`. In practice these should align, but a template change (flipping `give_app_access` on) would create an `Access` row even if the `Seats` row was manually deleted.

**Best guess:** Importer owns both; the next run reconciles. Don't try to enforce pairing in code.

---

## Concurrency and runtime limits

### C-1 `[RESOLVED 2026-04-19]` Weekly import execution time

Target scale confirmed: 12 wards, ~250 seats, 1–2 manual changes/week. Well inside the 6-minute budget — no batching or continuation-token scheme needed for v1.

### C-2 `[P1]` Lock timeouts during import

Import holds the script lock for its full run. User-initiated writes during that window will time out (10 s default). UX: the error toast should say "sync in progress, retry in a minute".

**Best guess:** Tolerable. Imports are rare and short.

### C-3 `[P2]` MailApp quota

100 emails/day for consumer, 1500 for Workspace. Not a risk for this workload.

### C-4 `[RESOLVED 2026-04-19]` Protected Config keys excluded from manager Config UI

**Decision (Chunk 2):** four Config keys — `session_secret`, `main_url`, `identity_url`, `bootstrap_admin_email` — are **excluded from inline edit** in the manager Configuration page. They render in a separate "Read-only keys" table with a `protected` badge and `readonly` input. `ApiManager_configUpdate` rejects writes to any of them server-side (defence-in-depth) with `Config_isProtectedKey`; the literal cell is editable in the Sheet by the deployer if a real rotation is intended.

**Why:** rotating each of these keys has app-wide consequences that benefit from a deliberate "open the Sheet" action rather than an inline button:
- `session_secret` — rotating invalidates every active session token (everyone bounced to Login).
- `main_url` / `identity_url` — wrong value here breaks the auth round-trip and there's no UI left to recover from inside the app; you'd have to re-edit via the Sheet anyway.
- `bootstrap_admin_email` — read by the Chunk-4 wizard, post-bootstrap edits are theoretical.

The alternative (a confirm-text-match modal) was considered and rejected: the modal adds UI complexity for a workflow used roughly never, and the Sheet is already the rotation surface (the deployer always has Sheet write access, and `setupSheet` regenerates `session_secret` if cleared).

Two importer-owned keys — `last_import_at`, `last_import_summary` — are also read-only in the UI but for a different reason (the Importer writes them; manager edits would just get clobbered on the next run). They're flagged with an `importer-owned` badge.

`ApiManager_configList` masks `session_secret`'s value before returning to the client (`(set — N chars; hidden)`) so the secret isn't shipped over the wire to render the read-only field.

### C-5 `[P1]` ward_code / building_name rename breaks references

Wards' `ward_code` and Buildings' `building_name` are now natural-key PKs (architecture.md D3, no more slug PK). The Wards / Buildings UIs let a manager edit them inline. The repo `_update` handlers allow rename (with collision check), but the consequences cascade hard:
- Renaming a `ward_code` dangles every `Seats.scope` / `Access.scope` / `Requests.scope` row whose value matched the old code, AND breaks the importer's tab-name match.
- Renaming a `building_name` dangles every `Wards.building_name` row whose value matched the old name, plus every `Seats.building_names` cell that contained it.

The UI fires a `confirm()` warning before submitting a rename.

**Best guess:** Acceptable for v1 — the Configuration page is manager-only and they'll know what they're doing. If we wanted to be safer, we'd cascade the rename across referencing tabs in the API endpoint (inside the same lock). Defer until we see this misused. If you choose to forbid renames entirely, gate it server-side in `ApiManager_*Upsert`.

---

## Over-cap

### OC-1 `[RESOLVED 2026-04-22]` Email frequency on persistent over-cap

**Decision (Chunk 9):** email on every import run where any pool is over cap — not just on *state changes*. Rationale:

- Imports fire once a week (the weekly trigger + the rare manual Import Now). At target scale (12 wards, 1–2 requests/week) "weekly reminder while the condition persists" is an acceptable cadence, not a noise problem, and it sidesteps the state-delta bookkeeping that a "fire only on change" model would require (which scope was over last week? by how much?).
- The banner on the manager Import page does stay visible until the condition resolves — so operators have a persistent surface independent of inbox fatigue. The email is the *new-information* signal; the banner is the *current-state* signal.
- Chunk 10's Dashboard will add the same banner as a Warnings card so managers see it without navigating to Import.

The `over_cap_warning` AuditLog row also fires per-run (not per-state-change) for the same reason — the audit trail should show "we noticed this on Sunday 2026-04-26" even if last week's row said the same thing, so a later question "when did this first go over?" has an actual record rather than a missing-until-it-flipped trail.

If inbox volume becomes a problem (hasn't at target scale), the fix is to gate the email body on state-delta while still writing the audit row per run — add a `over_cap_changed_since` field to `Config.last_over_caps_json` and branch in `EmailService_notifyManagersOverCap`. Not needed for v1.

### OC-2 `[P1]` Zero active managers

If `KindooManagers` has no `active=true` rows, over-cap emails silently go nowhere. Add a loud AuditLog entry as a backstop.

---

## Custom domain (originally Cloudflare Worker; pivoted to iframe wrapper in Chunk 11)

### CF-1 `[RESOLVED 2026-04-25 — pivoted to iframe-embed wrapper, not a Worker proxy]` Banner removal needed an iframe wrapper, not a transparent proxy

Pre-Chunk-11 best guess (preserved as discovery trail): try a Cloudflare Worker as a transparent proxy, fall back to a 302 redirect if OAuth round-trip breaks. The premise was that the Worker would deliver the pretty URL.

**Discovery during Chunk 11 design.** A transparent Worker proxy delivers the pretty URL but does **not** remove the *"This application was created by a Google Apps Script user"* banner. The banner lives in the outer wrapper page Apps Script serves from `script.google.com`, which the proxy ships through unchanged. Stripping the banner from the proxy would require modifying HTML in flight (brittle, breaks any time Apps Script's wrapper page changes).

**Resolution.** Pivoted to an iframe-embed wrapper: a static `docs/index.html` on GitHub Pages contains a full-viewport iframe pointing at the Main `/exec` URL. Both `doGet` deployments set `setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` to permit the embed. Top frame is the static wrapper (no banner-bearing chrome at all); the wrapper iframe loads Apps Script directly. Pretty URL AND no banner. Cloudflare is not in the picture — DNS stays at Squarespace, the only added record is a `CNAME kindoo → <github-username>.github.io`. The OAuth-redirect concern that motivated this section's original wording doesn't apply: there's no OAuth client (the auth flow is HMAC session tokens per A-8), and Identity's `window.top.location.replace(MAIN_URL + '?token=…')` runs as a top-frame navigation that Apps Script's iframe sandbox handles fine — the wrapper origin doesn't intercept it.

See `architecture.md` §11 and `docs/changelog/chunk-11-custom-domain.md` (when it lands) for the full rationale.

### CF-2 `[P2]` Deep-link preservation through the Identity round-trip

Original wording: "Worker must forward query strings." With the iframe wrapper there's no proxy. Updated state of the world after Chunk 11:

- **In-app deep-links (Chunk 10.6) work** — they happen post-bootstrap inside the iframe and never touch the wrapper.
- **Wrapper-origin direct-load deep-links for already-signed-in users work** — `docs/index.html` carries a six-line same-origin query-string forwarder that copies `window.location.search` into the iframe `src` before navigation. Same forwarder is what makes the post-sign-in `?token=…` landing reach Main's `doGet`.
- **Wrapper-origin direct-load deep-links followed by a fresh sign-in lose `?p=`.** Identity's redirect carries only `?token=…`; the original page parameter doesn't survive the round-trip.

**Best guess (still open):** Closing the pre-sign-in case requires an auth-flow change — teach the Login link to pass `?next=<pageId>&…` (or similar) through to Identity, and Identity to echo it back into the post-sign-in redirect. Small change but it touches the auth contract, so deferred until there's a real-usage signal that anyone hits this. The in-app and already-signed-in paths cover the realistic deep-link use cases (sharing URLs to teammates who are already in the app).

### CF-3 `[P2]` Iframe-embed durability against future browser changes

The wrapper relies on cross-origin iframe embedding being permitted with `X-Frame-Options: ALLOWALL`. Browsers periodically tighten cross-origin iframe behaviour (third-party cookie partitioning, Storage Access API, Cross-Origin-Embedder-Policy / Cross-Origin-Opener-Policy enforcement). The current architecture is resilient because:

- The HMAC session token is held in `sessionStorage`, which is partitioned per iframe-origin and unaffected by third-party cookie restrictions.
- The auth round-trip only touches Google's first-party session at `accounts.google.com` / `script.google.com`, where the user is already signed in.
- The wrapper itself does no cross-origin `postMessage` — it's a static HTML page with one iframe.

But the surface area is non-zero. If a future Chrome / Safari / Firefox change makes embedded sign-in flows unusable (e.g. requiring Storage Access API prompts the user can't reasonably approve), the documented fallback is to drop iframe-embed and accept the banner — `Config.main_url` reverts to the raw `/exec` URL, the `docs/index.html` becomes a redirect rather than a wrapper, and we accept the banner. Cloudflare-Worker-as-transparent-proxy is the second-fallback if even the redirect approach has UX problems.

**Best guess:** No action needed today; revisit if user reports point at a browser-policy regression. Track here so the path forward is documented.

### CF-4 `[P2]` GitHub Pages as the wrapper host

GitHub Pages is fine for a static HTML page at the scale we operate. Risks worth naming:

- **GitHub Pages reliability.** ~99.9% historically; outages would take the wrapper down (the raw `/exec` URL still works, so this is a UX degradation not an outage).
- **Lock-in.** None to speak of — the wrapper is one HTML file; migrating to Cloudflare Pages, Netlify, or any S3-class static host is a 5-minute exercise. The DNS record at Squarespace is the only piece that points at GitHub specifically.
- **HTTPS cert auto-renewal.** GitHub provisions and renews via Let's Encrypt automatically. If renewal fails (rare), the operator gets a GitHub Pages email warning; manual remediation is one click in `Settings → Pages`.
- **Future need for server-side wrapper logic.** If we ever need to gate the wrapper origin (auth check, rate limiting, A/B), GitHub Pages can't host it — at that point the wrapper migrates to Cloudflare Pages + Worker or similar. Not a current need.

**Best guess:** Stay on GitHub Pages until a concrete reason to move surfaces.

### CF-5 `[P2]` `clasp push` ≠ deployment update — easy to skip the editor "New version" step

**Discovery (post-Chunk-11 cutover).** Right after the Chunk 11 runbook ran cleanly through Step 10, `https://kindoo.csnorth.org` opened in a freshly-cleared incognito window started returning a Google *"We're sorry, but you do not have access to this page"* 403 inside the wrapper iframe. The 403 was identical to the page Apps Script's `ANYONE` deployment gate serves to signed-out users, so the initial diagnosis pointed at the gate firing inside the iframe (the gate's redirect to `accounts.google.com` cannot render because Google's sign-in page sets its own `X-Frame-Options`). Proposed fix: switch Main's `webapp.access` from `ANYONE` to `ANYONE_ANONYMOUS`.

**What actually fixed it.** Just redeploying — Apps Script editor → Deploy → Manage deployments → Edit existing Main deployment → New version. No manifest change. No source change. The runbook's Step 5 already documented this procedure, but it's easy to read as a no-op when no code change is being made for the chunk: ALLOWALL was already in source from Chunk 1/2, so the operator can plausibly conclude the deploy half of Step 5 isn't needed. It is — `clasp push` updates the script source, but the live `/exec` deployment continues to serve whatever version was last associated with it. Only the editor-side "New version" step bumps the deployment.

**Why it surfaced post-Step-10 specifically.** Steps 7 / 9 / 10 all tested in incognito sessions that became Google-signed-in mid-test (after Identity ran the user through the Google sign-in). Subsequent loads in those same sessions hit the iframe with the user already Google-signed-in, so even an old deployed version that did the same thing in a slightly stale way still rendered the app's Login page. A truly clean incognito (one that has never signed into Google in the session) plus a stale deployed version is the case the runbook didn't cover.

**The fix is now in the runbook.** `docs/runbooks/chunk-11-custom-domain.md` Troubleshooting section names "redeploy a new version of the existing Main deployment" as the first thing to try when the wrapper iframe shows a 403. The two distinguishable cases (deployment-out-of-sync vs. ANYONE-gate-fires-on-signed-out-user) render the same Google 403 page in the iframe, so the runbook orders the fixes by reversibility: redeploy first; only if that fails consider the manifest change.

**Best guess:** No code change needed — this is operational lore. The runbook's Troubleshooting section is the load-bearing artifact. Future operators who change *anything* on the Apps Script side (source, manifest, OAuth scopes, time zone, anything) need to remember the editor-side "New version" step is part of the operation, not a separate optional follow-up. Generally true for any clasp-managed Apps Script project, not specific to this app.

---

## Sheet drift

### SD-1 `[P2]` Human edits to the Sheet

Nothing prevents a human from editing `Seats` directly, bypassing lock and audit. Accepted per the spec's "sheet is source of truth" model.

### SD-2 `[P2]` Header drift

If a header gets renamed manually, repos will throw loud errors on next read. `setupSheet()` can repair, but only if we detect the rename — we can't. Treat as "open the sheet and fix by hand".

---

## Deployment

### D-3 `[RESOLVED 2026-04-19, REVISED 2026-04-20]` Workspace-bound Sheet incompatible with `USER_ACCESSING` for consumer Gmail — fix is to split Identity into a separate personal-account project

**Discovery (Chunk 2 manual testing).** The Chunk 1 deployment was set up against a Sheet in the deployer's Workspace (`csnorth.org`). The deployer (a Workspace account) signed in successfully through Identity and used the app. When we attempted to test sign-in with a *consumer Gmail account* (not in the Workspace), the user got Google's `You do not have permission to access the requested document` page **before `Identity_serve` ran** — i.e., Google rejected the request at the access-gate level.

Settings that were already correct and did not fix it:
- Identity deployment: "Who has access" = "Anyone with Google account" (`webapp.access = "ANYONE"`).
- Identity deployment: `executeAs: USER_ACCESSING`.
- The linked Cloud project's OAuth consent screen: User type = External, Publishing status = In production.
- Workspace Admin Console → Security → Access and data control → API controls → App access control: not blocking.
- URL form: bare `https://script.google.com/macros/s/<ID>/exec` (not the Workspace-routed `/a/macros/<domain>/` form).
- Browser context: incognito with only the consumer-Gmail account signed in.

The block persisted across all of those, indicating that Workspace-owned Apps Script projects gate external accounts at a tenant level the deployment dialog can't override. The OAuth consent screen toggle to External is necessary but not sufficient when the project itself is Workspace-owned.

**Initial resolution (2026-04-19):** move the bound Sheet (and therefore the Apps Script project) into a personal Drive. Rejected by the user — the Sheet must stay in the Workspace shared drive for data ownership/governance reasons.

**Final resolution (2026-04-20): two-project split.** Main stays Workspace-bound (Sheet stays in Workspace). Identity becomes a **separate, standalone Apps Script project** owned by a personal Google account, no bound Sheet, ~70 lines of code. The two projects share an HMAC `session_secret` value held in two manually-synchronized places: Main's Sheet `Config.session_secret` cell and Identity's Script Properties (`session_secret` key). The HMAC token format is unchanged, so Main's `Auth_verifySessionToken` works against tokens issued by either the previous same-project Identity or the new separate-project Identity without code changes — only the deployment-URL pointer in `Config.identity_url` differs.

**Spec impacts:**
- `architecture.md` D1 (drop the personal-Drive constraint; Main can be Workspace-bound) and D10 (rewritten for the two-project model: same protocol, different topology) and §3 (directory structure now has both `src/` and `identity-project/`) and §4 / §12 (sequence diagram intro + quick-reference table updated to "two projects" framing).
- `spec.md` §2 (Database: Workspace shared drive OK; Auth: rewritten for two-project architecture).
- `sheet-setup.md` step 1 (drop personal-Drive warning), step 12+ (replaced with a pointer to `identity-project/README.md`).
- `identity-project/` (new directory at repo root) — `Code.gs`, `appsscript.json`, `README.md`. Identity source kept here for version control and copy-paste reference; not pushed via clasp (the user creates the project manually in the Apps Script editor).
- `src/services/Identity.gs` — **deleted** from the Main project.
- `src/core/Main.gs` — `?service=identity` routing branch removed (no longer needed; Identity is a separate URL entirely).
- `src/core/Auth.gs` — `Auth_signSessionToken` removed (only Identity signs now); verification stays.
- `src/ui/Layout.html` — Login link no longer auto-appends `?service=identity` (Identity has no query-param routing).

**Workarounds considered and rejected (besides the one above):**
- *Switch the user model to Workspace-only accounts.* Would force every bishopric/stake/manager to have a `csnorth.org` Workspace identity, which they don't and can't. Conflicts with spec A-1.
- *Loosen Workspace admin policy.* The "Anyone with Google account" deployment toggle empirically doesn't override the underlying tenant rule; even if a policy could be found that does, depending on it makes the deployment fragile to future Workspace policy changes.
- *Move the Sheet to a personal Drive.* Considered first; rejected because data ownership / shared-drive governance has to stay with the Workspace.
- *Magic-link auth (no Google identity at all).* A bigger architectural pivot than the two-project split; deferred. Worth revisiting only if the two-project setup proves operationally unmanageable.

**Operational cost** of the two-project split:
- One additional Apps Script project to manage (Identity).
- Manual `session_secret` synchronization on rotation (procedure documented in `identity-project/README.md`).
- Identity changes are copy-paste into the editor (no clasp); Main changes still go through `clasp push`.
- Acceptable for low-traffic stake software; revisit if the operational burden becomes a maintenance issue.

---

## Chunk 10 polish resolutions

These were flagged for Chunk 10 during earlier chunks and are now resolved.

### Q-7.1 `[RESOLVED 2026-04-22]` Audit-log filtering for completion_note on complete_request rows

**Flagged (Chunk 7):** complete_request rows written by the R-1 race path carry a `completion_note` ("Seat already removed at completion time (no-op).") in `after_json`. The pre-Chunk-10 Audit Log page didn't exist, so the note was only visible by opening the Requests sheet. Chunk 10's Audit Log page needed to surface the note so a triage of "what went through the R-1 no-op path" was a one-filter query.

**Decision (Chunk 10):** the Audit Log page renders the `completion_note` INLINE in the collapsed row (not just in the expanded `<details>` block) for complete_request rows whose `after_json.completion_note` is non-empty. Styled as a small amber note directly under the row's summary line so the R-1 cases are visible without expanding.

`ApiManager_auditLog`'s generic filters (`action=complete_request`) + `entity_id=<request_id>` give a one-filter query into the full trail; the inline note makes scanning the list for no-op completions zero-click.

### Q-8.1 `[RESOLVED 2026-04-22]` Dashboard "last expiry" card

**Flagged (Chunk 8):** the daily expiry job ran but the only surfaces for "when did it last fire and how many rows?" were the AuditLog tab (raw) and the Apps Script execution log (transient). Chunk 10's Dashboard needed a small card symmetric with "last import" so operators could sanity-check the trigger without Sheet archaeology.

**Decision (Chunk 10):** added two Config keys — `last_expiry_at` (timestamp) and `last_expiry_summary` (human-readable string like `"2 rows expired in 145ms"`) — symmetric with the Importer's existing `last_import_at` / `last_import_summary`. `Expiry_runExpiry` writes both at the end of every run (including runs that expire zero rows, so the timestamp always reflects when the trigger last fired). Both are read-only in the manager Config UI (rendered with a `system-managed` badge) and surface on the Dashboard's "Last Operations" card alongside `last_import_at` and a derived `last_triggers_installed_at`.

The rename that accompanied this — `CONFIG_IMPORTER_KEYS_` → `CONFIG_SYSTEM_KEYS_` in `ConfigRepo` — makes the read-only keys list accurately cover keys owned by any background process, not just the importer. `Config_isImporterKey` is kept as a backward-compat alias so Chunk-2's `ApiManager_configUpdate` guard didn't need a touch-up.

### Q-9.1 `[RESOLVED 2026-04-22]` Dashboard Warnings card + last-import monitoring signal

**Flagged (Chunk 9):** the Chunk-9 over-cap pass persists a per-pool snapshot to `Config.last_over_caps_json` and renders a red banner on the manager Import page. The Dashboard equivalent was deferred to Chunk 10.

**Decision (Chunk 10):** the Dashboard's Warnings card reads the same `Config.last_over_caps_json` snapshot and renders the same shape (one bullet per pool with counts + a "view →" deep-link to `?p=mgr/seats&ward=<code>`). Empty snapshot renders a dim "No warnings. All pools within cap." line so the card never looks broken on a fresh install.

No new data path. The Chunk-9 persistence contract ("write `[]` on every clean run so resolved conditions clear the banner") covers the Dashboard for free. The card is decoupled from the Import page render — a page reload (or cross-browser visit) always shows the current persisted state.

The Dashboard also surfaces `last_import_at` on its "Last Operations" card, which is the monitoring signal the chunk-9 changelog flagged for historical-trigger-drift detection: an operator checking the Dashboard can see at a glance whether the weekly import has run in the last week (or the last month), and notice a stale trigger without having to open the Apps Script editor. Drift *mitigation* remains operational (archive old deployments; click "Reinstall triggers" on the new one) — but the Dashboard now gives the observability piece.


These aren't ambiguities — I made a choice. Flagging here in case you disagree.

- **D1 (architecture.md) Container-bound script.** Simpler than standalone; one sheet per deployment. If a test/prod separation is wanted, we'd flip this to standalone with a `callings_sheet_id`-style `app_sheet_id` config key.
- **D2** `executeAs: USER_DEPLOYING`, `access: ANYONE` (manifest enum; shown as "Anyone with Google account" in the deploy dialog) — updated 2026-04-19 after A-1 resolved. Identity is handled by GSI (D10), not by `Session.getActiveUser()`.
- **D3** (revised mid-Chunk-2) UUIDs for `seat_id` and `request_id`; **natural keys** for Wards (`ward_code`) and Buildings (`building_name`). The earlier slug-PK design (`ward_id` / `building_id`) was dropped because the natural keys were already unique by usage and an extra slug was just bookkeeping. See architecture.md D3.
- **D8** Dates stored as ISO `YYYY-MM-DD` strings (not Sheet date objects). Sorts lexically, avoids tz confusion. Timestamps remain as Sheet Date objects.
- **D10** Google Sign-In + JWT verification for identity, added 2026-04-19. One-time OAuth 2.0 Client ID creation in Google Cloud Console; `Config.gsi_client_id` seeded manually.
