# Chunk 1 — Scaffolding

**Shipped:** 2026-04-19
**Commits:** _(see git log; commit messages reference "Chunk 1")_

## What shipped

A deployable web app that proves the full GSI auth handshake end-to-end:
unauthenticated users see a Google Sign-In button; signed-in users with one
or more resolved roles land on a temporary `Hello, you are role X` page;
signed-in users with no role land on `NotAuthorized`. Read-only path only —
no writes anywhere.

Implemented:

- **`services/Setup.gs#setupSheet()`** — idempotently creates all 10 tabs
  with the canonical headers from `data-model.md`, freezes header rows,
  bolds them, seeds well-known `Config` keys (only when absent), and removes
  the default `Sheet1` if it's empty. Detects header drift and skips the
  affected tab with a loud `Logger.log` message rather than touching it.
- **`services/Setup.gs#onOpen()`** — installs a `Kindoo Admin` menu on the
  bound Sheet with `Setup sheet…`, `Run normaliseEmail tests`, and
  `Run base64UrlDecode tests`. Triggers-install menu item is intentionally
  absent until the trigger services land in Chunks 4/8/9.
- **`core/Utils.gs`** — `Utils_normaliseEmail` (D4), `Utils_hashRow` (D5),
  `Utils_uuid`, `Utils_nowTs`, `Utils_todayIso`, base64url decode helpers,
  and a hand-rolled BigInt-based RSA-SHA256 PKCS#1 v1.5 verifier used by
  `Auth_verifyIdToken`. Plus runnable test functions
  `Utils_test_normaliseEmail` and `Utils_test_base64UrlDecode` that log
  PASS/FAIL per case and `throw` on any failure.
- **`core/Auth.gs`** — `Auth_verifyIdToken` (JWKS-cached RS256 verify with
  `iss`/`aud`/`exp`/`email_verified` checks; throws `AuthInvalid` /
  `AuthExpired` / `AuthNotConfigured`), `Auth_resolveRoles`,
  `Auth_principalFrom`, `Auth_requireRole`, `Auth_requireWardScope`. JWKS
  is cached in `CacheService` for 6 h; `Logger.log('[Auth] JWKS cache MISS …')`
  fires on every network fetch (and only then), so the once-per-6 h
  invariant is verifiable from execution logs.
- **Read-only repos** — `ConfigRepo`, `KindooManagersRepo`, `AccessRepo`.
  Each verifies header order on read and throws on drift; emails are
  canonicalised at the repo boundary so callers compare canonical-to-canonical.
- **`core/Main.gs#doGet`** — renders `ui/Layout`, injects
  `Config.gsi_client_id` into the template (or empty string + log on read
  failure so the client can show a helpful message). Adds the `include()`
  helper for HTML template composition.
- **`core/Router.gs#Router_pick`** — Chunk-1 form: returns `NotAuthorized`
  when `principal.roles.length === 0`, otherwise `Hello`.
- **`api/ApiShared.gs#ApiShared_bootstrap(jwt, requestedPage)`** — first
  authenticated entry point; verifies JWT, resolves roles, returns
  `{ principal, template, pageModel, pageHtml }`. Establishes the
  `(jwt, …) → Auth_principalFrom(jwt) → work` pattern Chunks 2–10 will copy.
- **`ui/Layout.html`** — page shell. Loads the GSI client library, drives
  the boot flow client-side: read `sessionStorage.jwt`, decode `exp` for a
  cheap expiry short-circuit, call `rpc('ApiShared_bootstrap', requestedPage)`,
  innerHTML the returned page HTML. Routes `AuthExpired` / `AuthInvalid` to
  re-show login (after clearing the stored token); routes
  `AuthNotConfigured` to a config-error message.
- **`ui/Login.html`** — GSI button container; wired up by Layout's
  `<script>` block.
- **`ui/ClientUtils.html`** — `rpc(funcName, ...args)` Promise wrapper
  around `google.script.run` that auto-injects `sessionStorage.jwt` as the
  first argument.
- **`ui/Hello.html`** — Chunk-1-only `Hello, [name] ([email]) — you are
  role X` page. **Header comment marks it for deletion in Chunk 5.**
- **`ui/NotAuthorized.html`** — explains the bishopric-import-lag
  possibility, the Gmail-canonicalisation matching rule, and the
  not-in-any-role case.
- **`ui/Styles.html`** — minimal shared CSS (topbar, content, error,
  hello-list).
- **`ui/Nav.html`** — trivial stub; real role-aware nav lands in Chunk 5.

## Deviations from the pre-chunk spec

- **Auth pivoted three times before landing on a two-deployment
  `Session.getActiveUser` + HMAC-signed session-token pattern.** The
  Chunk 0 design called for Google Identity Services' `gsi/client`
  drop-in button. **Pivot 1 (didn't work):** GSI's button initialises
  by checking the iframe origin against the OAuth Client's Authorized
  JavaScript origins — but the iframe is on `*.googleusercontent.com`,
  which Cloud Console permanently rejects as a JS origin ("uses a
  forbidden domain"). **Pivot 2 (didn't work):** OAuth 2.0 implicit
  flow (`response_type=id_token`) with same-tab redirect to
  `accounts.google.com`. Hypothesis: `accounts.google.com` only checks
  `redirect_uri`. Wrong — `accounts.google.com/o/oauth2/v2/auth`
  inspects Origin/Referer for *all* browser-initiated flows and
  rejects with `origin_mismatch`. **Pivot 3 (also didn't work):** OAuth
  2.0 authorization code flow (`response_type=code`) with server-side
  token exchange. The server-side exchange `UrlFetchApp.fetch` POST
  does escape the origin check — but the *initial* browser GET to
  `accounts.google.com/o/oauth2/v2/auth` happens first, and that hits
  `origin_mismatch` like pivots 1 and 2. Even with `<meta
  name="referrer" content="no-referrer">`, `rel="noreferrer"` on
  anchors, and programmatic anchor-click navigation, modern browsers
  leak the iframe origin via `Sec-Fetch-Site` and other headers.
  **Final landing: a two-deployment Session+HMAC pattern that uses no
  OAuth client at all.** Same Apps Script project, two web app
  deployments: **Main** (`executeAs: USER_DEPLOYING`) renders all UI
  and reads/writes the backing Sheet under the deployer's identity
  (Sheet stays private); **Identity** (`executeAs: USER_ACCESSING`)
  exists only to call `Session.getActiveUser().getEmail()`, HMAC-sign
  `{email, exp, nonce}` with `Config.session_secret`, and redirect the
  top frame back to Main with the token in the query string. `Main.doGet`
  routes between the two by comparing `ScriptApp.getService().getUrl()`
  against `Config.identity_url`. Server-side HMAC verification on every
  rpc call replaces the JWT verification path. **The HMAC signature
  lets Main trust what Identity returns without sharing a database** —
  the only shared state is `session_secret` in the Config tab, which
  both deployments read from the same Sheet. **Cost:** a one-time
  per-user OAuth consent prompt on the Identity deployment (for the
  email scope only — non-sensitive, immediate accept) and a second
  deployment to manage. **Removed:** the entire OAuth-client setup in
  Cloud Console, the JWT/JWKS code path (~150 lines of BigInt RSA
  verifier + JWKS cache), `gsi_client_id` and `gsi_client_secret`
  Config keys. **Spec impacts:** `spec.md` §2 Stack rewritten for the
  third time; `architecture.md` D10 rewritten with all three failed
  pivots called out as discoveries + §4 sequence diagram redrawn for
  the two-deployment round-trip + §3 directory structure adds
  `services/Identity.gs` + §12 quick-reference rows updated;
  `data-model.md` Config tab drops `gsi_client_id`/`gsi_client_secret`,
  adds `main_url`/`identity_url`/`session_secret`; `sheet-setup.md`
  steps 11–15 rewritten — no more OAuth Cloud Console at all, instead
  deploy Main, deploy Identity, paste URLs into Config, complete
  one-time per-user OAuth consent on the Identity URL. New file:
  `services/Identity.gs`. Modified: `core/Auth.gs` (HMAC sign/verify
  replaces JWT/JWKS), `core/Utils.gs` (drop BigInt RSA, add base64url
  encoders), `core/Main.gs` (route Identity vs Main, consume
  `?token=`), `services/Setup.gs` (drop OAuth keys, add new keys,
  auto-generate `session_secret`), `ui/Layout.html` (full rewrite for
  the new flow), `ui/Login.html` (button still calls `startSignIn`,
  but `startSignIn` now navigates to the Identity URL not
  `accounts.google.com`), `api/ApiShared.gs` (cosmetic — first
  argument renamed `jwt` → `token`).
- **BigInt literal syntax (`0n`, `256n`, …) replaced by `BigInt(N)` calls.**
  The Apps Script V8 runtime supports BigInt literals, but `clasp push`'s
  local pre-push parser predates the syntax and rejects it as
  `Unexpected token ILLEGAL`. `Utils.gs` now builds BigInts via
  `BigInt(0)` / `BigInt(1)` / `BigInt(256)` calls, hoisted to module-level
  constants (`UTILS_BIG_ZERO_`, `UTILS_BIG_ONE_`, `UTILS_BIG_256_`) so
  `Utils_modPow_` doesn't allocate new BigInts per loop iteration.
  Behaviour unchanged.
- **`webapp.access` manifest value corrected** from `ANYONE_WITH_GOOGLE_ACCOUNT`
  to `ANYONE`. The Chunk 0 docs (and the placeholder manifest) used
  `ANYONE_WITH_GOOGLE_ACCOUNT` everywhere, but that string is the *deploy
  dialog's human-readable label* — the actual manifest enum is `ANYONE`
  (sign-in required; `ANYONE_ANONYMOUS` would be the no-sign-in variant).
  Surfaced when `clasp push` rejected the manifest with
  `Expected one of [UNKNOWN_ACCESS, DOMAIN, ANYONE, ANYONE_ANONYMOUS, MYSELF]`.
  Behaviour unchanged — the *intent* (signed-in users from any Google
  account) was correct; only the manifest token was wrong. Spec changes:
  `spec.md` §2 Stack, `architecture.md` D2, `build-plan.md` Chunk 1
  sub-task, `sheet-setup.md` "Things to double-check…", `open-questions.md`
  A-1 + D2 footnote.

## Decisions made during the chunk

- **API endpoint naming uses the `Api{Module}_` prefix.** The build-plan
  refers to `rpc('bootstrap', …)` informally, but Apps Script's flat
  namespace makes a bare `bootstrap` risky next to the future
  `services/Bootstrap.gs`. The exposed function is therefore
  `ApiShared_bootstrap`, called as `rpc('ApiShared_bootstrap', requestedPage)`.
  Same convention will apply to `ApiBishopric_*`, `ApiStake_*`, `ApiManager_*`
  in later chunks. Consistent with `architecture.md` §3's general "every
  exported function must have a unique, prefixed name" rule.
- **RSA-SHA256 verification is implemented in pure BigInt arithmetic.**
  Apps Script has no built-in RSA verify; `Utilities.computeRsaSha256Signature`
  signs but does not verify. V8 BigInt handles the modular exponentiation
  comfortably (≤ 17 squarings for the typical `e=65537`), well under the
  6-minute execution budget. PKCS#1 v1.5 padding constructed and compared
  byte-by-byte. Implementation lives in `Utils.gs` so it stays adjacent to
  the other crypto-adjacent helpers.
- **Manifest scope addition.** `appsscript.json` gains
  `https://www.googleapis.com/auth/script.external_request` for
  `UrlFetchApp.fetch` (JWKS). The other listed scopes remain
  forward-looking for future chunks.
- **`Kindoo Admin` menu intentionally minimal.** Just `Setup sheet…` plus
  the two test runners. The architecture-mentioned `Install triggers` item
  is deferred until `services/TriggersService.gs` actually exists (Chunks
  4/8/9).
- **Repos throw loudly on header drift.** Each read does a header-byte-
  for-byte check; a mismatch throws with the column number and the bad
  value. Setup similarly refuses to overwrite a drifted header (logs and
  skips). Mirrors the "treat it as 'open the sheet and fix by hand'"
  resolution in `open-questions.md` SD-2.
- **Version stamping for stale-deployment detection.** Apps Script's
  `/exec` URL serves the last *deployed* version, not the head — so a
  bare `npm run push` doesn't actually change what users see until you
  also do "Deploy → Manage deployments → Edit → New version" in the
  editor. We were bitten by this twice during the auth-flow pivots
  (testing what we thought was new code but was actually stale). Added:
  `scripts/stamp-version.js` writes a UTC ISO timestamp into
  `src/core/Version.gs` at the start of every `npm run push` /
  `push:watch`; `Layout.html` renders it as a tiny footer (`v: <ts>`)
  on every page; mismatch between the footer and the value in the
  source file = stale deployment. Documented in README.md "Detecting
  a stale deployment" and `sheet-setup.md` troubleshooting.

## Spec / doc edits in this chunk

- `docs/spec.md` — §2 Stack: `webapp.access` value corrected to `ANYONE`
  (manifest enum; deploy dialog labels it "Anyone with Google account").
- `docs/architecture.md` — D2: same correction; added clarifying note that
  `ANYONE` requires sign-in vs. `ANYONE_ANONYMOUS`.
- `docs/build-plan.md` — Chunk 1 sub-task: same correction.
- `docs/sheet-setup.md` — pre-deploy checklist + step 4 (script ID
  description; removed real ID example) + step 5 (referenced
  `.clasp.json.example`) + step 6 (restructured: prerequisites first, then
  commands, then expected output, then troubleshooting; documented
  Apps Script API enable, manifest-overwrite prompt) + step 11 (expanded
  the OAuth Client ID walkthrough — how to find the Cloud Console project
  picker, recommend creating a fresh project for Kindoo, full OAuth consent
  screen field-by-field walk-through with Publish-App step) + step 11
  again (Authorized JS origins → empty per A-8; Authorized redirect URIs
  becomes the binding registration list) + new step 12 (deploy walkthrough
  with field-by-field) + new step 13 (add `/exec` URL to OAuth client's
  Authorized redirect URIs) + new step 14 (sign-in walkthrough) + new
  troubleshooting entries (`redirect_uri_mismatch`, "uses a forbidden
  domain", `access_denied`) + new "If you already created the OAuth client
  per the OLD instructions" remediation block.
- `docs/spec.md` — §2 Auth bullet rewritten to describe OAuth implicit
  redirect flow (per A-8), retaining the canonicalisation + JWT-on-every-
  rpc semantics.
- `docs/architecture.md` — D10 rewritten to call out the
  googleusercontent.com origin block, switch to OAuth implicit redirect,
  and note the unchanged JWT-shape; §4 Mermaid sequence diagram redrawn
  with Top vs. Iframe participants and the redirect round-trip; step-by-
  step + failure-modes tables updated for the new client-side flow.
- `docs/open-questions.md` — A-8 added (RESOLVED 2026-04-19) documenting
  the GSI-button-blocked-by-googleusercontent.com discovery; A-9 added
  (RESOLVED 2026-04-19) documenting the `ANYONE_WITH_GOOGLE_ACCOUNT` →
  `ANYONE` manifest-enum correction.
- `docs/open-questions.md` — A-1 + D2 footnote: same `ANYONE` correction.
- `README.md` — step 5 path corrected from `core/Setup` → `services/Setup`.

## New open questions

None.

## Files created / modified

**Created**

- `src/ui/Hello.html` — Chunk-1-only Hello page.
- `docs/changelog/chunk-1-scaffolding.md` — this file.

**Implemented (replaced 1-line stubs with real code)**

- `src/core/Utils.gs` — D4 normaliseEmail, hashRow, uuid, today/now, base64url
  decode helpers, BigInt RSA-SHA256 PKCS#1 v1.5 verifier, two test runners.
- `src/core/Auth.gs` — JWKS-cached JWT verify, role resolution, principal,
  guards.
- `src/core/Main.gs` — `doGet`, `include`.
- `src/core/Router.gs` — Chunk-1 router.
- `src/repos/ConfigRepo.gs` — read-only access to `Config`, with type coercion.
- `src/repos/KindooManagersRepo.gs` — read-only access to `KindooManagers`.
- `src/repos/AccessRepo.gs` — read-only access to `Access`.
- `src/services/Setup.gs` — idempotent `setupSheet`, `onOpen` admin menu.
- `src/api/ApiShared.gs` — `ApiShared_bootstrap`, `ApiShared_whoami`.
- `src/ui/Layout.html` — shell + boot flow.
- `src/ui/Login.html` — GSI button fragment.
- `src/ui/ClientUtils.html` — `rpc` helper.
- `src/ui/Styles.html` — shared CSS.
- `src/ui/NotAuthorized.html` — full implementation.
- `src/ui/Nav.html` — trivial stub (real version in Chunk 5).

**Modified**

- `src/appsscript.json` — added `script.external_request` scope.

**Untouched (still 1-line stubs, deferred per build-plan Chunk 1)**

- `src/core/Lock.gs` — Chunk 2 (no writes yet).
- `src/repos/AuditRepo.gs`, `src/repos/BuildingsRepo.gs`,
  `src/repos/WardsRepo.gs`, `src/repos/TemplatesRepo.gs`,
  `src/repos/SeatsRepo.gs`, `src/repos/RequestsRepo.gs` — Chunks 2/5.
- `src/services/Bootstrap.gs`, `src/services/Importer.gs`,
  `src/services/Expiry.gs`, `src/services/RequestsService.gs`,
  `src/services/EmailService.gs`, `src/services/TriggersService.gs` —
  Chunks 3/4/6/8/9.
- `src/api/ApiBishopric.gs`, `src/api/ApiStake.gs`, `src/api/ApiManager.gs`
  — Chunks 2/5/6.
- `src/ui/BootstrapWizard.html` — Chunk 4.
- `src/ui/bishopric/*`, `src/ui/stake/*`, `src/ui/manager/*` — Chunks 5+.

## Confirmation that the Chunk 1 deferrals list was respected

Per `build-plan.md` Chunk 1 → "Explicitly deferred to later chunks":

- ✅ `core/Lock.gs#withLock` — not touched (Chunk 2).
- ✅ `repos/AuditRepo.gs` — not touched (Chunk 2).
- ✅ Any `insert` / `update` / `delete` on any repo — none added (Chunk 2).
- ✅ `ui/Nav.html` beyond a trivial stub — left as a one-line stub (Chunk 5).
- ✅ `ui/bishopric/Roster.html`, `ui/stake/Roster.html`, `ui/manager/*` —
  all left as one-line stubs (Chunk 5+).
- ✅ Bootstrap wizard (`services/Bootstrap.gs`, `ui/BootstrapWizard.html`)
  — left as stubs (Chunk 4).
- ✅ Importer (`services/Importer.gs`) — left as stub (Chunk 3).
- ✅ Ward / Building / Template repos and any writes — left as stubs (Chunk 2).
- ✅ Email notifications (`services/EmailService.gs`) — left as stub (Chunk 6).
- ✅ Triggers (`services/TriggersService.gs` installation) — left as stub
  (Chunks 4/8/9).
- ✅ Production deploy / Cloudflare Worker / custom domain — not touched
  (Chunk 11).

## Manual test setup (Chunk-1-only)

The bootstrap wizard lands in Chunk 4, so for Chunk 1 testing the user must
hand-seed the sheet:

1. Run `setupSheet()` once from the Apps Script editor.
2. In the `Config` tab, set `bootstrap_admin_email` and `gsi_client_id`.
3. To exercise Proof 4 (role resolver) end-to-end:
   - Add a row in `KindooManagers` for the deployer's canonical email
     (`active=TRUE`) → expect `manager` role.
   - Add a row in `Access` with `scope=stake, calling=Stake President` →
     expect `stake` role.
   - Add a row in `Access` with `scope=cordera-1st, calling=Bishop` →
     expect `bishopric` role with `wardId=cordera-1st`.

These manual rows go away once Chunk 3 (Importer) writes `Access` and
Chunk 4 (Bootstrap wizard) writes `KindooManagers`.

## Next

Chunk 2 (Config CRUD) introduces the first writes, and with them
`core/Lock.gs#withLock` and `repos/AuditRepo.gs`. Every API endpoint
added in Chunk 2 should mirror the `(jwt, …) → Auth_principalFrom →
Auth_requireRole('manager') → Lock_withLock(...) → AuditRepo.write(...)`
shape established by `ApiShared_bootstrap` here.
