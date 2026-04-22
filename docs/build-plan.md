# Build plan

11 chunks, each independently reviewable and shippable. Dependency graph below each chunk; acceptance criteria are the "done" signal — if the criteria don't all pass, the chunk isn't shippable.

## Dependency overview

```
1 Scaffolding
 └─ 2 Config CRUD
     ├─ 3 Importer   ──────────┐
     ├─ 4 Bootstrap wizard     │
     └─ 5 Rosters (read-only) ─┤
          └─ 6 Requests v1 ────┤
               ├─ 7 Removals   │
               └─ 8 Expiry ────┤
                    └─ 9 Weekly import trigger + over-cap
                         └─ 10 Audit Log page + polish
                              └─ 11 Cloudflare Worker
```

Chunks 3 and 4 can develop in parallel after Chunk 2. Chunk 5 and 8 can develop in parallel after 3/6.

---

## Chunk 1 — Scaffolding `[DONE — see docs/changelog/chunk-1-scaffolding.md]`

**Goal:** deploy an empty-but-real web app that demonstrates the full auth handshake — unauthenticated users get a login, signed-in users see their resolved roles or a clean "not authorized" page.

**Dependencies:** none.

**Proof-driven scope.** Chunk 1 existed to demonstrate six specific things. The proofs below were originally framed around Google Sign-In (GSI) drop-in button + JWT verification, but during the chunk we discovered that no browser-initiated Google OAuth flow can succeed from inside Apps Script HtmlService (the iframe runs on `*.googleusercontent.com`, which is on Google's permanent OAuth-origin denylist). The proofs were re-cast for the **two-deployment Session+HMAC** pattern that finally landed; the discovery trail (three failed pivots) is in `docs/open-questions.md` A-8 and `docs/changelog/chunk-1-scaffolding.md`.

**The 6 proofs (acceptance criteria — final form)**

1. **Login page loads.** Visiting Main `/exec` while signed out shows `ui/Login.html` — a "Sign in with Google" anchor whose `href` is `Config.identity_url + ?service=identity`. No blank pages, no server errors.
2. **Sign-in produces a verifiable session token.** Clicking the link navigates the top frame to the Identity deployment (`executeAs: USER_ACCESSING`); `Identity_serve` reads `Session.getActiveUser().getEmail()`, HMAC-signs `{email, exp, nonce}` with `Config.session_secret`, and renders a redirect page that lands the top frame back on Main `/exec?token=…`.
3. **Server verifies the token and extracts email.** Main's `doGet` reads `?token=`, calls `Auth_verifySessionToken` (constant-time HMAC-SHA256 compare against `session_secret`, plus `exp > now − 30s` check), injects the verified token into the rendered Layout. Tampered signature → `AuthInvalid`. Past-exp → `AuthExpired`. Token persists in `sessionStorage.jwt` and is re-verified on every `google.script.run` call.
4. **Role resolver resolves the verified email against the Sheet.** `Auth_resolveRoles` reads `KindooManagers` (active=true) and `Access` and returns the union of roles for the verified email. Canonical-email matching (D4) lets `alice.smith@gmail.com` in the sheet match `alicesmith@gmail.com` from `Session.getActiveUser`.
5. **Hello page renders with email + roles.** A Chunk-1-only `ui/Hello.html` template shows `Hello, [name] ([email]) — you are role X (wardId Y)` for every role the user holds. No real roster / request UI yet.
6. **Failure modes land correctly.** No token → login page. Token OK but the email has no role → `NotAuthorized.html`. Stale/invalid token → client clears `sessionStorage.jwt` and re-shows login.

**Sub-tasks (final form, all complete)**

_Infrastructure (serves all six proofs)_

- [x] Create the backing Google Sheet and bind an Apps Script project (see `docs/sheet-setup.md`).
- [x] `clasp clone <scriptId>` into `src/`.
- [x] Write `appsscript.json` with `webapp.access = "ANYONE"` and the minimum scope set (no OAuth client; no `script.external_request`).
- [x] Implement `services/Setup.gs#setupSheet()` — creates all 10 tabs with headers, idempotent; auto-generates `Config.session_secret` on first run.
- [x] Implement `scripts/stamp-version.js` + `npm run push` wrapper — stamps `src/core/Version.gs` with a UTC ISO timestamp on every push; Layout shell renders it as a tiny footer for stale-deployment detection.
- [x] Deploy **Main** (`executeAs: USER_DEPLOYING`) and **Identity** (`executeAs: USER_ACCESSING`) web apps; paste their URLs into `Config.main_url` and `Config.identity_url`.

_Proof 1 — login page loads_

- [x] Implement `ui/Layout.html` — shell that injects `identity_url`, `main_url`, `app_version`, and the per-request `injected_token` / `injected_error`.
- [x] Implement `ui/Login.html` — anchor whose `href` is `Config.identity_url + ?service=identity` (auto-appended by Layout's `showLogin` so users paste the bare URL into Config).
- [x] Implement `core/Main.gs#doGet(e)` — routes to `Identity_serve` on `?service=identity`, otherwise renders Layout (Main UI branch).

_Proof 2 — token issuance_

- [x] Implement `services/Identity.gs#Identity_serve()` — calls `Session.getActiveUser().getEmail()` (works under `USER_ACCESSING`); HMAC-signs the email via `Auth_signSessionToken`; renders a top-frame redirect to `Config.main_url + ?token=…`.
- [x] Implement `core/Auth.gs#Auth_signSessionToken(email, ttlSeconds?)` — base64url-encodes `{email, exp, nonce}` and HMAC-SHA256-signs with `Config.session_secret`. Two-segment token, dot-separated.

_Proof 3 — server verifies the token_

- [x] Implement `core/Utils.gs` with `normaliseEmail` (D4 canonicalisation), `hashRow`, `nowTs`, `todayIso`, base64url encode/decode helpers. Unit-test `normaliseEmail` with at least: `Alice.Smith@Gmail.com`, `alicesmith+church@googlemail.com`, `alice@csnorth.org` (dots retained), `  Bob@Foo.COM  ` (trim + lowercase only). Unit-test base64url encode + decode round-trip.
- [x] Implement `repos/ConfigRepo.gs` — read-only accessors for `session_secret`, `main_url`, `identity_url`, `bootstrap_admin_email`, `setup_complete` (no writes in this chunk).
- [x] Implement `core/Auth.gs#Auth_verifySessionToken(token)` — constant-time HMAC re-verify; `exp` check with 30-s clock-skew leeway; throws `AuthInvalid` / `AuthExpired` / `AuthNotConfigured`.
- [x] Implement `ui/ClientUtils.html#rpc(name, args)` — promise wrapper over `google.script.run`; auto-injects `sessionStorage.jwt` as the first argument. On `AuthExpired` / `AuthInvalid` response, clear `sessionStorage.jwt` and switch to login view.

_Proof 4 — role resolver_

- [x] Implement `repos/KindooManagersRepo.gs`, `repos/AccessRepo.gs` — read-only `getAll` / `getByEmail` (no writes in this chunk).
- [x] Implement `core/Auth.gs#Auth_resolveRoles(email)` — returns `{ email, roles: [{type, wardId?}, ...] }`. Matching is on canonical email.
- [x] Implement `core/Auth.gs#Auth_principalFrom(token)` — `Auth_verifySessionToken` → `Auth_resolveRoles` composition.
- [x] Implement `core/Auth.gs#Auth_requireRole(principal, matcher)` and `Auth_requireWardScope(principal, wardId)` so Chunk 2+ has them ready.

_Proof 5 — hello page_

- [x] Implement `core/Router.gs#Router_pick(requestedPage, principal)` — for Chunk 1 always returns the hello template (or NotAuthorized if `roles.length === 0`).
- [x] Implement `api/ApiShared.gs#ApiShared_bootstrap(token, requestedPage)` — `Auth_principalFrom(token)` → `Router_pick` → return `{ principal, template, pageModel, pageHtml }`.
- [x] Implement `ui/Hello.html` — temporary Chunk-1-only template that renders `Hello, [name] ([email]) — you are role X (wardId Y)` for every role held. **This file is deleted in Chunk 5** when real rosters land; do not reuse it.

_Proof 6 — failure modes_

- [x] Implement `ui/NotAuthorized.html` — shown when `principal.roles.length === 0`; mentions the bishopric-import-lag possibility.
- [x] Verify the client's `AuthExpired` / `AuthInvalid` branch by hand-invalidating `sessionStorage.jwt`.

**Explicitly deferred to later chunks** (respected — none built in Chunk 1)

- `core/Lock.gs#withLock` — no writes in Chunk 1, so no lock. Moves to **Chunk 2**.
- `repos/AuditRepo.gs` — nothing to audit yet. **Chunk 2**.
- Any `insert` / `update` / `delete` on any repo. **Chunk 2**.
- `ui/Nav.html` beyond a trivial stub — real role-aware navigation lives in **Chunk 5**.
- `ui/bishopric/Roster.html`, `ui/stake/Roster.html`, `ui/manager/*` — all **Chunk 5+**.
- Bootstrap wizard (`services/Bootstrap.gs`, `ui/BootstrapWizard.html`) — **Chunk 4**.
- Importer (`services/Importer.gs`) — **Chunk 3**.
- Ward / Building / Template repos and any writes — **Chunk 2**.
- Email notifications (`services/EmailService.gs`) — **Chunk 6**.
- Triggers (`services/TriggersService.gs` installation) — **Chunks 4/8/9** depending on trigger.
- Production deploy / Cloudflare Worker / custom domain — **Chunk 11**.

---

## Chunk 2 — Config CRUD `[DONE — see docs/changelog/chunk-2-config-crud.md]`

**Goal:** Kindoo Managers can edit all configuration tabs from the app.

**Dependencies:** Chunk 1.

**Sub-tasks**

- [x] Implement `core/Lock.gs#withLock(fn, opts)` — `LockService.getScriptLock()`, 10 s default tryLock timeout, throws a user-friendly error on contention. (Deferred from Chunk 1; this is the first chunk with writes.)
- [x] Implement `repos/AuditRepo.gs#write({ actor_email, action, entity_type, entity_id, before, after })` — append-only; callers pass `actor_email` explicitly (per the "two identities" note in architecture.md §5).
- [x] Extend each config repo with `insert`, `update`, `delete`. Lock acquisition + audit emission live in the **API layer** (one lock acquisition per endpoint, audit row written inside the same closure). Repos stay pure single-tab data access; see architecture.md §7 for the resolved repo-vs-API responsibility split.
- [x] Implement `repos/WardsRepo.gs`, `repos/BuildingsRepo.gs`, `repos/TemplatesRepo.gs` (full CRUD).
- [x] Implement `api/ApiManager.gs` endpoints: `ApiManager_configList`, `ApiManager_configUpdate`, `ApiManager_wardsList`, `ApiManager_wardsUpsert`, `ApiManager_wardsDelete`, `ApiManager_buildings*`, `ApiManager_kindooManagers*`, `ApiManager_wardTemplate*`, `ApiManager_stakeTemplate*`. Each calls `Auth_requireRole(principal, 'manager')` first.
- [x] Implement `ui/manager/Config.html` — tabbed editor, one tab per editable table. Simple HTML tables with inline forms. Re-uses `rpc` (and a new `toast`) from `ui/ClientUtils.html`.
- [x] Wire the router so `?p=mgr/config` reaches the new template (manager only); add a single deep-link from `Hello.html` for managers so the page is reachable without URL surgery during Chunks 2–4.
- [x] Manual test: add a ward, toggle a manager inactive, add a template row, edit a Config key.

**Acceptance criteria**

- Manager can add/edit/delete every configurable row from the UI.
- Non-manager users cannot hit the manager API endpoints (403-equivalent error surfaced as a toast).
- Every edit produces one `AuditLog` row with before/after JSON.
- No writes happen without acquiring the script lock (verified by reading the code).

**Out of scope**

- `Access` edits (Chunk 3 — the importer owns that tab).
- `Seats` inline edit on the manager All Seats page (Chunk 5/6).
- The four "protected" Config keys (`session_secret`, `main_url`, `identity_url`, `bootstrap_admin_email`) are intentionally **read-only** in the Config UI — see `open-questions.md` C-4. Importer-owned keys (`last_import_at`, `last_import_summary`) are also read-only in the UI even though Importer (Chunk 3) writes them.
- Ward → Seats foreign-key check on Ward delete is deferred to Chunk 5 when SeatsRepo lands; in Chunk 2 there are no Seat rows to reference, so the check is a no-op.

---

## Chunk 3 — Importer `[DONE — see docs/changelog/chunk-3-importer.md]`

**Goal:** Kindoo Manager can click "Import Now" and have auto-seats + Access rows reflect the current callings spreadsheet.

**Dependencies:** Chunk 2 (needs Wards + templates).

**Sub-tasks**

- [x] Implement `services/Importer.gs#Importer_runImport({ triggeredBy })`:
  - Open the callings sheet via `SpreadsheetApp.openById(Config.callings_sheet_id)`.
  - Loop tabs; match tab names against `Wards.ward_code` or `"Stake"`.
  - For each matched tab: parse rows, strip prefix, collect `(calling, email)` pairs from `Personal Email` + right-hand-side columns.
  - Filter pairs to those matching the appropriate template.
  - Compute `source_row_hash` for each.
  - Diff against existing auto-seats for that scope; insert new, delete missing.
  - Diff against existing `Access` rows (where template row has `give_app_access=true`); upsert new, delete missing.
  - Write `import_start` / `import_end` brackets around the per-row AuditLog entries, all inside one lock acquisition.
  - Update `Config.last_import_at` and `Config.last_import_summary`.
- [x] Implement `api/ApiManager.gs#ApiManager_importerRun` (plus sibling `ApiManager_importStatus`, `ApiManager_accessList` for page-load fetches).
- [x] Implement `ui/manager/Import.html` — "Import Now" button, shows spinner, then shows last import time and summary.
- [x] Implement `ui/manager/Access.html` — read-only table of `Access` rows.
- [x] Test with a snapshot of the real callings spreadsheet — confirm expected inserts/deletes.

**Acceptance criteria**

- Given a prepared callings sheet, clicking "Import Now" populates `Seats` (auto rows) and `Access` correctly the first time.
- Running it again with no changes produces zero inserts and zero deletes (idempotent).
- Changing a person in the callings sheet and re-running produces exactly one delete + one insert for the affected row.
- Removing a calling from the template deletes the corresponding auto-seats on the next run.
- Every change produces a per-row `AuditLog` entry with actor `"Importer"` (literal string, not the manager's email — the manager's email is recorded only as `triggeredBy` in the `import_start` / `import_end` payloads).
- Per D4 (as revised in Chunk 2): emails written to `Seats.person_email` and `Access.email` are stored **as typed** (trim only via `Utils_cleanEmail`), not canonicalised. `source_row_hash` is computed on the canonical form (`Utils_normaliseEmail`) so the diff is stable across Gmail dot/`+suffix` variants — verified by flipping a source email between `First.Last@gmail.com` and `firstlast@gmail.com` and confirming zero inserts/deletes on re-run.

**Out of scope**

- Weekly time-based trigger (Chunk 9).
- Over-cap warning emails (Chunk 9).

---

## Chunk 4 — Bootstrap wizard `[DONE — see docs/changelog/chunk-4-bootstrap.md]`

**Goal:** a fresh install can be configured end-to-end by the bootstrap admin without touching the sheet by hand.

**Dependencies:** Chunk 2 (wizard steps write to config tabs).

**Sub-tasks**

- [x] Add gating to `api/ApiShared.gs#ApiShared_bootstrap`: if `Config.setup_complete=false`, the bootstrap admin hits the wizard (regardless of `?p=`); everyone else gets a "setup in progress" page. Runs before role resolution.
- [x] Implement `services/Bootstrap.gs` state-machine + `ApiBootstrap_*` endpoints with their own auth gate (bootstrap admin + `setup_complete=false`):
  - Step 1: stake name + callings-sheet ID + stake seat cap.
  - Step 2: at least one Building.
  - Step 3: at least one Ward (with `ward_code`, `ward_name`, `building_name`, `seat_cap`).
  - Step 4: additional Kindoo Managers (optional). The bootstrap admin is auto-added as the first active KindooManager on wizard entry.
  - Finish: install triggers (stubbed — real install is Chunks 8/9), set `setup_complete=true`, write `setup_complete` audit row, redirect to the Main URL (normal role resolution → manager default page).
- [x] Implement `ui/BootstrapWizard.html` + `ui/SetupInProgress.html`.
- [x] Stub `services/TriggersService.gs#TriggersService_install` (no-op log; real triggers are Chunks 8/9).
- [x] Test on a fresh sheet end-to-end.

**Acceptance criteria**

- Fresh sheet + first visit as bootstrap admin → wizard appears regardless of `?p=` on the URL.
- Non-admins hitting the app during bootstrap see the "setup in progress" page (not `NotAuthorized`).
- Completing the wizard flips `setup_complete` to true, calls `TriggersService_install`, and writes an `AuditLog` row with `action='setup_complete'`. (Verifying real triggers via `ScriptApp.getProjectTriggers()` lands in Chunks 8/9 when the real install code ships.)
- Re-visiting after completion lands on the normal role-based default page; every `ApiBootstrap_*` endpoint refuses post-setup.

**Out of scope**

- Post-setup re-running of the wizard (one-shot by design — `ApiBootstrap_*` endpoints refuse once `setup_complete=true`).
- Actual installation of daily expiry / weekly import triggers — `TriggersService_install` is a no-op stub this chunk; Chunks 8 and 9 add the real `ScriptApp.newTrigger` calls. The wizard calls the stub and audits the call so the flow is correct end-to-end.

---

## Chunk 5 — Rosters (read-only) `[DONE — see docs/changelog/chunk-5-rosters.md]`

**Goal:** bishoprics, stake presidency, and managers can read seat rosters.

**Dependencies:** Chunk 3 (so rosters have real data).

**Sub-tasks**

- [x] Extend `repos/SeatsRepo.gs` with `Seats_getAll()` (manager AllSeats does one full-scan read instead of N per-scope reads); `Seats_getByScope` was already present from Chunk 3.
- [x] Implement `services/Rosters.gs` — shared row mapper + per-scope utilization math, called by every roster endpoint so the four read-side UIs share one shape.
- [x] Add `core/Auth.gs#Auth_findBishopricRole(principal)` — returns the first bishopric role (with `wardId`) or null; used by `ApiBishopric_roster` to derive scope from the verified principal so the endpoint doesn't accept a spoofable parameter.
- [x] Implement `api/ApiBishopric.gs#ApiBishopric_roster`, `api/ApiStake.gs#ApiStake_roster` / `ApiStake_wardRoster(wardCode)` / `ApiStake_wardsList`, `api/ApiManager.gs#ApiManager_allSeats(filters)`.
- [x] Extend `api/ApiManager.gs#ApiManager_test_forbidden` with scope-guard checks: `Auth_findBishopricRole(stake-only) === null`; CO bishopric fails `Auth_requireRole(stake)`; CO bishopric fails `Auth_requireWardScope(GE)`; CO bishopric passes `Auth_requireWardScope(CO)`.
- [x] Implement `ui/bishopric/Roster.html` — ward roster with utilization bar.
- [x] Implement `ui/stake/Roster.html` — stake roster with utilization bar.
- [x] Implement `ui/stake/WardRosters.html` — dropdown + read-only ward roster.
- [x] Implement `ui/manager/AllSeats.html` — full roster with `ward`/`building`/`type` filters; per-scope summary cards with utilization bars above the filtered table; deep-link filter state via URL query params (read server-side from `Main.doGet`, forwarded into `QUERY_PARAMS` on the client).
- [x] Rebuild `ui/Nav.html` as real role-aware navigation — role union of links, active-page highlight, rendered by `Router_pick` as `navHtml` alongside `pageHtml`.
- [x] Add sign-out button to the topbar (`ui/Layout.html`) — clears `sessionStorage.jwt` and reloads top to bare `MAIN_URL`.
- [x] Delete `ui/Hello.html`; `Router_pick` returns role defaults on empty/unrecognised `?p=` (manager → `mgr/seats`, stake → `stake/roster`, bishopric → `bishopric/roster`; highest-privilege role wins on multi-role principals).
- [x] Add Chunk-5 CSS to `ui/Styles.html` (nav, utilization bars, roster table, badges, AllSeats filter row + summary cards). Add `escapeHtml` / `renderUtilizationBar` / `renderRosterTable` / `rosterRowHtml` helpers to `ui/ClientUtils.html` so the four read-side UIs share rendering.

**Acceptance criteria**

- Bishopric sees only their own ward's seats. Hand-crafted `ApiBishopric_roster` call from a non-bishopric browser console throws `Forbidden: bishopric role required`. `ApiStake_*` from a bishopric-only console throws `Forbidden`.
- Stake sees the stake pool on `stake/roster`; `stake/ward-rosters` lists every ward (via `ApiStake_wardsList`) and picking one renders that ward read-only via `ApiStake_wardRoster(wardCode)`.
- Manager `mgr/seats` page filters combine as AND: ward + building + type. Deep link `?p=mgr/seats&ward=CO&type=manual` lands with both filters pre-populated from `QUERY_PARAMS`.
- Utilization bar renders `total_seats / seat_cap`; when `total_seats > seat_cap` the bar colour flips and the label shows an "OVER CAP" flag (e.g. 21/20). Cap-unset scopes render a neutral "N seats (cap unset)" label with no bar.
- Temp seats with `end_date <= today` render an "expired" / "expires today" badge (Chunk-8 expiry trigger will delete them; until then the badge signals why utilization is high).
- Nav highlights the current page via `?p=`; sign-out link clears `sessionStorage.jwt` and returns to Login. Nav hides every link for unbuilt chunks (New Request / My Requests / Requests Queue / Dashboard / Audit Log).
- Visiting `/exec` with an empty or unrecognised `?p=` routes to the principal's role default. Post-bootstrap completion (Chunk 4 `ApiBootstrap_complete` → redirect to Main URL) lands the admin on `mgr/seats` (manager default) rather than a 404.

**Out of scope**

- Request submission (Chunk 6), removal actions (Chunk 7), manager inline edits (Chunk 6).
- Server-side pagination. Target scale (~20 seats/ward, 250 seats total) fits a single-page render with room to spare.
- URL reflects post-load filter changes on AllSeats. Filter state flows *in* from the URL on page load (deep-link support works), but changing a filter does not rewrite the top-frame URL — the HtmlService iframe can't manipulate top's `history.replaceState` cross-origin (open-questions.md A-8). Acceptable trade-off; the shareable-deep-link use case still works.
- "Redirect with toast" UX when a user hits a `?p=` they can't access — currently silent fall-through to role default. Toast is Chunk-10 polish.

---

## Chunk 6 — Requests v1 (add flows + queue) `[DONE — see docs/changelog/chunk-6-requests.md]`

**Goal:** the full add-manual / add-temp request lifecycle works, including email.

**Dependencies:** Chunk 5.

**Policy (confirmed):** A manager may complete or reject a request they themselves submitted. No self-approval guard is needed in the queue UI or the server-side handler.

**Sub-tasks**

- [x] Implement `repos/RequestsRepo.gs` — full CRUD minus delete (cancelled/rejected/completed rows persist for the audit trail). Limited-field `Requests_update` (only `status`, `completer_email`, `completed_at`, `rejection_reason` are mutable).
- [x] Implement `services/RequestsService.gs`:
  - `RequestsService_submit({scope, requesterPrincipal, draft})` — validates the draft, writes the `pending` row, emits one `submit_request` audit row, returns `{request}`. Email is sent AFTER the lock by the API layer.
  - `RequestsService_complete(managerPrincipal, requestId)` — asserts `status==='pending'`, inserts the matching `Seats` row (manual/temp), flips the Request to `complete`, emits two audit rows (`complete_request` on Request + `insert` on Seat). Returns `{request, seat}`.
  - `RequestsService_reject(managerPrincipal, requestId, reason)` — requires a non-empty reason; asserts pending; flips to `rejected`; emits one `reject_request` audit row.
  - `RequestsService_cancel(requesterPrincipal, requestId)` — requires the principal's email to match `requester_email` (canonical-equal); asserts pending; flips to `cancelled`; emits one `cancel_request` audit row.
  - All wrapped in `Lock_withLock` at the API layer; audit rows all emitted inside the same closure.
- [x] Implement `services/EmailService.gs` — typed wrappers: `notifyManagersNewRequest`, `notifyRequesterCompleted`, `notifyRequesterRejected`, `notifyManagersCancelled`. Global kill-switch via `Config.notifications_enabled` (default `TRUE`). Sent OUTSIDE the lock, best-effort, with a surfaced `warning` on failure.
- [x] Consolidated to single top-level `ui/NewRequest.html` + `ui/MyRequests.html` instead of bishopric/* + stake/* pairs. Scope selector for multi-role principals; implicit scope + label for single-role. `ui/manager/RequestsQueue.html` shows all pending with ward/type filters, per-request seat preview, and inline duplicate warning.
- [x] Consolidated request endpoints in a new `api/ApiRequests.gs`: `ApiRequests_submit(token, draft, scope?)`, `ApiRequests_listMy(token, scope?)`, `ApiRequests_cancel(token, requestId)`, `ApiRequests_checkDuplicate(token, targetEmail, scope?)`. Scope is required when the principal holds multiple request-capable roles, inferred otherwise, always validated against `Auth_requestableScopes(principal)` server-side.
- [x] Manager-side endpoints in `api/ApiManager.gs`: `ApiManager_listRequests(filters)`, `ApiManager_completeRequest`, `ApiManager_rejectRequest`, `ApiManager_updateSeat`.
- [x] New Request client-side duplicate check calls `ApiRequests_checkDuplicate(targetEmail, scope)`; warns with an inline roster table (via `rosterRowHtml`); does not block.
- [x] Manager inline edit of `Seats` on All Seats page — person_name, reason, building_names; plus start_date/end_date on temp. Auto rows are not editable (importer-owned).
- [x] Nav + Router updated: new `?p=new`, `?p=my`, `?p=mgr/queue` pages. `new` and `my` accept bishopric OR stake roles (the first pages with a multi-role access shape; `Router_hasAllowedRole_` supports both).
- [x] New `Config.notifications_enabled` (boolean) seeded by `setupSheet` with default `TRUE`; editable in the manager Configuration page's Editable table as a checkbox.

**Acceptance criteria**

- Full happy path `add_manual`: requester submits → manager email arrives → manager completes → `Seats` row appears → requester email arrives.
- Full happy path `add_temp`: same plus `start_date` / `end_date` on `Seats`.
- Reject path: row flipped to `rejected`, requester email includes reason.
- Cancel path: pending row flipped to `cancelled`, manager email sent.
- Duplicate warning shows when submitting against an existing active seat.
- Emails send from the deployer and include a link back to `/exec?p=...`.

**Out of scope**

- Remove requests (Chunk 7).

---

## Chunk 7 — Removals `[DONE — see docs/changelog/chunk-7-removals.md]`

**Goal:** bishoprics and stake can request removal of a manual/temp seat via the Roster X button; managers complete the request to delete the seat.

**Dependencies:** Chunk 6.

**Sub-tasks**

- [x] Add X/trashcan control on `bishopric/Roster.html` and `stake/Roster.html` for `manual`/`temp` rows only (auto rows render no X — importer-owned).
- [x] Modal: "Remove access for [person]?" with required reason field → submits `type=remove` request via the shared `ApiRequests_submit`.
- [x] "Removal pending" badge on any roster row with an outstanding `remove` request for that `(scope, person_email)`. X is rendered as a disabled glyph for those rows.
- [x] `Rosters_buildResponseFromSeats_` annotates each row's `removal_pending` from a per-scope pending-remove map built once in `Rosters_buildContext_`.
- [x] `RequestsService_submit` validates remove drafts: target must have an active manual/temp seat in scope (R-3); no other pending remove for the same `(scope, target_email)`.
- [x] `RequestsService_complete` handles `remove` type: deletes the matching `Seats` row via the new `Seats_deleteById`. Two audit rows on the happy path (`complete_request` + `delete`).
- [x] R-1 race: if the seat is already gone at completion time, flip the Request to `complete` with a `completion_note` ("Seat already removed at completion time (no-op).") and emit ONE audit row. Requester still gets the completion email; the body surfaces the note.
- [x] Add `completion_note` column to the Requests tab (data-model.md updated; setupSheet seeds the new header for fresh installs; existing installs add the column by hand — `setupSheet` reports header drift loudly so the operator notices).
- [x] Manager queue and MyRequests render remove-type rows: queue card preview is the live `current_seat` styled "will be deleted" (or an "already removed (no-op)" panel when the seat is gone); MyRequests row shows the type label, the target, and a clickable "note" hint surfacing `completion_note` on completed remove rows.
- [x] Email body copy for all four notifications updated to be type-aware (handles `remove` alongside `add_manual` / `add_temp`); the completion email surfaces `completion_note` for the R-1 case.

**Acceptance criteria**

- Bishopric can request removal; badge appears immediately on refresh; X is disabled while the request is pending.
- Manager completes; `Seats` row deleted; badge gone; AuditLog has `complete_request` + `delete` rows.
- Concurrent race (two remove requests for same seat, OR a hand-edit of the Sheet between submit and Complete) doesn't double-delete or error: the second Complete auto-completes with the no-op note and emits only one audit row.
- Submitting a remove for a target with no active seat is rejected server-side with a clear error.
- Submitting a remove for a target whose only active seat is `auto` is rejected server-side ("auto seats come from the callings sheet…").
- Submitting a remove for a target with more than one removable manual/temp seat in the scope is rejected server-side ("Multiple removable seats found…"), since the request shape can't disambiguate.
- Submitting a duplicate remove (same scope + target) while one is pending is rejected server-side.
- Manager queue surfaces three distinct messages for pending remove cards: a strikethrough preview ("Seat to delete on Complete"), an "Only an LCR-managed seat remains" warning when only auto matches exist, and an "Already removed (no-op)" warning when nothing matches.
- Cancelling / Rejecting a pending remove works unchanged from Chunk 6's flow; emails read correctly for the remove type.

**Out of scope**

- Removals for auto-seats (not allowed by spec — that's an LCR change). Server rejects the submit explicitly.
- New email types — the four Chunk-6 notifications cover all three request types; only body copy needed updating.

---

## Chunk 8 — Expiry trigger `[DONE — see docs/changelog/chunk-8-expiry.md]`

**Goal:** temp seats disappear on their `end_date`.

**Dependencies:** Chunk 6 (to have temp seats to expire).

**Sub-tasks**

- [x] Implement `services/Expiry.gs#Expiry_runExpiry()` — scans `Seats` for `type=temp AND end_date < today (Utils_todayIso, script tz)`, deletes inside a single `Lock_withLock(30 s)`, collects `before`-rows, flushes per-row `AuditLog` entries via `AuditRepo_writeMany` at end of run, logs a `[Expiry] completed in Xms — N rows expired` summary.
- [x] Extend `services/TriggersService.gs` to install a daily time-based trigger on `Expiry_runExpiry` at `Config.expiry_hour`. Idempotent — re-running removes existing planned triggers and installs fresh ones. Return shape `{installed, removed, message}`.
- [x] Bootstrap wizard's Complete-Setup step already calls `TriggersService_install` (Chunk 4); it becomes real this chunk. The returned `message` flows into the `setup_complete` audit row's `after_json.triggers_install` field.
- [x] Add manager-facing surface: `ApiManager_listTriggers` (read-only) and `ApiManager_reinstallTriggers` (writes audit `action='reinstall_triggers'`). Add "Reinstall triggers" button + live triggers list to the manager Configuration page; the `expiry_hour` row carries a hint that saving alone doesn't reschedule.
- [x] `Kindoo Admin → Install/reinstall triggers` + `Kindoo Admin → Run expiry now` sheet-menu items (via `services/Setup.gs#onOpen`) so an operator can self-heal without leaving the Sheet.
- [x] Utilization math: no code change needed — Chunk 5's Rosters service counts every row in `Seats`, so expiry naturally drops the count and clears the "expired" badge once the row is gone (verified in the manual walkthrough).

**Acceptance criteria**

- A temp row with `end_date < today (local tz)` is deleted within 24 hours (by the daily trigger at `Config.expiry_hour`); a manual run via `Kindoo Admin → Run expiry now` deletes it immediately.
- The deletion appears in `AuditLog` with `actor_email='ExpiryTrigger'`, `action='auto_expire'`, `entity_type='Seat'`, `entity_id=<seat_id>`, populated `before_json`, empty `after_json`.
- A seat with `end_date=today` is NOT deleted (today is not strictly less than today); a seat with `end_date=tomorrow` is NOT deleted.
- Non-temp seats (`auto`, `manual`) are NOT deleted regardless of date.
- Running `Expiry_runExpiry` twice in a row produces zero deletes on the second run.
- `TriggersService_install()` is safely re-runnable: a second call removes the existing `Expiry_runExpiry` trigger and creates a fresh one. `ScriptApp.getProjectTriggers()` shows exactly one daily trigger for `Expiry_runExpiry` after either call.
- Bootstrap Complete-Setup's audit row now carries the real install summary in `after_json.triggers_install` (no longer the Chunk-4 stub's log-line).
- Manager clicks "Reinstall triggers" → triggers list updates live, one audit row written with `action='reinstall_triggers'`.
- R-1 race integration (from Chunk 7): a pending remove request whose target temp seat is deleted by Expiry auto-completes on the manager's subsequent Complete click with the `completion_note` stamped — two distinct audit rows (`auto_expire` from Expiry, `complete_request` from Complete), not a duplicate delete.

**Out of scope**

- Notifying users when their temp seat expires (not in spec).
- Weekly import trigger (Chunk 9).
- Over-cap warning emails (Chunk 9).

---

## Chunk 9 — Weekly import trigger + over-cap warnings

**Goal:** imports happen automatically weekly; cap violations surface to managers.

**Dependencies:** Chunk 3, Chunk 8.

**Sub-tasks**

- [ ] Extend `TriggersService.install()` to also install a weekly trigger on `Importer_runImport`.
- [ ] After each import run, compute per-ward and stake seat counts and compare against caps.
- [ ] If over cap, write an `over_cap_warning` AuditLog row and send an email via `EmailService.notifyManagersOverCap(pools)`.
- [ ] Surface the warning on the manager dashboard (`ui/manager/Dashboard.html` gets a new "Warnings" card).

**Acceptance criteria**

- Weekly trigger is registered after a fresh bootstrap (verified via `ScriptApp.getProjectTriggers()`).
- Intentionally exceeding a ward cap then re-running the importer produces one over-cap email and a dashboard warning.
- Resolving the over-cap and re-importing clears the dashboard warning (no open audit row for it).

**Out of scope**

- Blocking over-cap — spec says imports always apply.

---

## Chunk 10 — Audit Log page + polish

**Goal:** a manager can inspect changes; the whole app looks finished.

**Dependencies:** Chunks 1–9.

**Sub-tasks**

- [ ] Implement `api/ApiManager.gs#auditLog(filters)` — paginate server-side if needed.
- [ ] Implement `ui/manager/AuditLog.html` with filters: `actor_email`, `entity_type`, date range.
- [ ] Flesh out `ui/manager/Dashboard.html`: pending request count, recent activity (last 10 audit rows), per-ward utilization, warnings panel.
- [ ] Shared `ui/Styles.html` pass — responsive layout, table overflow, form spacing.
- [ ] Empty states, loading states, error toasts.

**Acceptance criteria**

- Audit filter combinations work (e.g., "all Importer rows in the last 30 days").
- Dashboard renders correctly with zero data, with one ward, and with all wards.
- Layout is usable on a phone-width viewport (no horizontal scroll on primary pages).

**Out of scope**

- Export to CSV (not in spec).

---

## Chunk 11 — Cloudflare Worker + custom domain

**Goal:** `https://kindoo.csnorth.org` serves the app.

**Dependencies:** a stable deploy from Chunk 10.

**Sub-tasks**

- [ ] Write a Cloudflare Worker that proxies `kindoo.csnorth.org/*` to the `/exec` URL, preserving query strings.
- [ ] Configure DNS: CNAME `kindoo` → workers DNS target, proxied.
- [ ] Bind the worker to `kindoo.csnorth.org/*` via Workers Routes.
- [ ] Add `https://kindoo.csnorth.org` to the OAuth Client ID's Authorized JavaScript origins (GSI will reject from an un-allowlisted origin).
- [ ] Full login flow test end-to-end through the custom domain.
- [ ] If OAuth redirect is broken through the proxy, fall back to a Redirect Rule (302) to the `/exec` URL (documented in architecture.md §11). Note: GSI is popup/One-Tap-based and does not use the server-side OAuth redirect, so this failure mode is orthogonal to the GSI path.

**Acceptance criteria**

- Each role loads, signs in, and navigates successfully via `kindoo.csnorth.org`.
- Deep links (e.g., `kindoo.csnorth.org/?p=mgr/queue`) preserve their query string after auth redirect.

**Out of scope**

- SSL management (Cloudflare handles automatically on the free tier).
- Staging subdomain (deploy additional workers if needed).
