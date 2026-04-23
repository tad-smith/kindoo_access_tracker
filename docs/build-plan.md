# Build plan

11 chunks, each independently reviewable and shippable, plus two performance chunks (10.5 and 10.6) inserted between Chunks 10 and 11 after Chunk 10 shipped — post-polish timing measurements on the deployed app showed page latency was the one thing standing between "functional" and "users will come back." Numbered 10.5 and 10.6 rather than renumbered so the surrounding narrative (the 11-chunk build order in spec.md §14) stays intact. Dependency graph below each chunk; acceptance criteria are the "done" signal — if the criteria don't all pass, the chunk isn't shippable.

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
                              └─ 10.5 Caching pass (perf)
                                   └─ 10.6 Client-side navigation (perf)
                                        └─ 11 Cloudflare Worker
```

Chunks 3 and 4 can develop in parallel after Chunk 2. Chunk 5 and 8 can develop in parallel after 3/6. Chunks 10.5 and 10.6 are strictly sequential — 10.6 layers on top of 10.5's cached reads (but doesn't hard-require them; see 10.6's "Interaction with 10.5" note).

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
- [x] Delete `ui/Hello.html`; `Router_pick` returns role defaults on empty/unrecognised `?p=` (manager → `mgr/seats`, stake → `stake/roster`, bishopric → `bishopric/roster`; highest-privilege role wins on multi-role principals). _Defaults evolved after Chunk 5: Chunk 10 flipped manager → `mgr/dashboard`; post-Chunk-10.6 polish moved stake → `new` and bishopric → `new` so the default matches each role's leftmost nav tab._
- [x] Add Chunk-5 CSS to `ui/Styles.html` (nav, utilization bars, roster table, badges, AllSeats filter row + summary cards). Add `escapeHtml` / `renderUtilizationBar` / `renderRosterTable` / `rosterRowHtml` helpers to `ui/ClientUtils.html` so the four read-side UIs share rendering.

**Acceptance criteria**

- Bishopric sees only their own ward's seats. Hand-crafted `ApiBishopric_roster` call from a non-bishopric browser console throws `Forbidden: bishopric role required`. `ApiStake_*` from a bishopric-only console throws `Forbidden`.
- Stake sees the stake pool on `stake/roster`; `stake/ward-rosters` lists every ward (via `ApiStake_wardsList`) and picking one renders that ward read-only via `ApiStake_wardRoster(wardCode)`.
- Manager `mgr/seats` page filters combine as AND: ward + building + type. Deep link `?p=mgr/seats&ward=CO&type=manual` lands with both filters pre-populated from `QUERY_PARAMS`.
- Utilization bar renders `total_seats / seat_cap`; when `total_seats > seat_cap` the bar colour flips and the label shows an "OVER CAP" flag (e.g. 21/20). Cap-unset scopes render a neutral "N seats (cap unset)" label with no bar.
- Temp seats with `end_date <= today` render an "expired" / "expires today" badge (Chunk-8 expiry trigger will delete them; until then the badge signals why utilization is high).
- Nav highlights the current page via `?p=`; sign-out link clears `sessionStorage.jwt` and returns to Login. Nav hides every link for unbuilt chunks (New Request / My Requests / Requests Queue / Dashboard / Audit Log).
- Visiting `/exec` with an empty or unrecognised `?p=` routes to the principal's role default. Post-bootstrap completion (Chunk 4 `ApiBootstrap_complete` → redirect to Main URL) lands the admin on `mgr/seats` (manager default at Chunk 5 — later flipped to `mgr/dashboard` in Chunk 10) rather than a 404.

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

## Chunk 9 — Weekly import trigger + over-cap warnings `[DONE — see docs/changelog/chunk-9-scheduled.md]`

**Goal:** imports happen automatically weekly; cap violations surface to managers.

**Dependencies:** Chunk 3, Chunk 8.

**Sub-tasks**

- [x] Extend `Triggers_plan_()` with a second entry for `Importer_runImport` (`kind: 'weekly'`). Install/uninstall loop extended to handle `onWeekDay(weekDay).atHour(hour)`; unknown-handler triggers still left alone.
- [x] Seed `Config.import_day` (default `SUNDAY`) and `Config.import_hour` (default `4`). Validate both in `Config_update` — seven canonical weekday names for `import_day`, integer 0–23 for `import_hour`. Reject invalid values with clean errors, not stack traces.
- [x] Move the 30-s `Lock_withLock` acquisition INSIDE `Importer_runImport` so the weekly trigger (no token, no outer lock) and the manual endpoint (`ApiManager_importerRun`) exercise the same acquisition shape. Normalise the opts argument so an Apps Script trigger event defaults to `triggeredBy='weekly-trigger'`.
- [x] After the import lock releases, run `Importer_computeOverCaps_()` (read-only scan over `Seats` + `Wards` + `Config.stake_seat_cap`). Persist the result to `Config.last_over_caps_json` every run (empty array on clean runs). If non-empty, write a single `over_cap_warning` AuditLog row (`entity_type='System'`, `entity_id='over_cap'`, `after={pools, source, triggered_by}`) inside a small follow-up lock, and send `EmailService_notifyManagersOverCap` best-effort OUTSIDE both locks.
- [x] `EmailService_notifyManagersOverCap(pools, source)` — typed wrapper over `MailApp.sendEmail`; plain-text body listing every over-cap pool with counts and a deep-link back to `?p=mgr/seats`; respects `Config.notifications_enabled`.
- [x] Manager Import page (`ui/manager/Import.html`) gains a red over-cap banner above the last-run status panel; reads from `Config.last_over_caps_json` via `ApiManager_importStatus` so page reloads survive. Each pool links to the filtered `mgr/seats` view (`ward=<code>` or `ward=stake`). Dashboard "Warnings card" is deferred to **Chunk 10**.
- [x] Manager Config page renders `import_day` as a dropdown over the seven weekday names; `import_hour` gets a reinstall hint matching `expiry_hour`; save toast on any of the three trigger-schedule keys warns the operator to click "Reinstall triggers."
- [x] `Kindoo Admin → Run weekly import now` menu item on the bound Sheet, for an operator running the same code path the weekly trigger runs without loading the web app.

**Acceptance criteria**

- Both planned triggers (`Expiry_runExpiry` daily, `Importer_runImport` weekly) install after a fresh bootstrap (verified via `ScriptApp.getProjectTriggers()`).
- Re-running `TriggersService_install` removes both planned handlers and installs fresh ones; unknown handlers are left alone.
- Manual import (`ApiManager_importerRun`) with no over-cap: summary populates, no `over_cap_warning` audit row, no email, no banner, `Config.last_over_caps_json='[]'`.
- Manual import that produces over-cap: summary populates, one `over_cap_warning` audit row, manager email sent (or logged if `notifications_enabled=false`), Import page shows the red banner with per-pool counts + deep links.
- `notifications_enabled=false` suppresses the email but the audit row still writes and the banner still shows.
- Weekly-trigger run (simulated by calling `Importer_runImport` without arguments from the editor): `import_start` / `import_end` carry `triggeredBy='weekly-trigger'`; per-row `actor_email` is still `'Importer'`; over-cap behaviour matches the manual path.
- Invalid `import_day` (e.g. `FUNDAY`) — `ApiManager_configUpdate` rejects with a clear error. Invalid `import_hour` (e.g. `25` or `4.5`) — same.
- Resolving the over-cap and re-importing clears the banner (`Config.last_over_caps_json` → `'[]'` on the run) and writes no `over_cap_warning` row.

**Out of scope**

- Blocking over-cap — spec says imports always apply.
- Dashboard Warnings card — lands in Chunk 10 where the Dashboard page itself is built.

---

## Chunk 10 — Audit Log page + polish `[DONE — see docs/changelog/chunk-10-dashboard.md]`

**Goal:** a manager can inspect changes; the whole app looks finished.

**Dependencies:** Chunks 1–9.

**Sub-tasks**

- [x] Implement `api/ApiManager.gs#ApiManager_auditLog(token, filters)` — offset/limit pagination (max 100 rows), AND-combined filters (`actor_email`, `action`, `entity_type`, `entity_id`, `date_from`, `date_to`). Default window is the last 7 days when neither date is supplied. Extend `repos/AuditRepo.gs` with a read-side `AuditRepo_getAll()`.
- [x] Implement `api/ApiManager.gs#ApiManager_dashboard(token)` — single aggregating rpc returning pending counts, last-10 audit activity, per-scope utilization (reusing `Rosters_buildSummary_`), over-cap snapshot from `Config.last_over_caps_json`, and last-operations timestamps (import / expiry / triggers-install).
- [x] Implement `ui/manager/Dashboard.html` — five cards (Pending, Recent Activity, Utilization, Warnings, Last Operations), deep-linking into Queue / Audit Log / AllSeats / Import. Replaces `mgr/seats` as the manager's default landing.
- [x] Implement `ui/manager/AuditLog.html` — filter panel (with QUERY_PARAMS deep-link support), Next / Prev pagination, per-row collapsed summary + `<details>` diff. Complete_request rows surface `completion_note` inline (Q-7.1 resolution).
- [x] Router + Nav — `Router_defaultPageFor_` returns `'mgr/dashboard'` for managers; `ROUTER_PAGES_` entries for `mgr/dashboard` / `mgr/audit` point at the real templates; `Nav.html` unhides both links.
- [x] `services/Expiry.gs` writes `Config.last_expiry_at` + `last_expiry_summary` at the end of every run (Q-8.1 resolution). `SETUP_CONFIG_SEED_` seeds both keys empty.
- [x] Rename `CONFIG_IMPORTER_KEYS_` → `CONFIG_SYSTEM_KEYS_` in `ConfigRepo`; the manager Config UI renders the read-only keys under a `system-managed` badge (old `importer-owned` badge replaced). `Config_isImporterKey` kept as a backward-compat alias.
- [x] Shared `ui/Styles.html` polish — responsive grid / table overflow / filter stacking at 375px viewport; Dashboard + Audit Log card / filter / diff / pagination styles. Bare "Loading…" placeholders across every list-bearing page promoted to `.empty-state` containers for consistent rendering.

**Acceptance criteria**

- Audit filter combinations work (e.g., "all Importer rows in the last 30 days"); deep-linkable via URL params; pagination Next / Prev update the "Showing 1–N of M" counter; defaulted last-7-days window surfaces in the counter hint.
- Dashboard renders correctly with zero data, with one ward, and with all wards; all five cards show an empty state when their data is empty (pending queue empty, no recent activity, no wards configured, no warnings, never-run operations).
- Dashboard Warnings card matches the Import page banner (same `Config.last_over_caps_json` snapshot).
- Dashboard utilization bar colour-codes: blue < 90 %, amber 90–100 %, red > 100 %.
- Manager default landing is `mgr/dashboard` (not `mgr/seats`); post-bootstrap redirect lands on Dashboard.
- Nav shows Dashboard + Audit Log links; both highlight when active.
- Layout usable on a 375px viewport — no horizontal page scroll; tables scroll within their container; filter rows stack.
- `last_expiry_at` / `last_expiry_summary` populate after a manual expiry run; Dashboard "Last Operations" card shows both.

**Out of scope**

- Export to CSV (not in spec).
- Cursor-based pagination for the Audit Log page (offset/limit is the v1 simplification; the N+1-read cost is noted in `ApiManager_auditLog` as a future refactor).

---

## Chunk 10.5 — Caching pass `[DONE — see docs/changelog/chunk-10.5-caching.md]`

**Goal:** reduce page latency by ~40-60 % on typical pages by wrapping the hot read paths in `CacheService` with explicit invalidation at every write site. No architectural change, no behaviour change visible to users. Drop-in performance lift.

**Dependencies:** Chunk 10 (Dashboard is the read-heaviest endpoint and the one whose p50 the operator will feel most; without Chunk 10 the measurable target doesn't exist yet).

**Scope note.** This is the FIRST chunk to use `CacheService` in the Main project. Chunk 1's original plan had a JWKS cache as precedent, but the A-8 auth pivot deleted the JWKS path (see `open-questions.md` A-8 / `chunk-1-scaffolding.md` deviation list). 10.5's `core/Cache.gs` is therefore new, not a generalisation of existing code — but the shape (per-script cache, JSON serialization, short TTLs, hit/miss logging via `Logger.log`) mirrors what that deleted JWKS cache used, so "same pattern" is still accurate in intent.

**Sub-tasks**

- [x] Implement `core/Cache.gs`:
  - `Cache_memoize(key, ttlSeconds, computeFn)` — standard get-or-compute over `CacheService.getScriptCache()`, with JSON serialization of the computed value.
  - `Cache_invalidate(keyOrKeys)` — removes one or many keys (accepts either a string or an array).
  - `Cache_invalidateAll()` — nuclear option for config / roster changes that affect many keys at once; used sparingly (e.g. a ward rename from `ApiManager_wardsUpsert`).
  - Size-limit handling: `CacheService.put` rejects values > 100 KB; on over-size, log a `[Cache] size-limit skipped <key> (<n>KB)` line and fall through to the un-cached compute. Never throw — cache misses must not break reads.
  - Internal hit/miss counters held in a module-level var (reset on each script invocation, which is fine — counters are per-request so the Config page can surface "we hit the cache N times this request" for debug). Exposed via `Cache_stats()`.
- [x] Wrap the hot read paths. The list below is illustrative, not authoritative — the implementer discovers what's actually hot during the measurement pass and adjusts. At minimum:
  - `Config_get(key)` — per-key memoization, **60 s TTL**.
  - `KindooManagers_getActive()` — 60 s TTL.
  - `Access_getAll()` — 60 s TTL.
  - `Wards_getAll()` — 300 s TTL (rarely changes).
  - `Buildings_getAll()` — 300 s TTL.
  - `WardCallingTemplate_getAll()` / `StakeCallingTemplate_getAll()` — 300 s TTL.
- [x] Colocate invalidation at every write site:
  - Every repo `_insert` / `_update` / `_delete` invalidates its tab's cache keys before returning to the caller (so the API layer's audit row still sees fresh data on subsequent reads inside the same request).
  - `Importer_runImport` invalidates `Seats` + `Access` keys at end of run, after the lock releases (so the over-cap pass reads fresh).
  - `Expiry_runExpiry` invalidates `Seats` keys at end of run.
  - `Config_update` invalidates the specific Config key it just wrote.
- [x] Cache stats debug view on the manager Configuration page — small read-only panel showing per-key hit / miss counts (or aggregate if per-key is too noisy). New `ApiManager_cacheStats` endpoint.
- [x] **Role-resolution caching decision** — do NOT cache role resolution per-user. Chunk 10.5's caches are per-script (`getScriptCache()`), and Alice's role set is not Bob's. Caching the reads that role resolution DOES (`KindooManagers_getActive` + `Access_getAll`) makes role resolution itself cheap without introducing per-user cache scope. If a per-user cache is later needed (e.g. a specific hot-path rpc justifies `getUserCache()`), introduce it one call site at a time, never as a blanket default.
- [x] Implement `Sheet_getTab(name)` per-request memo (architecture.md §7 already describes one; Chunk 1 didn't land it). Lives in `core/Cache.gs` (or a sibling `core/Sheet.gs` — implementer's call) and is distinct from `CacheService` — it's a request-lifetime module var that caches the `SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)` handle. Repos adopted one-by-one; the architecture already assumes it exists, so adoption is a refactor, not a new concept.
- [x] Measure before / after on three representative pages (Dashboard, bishopric Roster, manager AllSeats). Record timings in the chunk-10.5 changelog. Use `elapsed_ms` instrumentation where it already exists (`ApiManager_dashboard` logs it; add it to the other two endpoints for this chunk).
- [x] Audit every write path for missing invalidation calls. Add a short "Invalidation sites" block to the chunk-10.5 changelog listing every repo / service write site and the cache key it invalidates — makes it one review pass to confirm completeness.

**Acceptance criteria**

- `core/Cache.gs` exists and is the single call site for `CacheService` in non-Auth code. (Auth.gs currently doesn't use CacheService, so "JWKS stays in Auth.gs" from the pre-chunk plan collapses to "don't replicate Cache.gs logic elsewhere".)
- At minimum the six repo read paths listed above are memoized.
- Every `_insert` / `_update` / `_delete` path has an invalidation call, verified by code review (and enumerated in the changelog's invalidation-sites block).
- The Dashboard page's measured time-to-interactive drops by at least 30 % vs. the Chunk 10 baseline. Record before / after numbers in the changelog.
- `bishopric/roster` and `mgr/seats` show comparable improvements.
- Manager Configuration page shows a cache stats panel with hit / miss counts.
- No behaviour regressions — the full end-to-end walkthrough (sign-in → roster read → request submit → manager queue → complete → manager seat edit → manager import → audit log filter) passes.
- All existing runnable verifications still pass (`Utils_test_*`, the Chunk-2-era `ApiManager_test_forbidden`, etc.).

**Non-obvious concerns to watch during implementation**

- **Cache invalidation is the main risk.** A missed invalidation means stale data for up to the TTL (worst case 5 minutes for ward / building / template reads). Mitigation: keep the write sites narrow (repos + importer + expiry + config update only), and enumerate every invalidation site in the changelog so the review pass is a literal checklist.
- **The Sheet remains the source of truth.** `CacheService` outages or evictions fall through to the real read. Nothing that blocks a fresh page load should live ONLY in the cache.
- **Per-request memo ≠ CacheService.** The `Sheet_getTab` memo is a request-lifetime JS var; `CacheService` is cross-request. Don't confuse the two — each request builds its own sheet-handle memo, but `KindooManagers_getActive`'s memoization survives for 60 s across requests.
- **Role-resolution stays un-cached.** Per-script-cache of "email → roles" would leak Alice's roles to Bob under the same script instance. Per-user-cache would work but is more moving parts. 10.5's scope explicitly avoids that — the underlying reads being cached is enough.
- **Payloads above 100 KB skip the cache.** The full `AuditLog` read (Chunk 10's `AuditRepo_getAll`) can exceed this at year+1 scale — good; it shouldn't be cached anyway (it's already the ONE paginated read in the app; memoizing it fights the pagination contract). Confirm the log + skip behaviour for this path specifically.

**Out of scope**

- Materialized roll-ups / a `DashboardCache` tab (that was an alternative design; rejected in favour of `CacheService`).
- Client-side caching (sessionStorage / IndexedDB) — Chunk 10.6 handles navigation-level optimizations.
- Per-user cache scope unless a specific endpoint clearly needs it.
- Refactoring the Importer / Expiry diff logic — they already batch; caching at the read boundary is orthogonal.

---

## Chunk 10.6 — Client-side navigation (persistent shell) `[DONE — see docs/changelog/chunk-10.6-client-nav.md]`

**Goal:** eliminate the 1-2 second full-page reload on every intra-app navigation. `Layout` + `Nav` + topbar persist across navigations; only the main content area swaps, fetched via `rpc` rather than a fresh `Main.doGet`. Dramatic UX improvement for users clicking between pages.

**Dependencies:** Chunk 10.5 (benefits from cached reads underneath, though doesn't hard-require them — see "Interaction with 10.5" below).

**Sub-tasks**

- [x] Intercept nav link clicks on the client side — delegated `document` click handler on `a[data-page]` anchors serves from a client-side `pageBundle` map instead of letting the browser navigate the top frame. No rpc per click.
- [x] Add `core/Router.gs#Router_buildPageBundle(principal)` — renders every role-allowed page's HTML into `{pageId → pageHtml}`; role-gated at bundle-build time as a defense-in-depth layer.
- [x] Extend `api/ApiShared.gs#ApiShared_bootstrap` to return the bundle in the initial response. (No `ApiShared_renderPage` endpoint — bundling the HTML at bootstrap makes it dead code.)
- [x] **History API integration** — `pushState` on each intra-app navigation so browser back / forward work and the iframe's URL reflects the current page. Top-frame URL does NOT change (architecture.md §8.5 "History API boundaries").
- [x] Query-param forwarding — filter state (ward, type, etc.) survives navigation. Init fn receives `queryParams` as a second arg; shell also updates `window.QUERY_PARAMS` each swap so un-migrated pages keep working.
- [x] Deep-link resilience — direct-load of any page continues to work via `Main.doGet` unchanged; the target page renders from `pageHtml`, and subsequent in-app nav serves from the bundle.
- [x] No loading indicator on swap — swaps are single-digit-millisecond (synchronous client-side lookup). The init fn's own data rpc still shows a `"Loading …"` placeholder in the content area.
- [x] **Per-page init function convention** — every page template exports `window.page_<pageId>_init(pageModel, queryParams)` on `window` (pageId `/` and `-` → `_`, prefix `page_`, suffix `_init`). Shell calls it after `rehydrateScripts`. Optional `window.page_<pageId>_teardown` runs before the next swap.
- [x] Memory-leak audit — only `NewRequest` has a cancelable resource (duplicate-check debounce) and gets a teardown. Every other page's listeners live on elements inside `#content` and are garbage-collected with the DOM on swap.
- [x] Multi-role users context-switch — `Nav.html` rendered once per principal at initial bootstrap and cached across navigations; the bundle is likewise stale on mid-session role changes, which require a reload (accepted per architecture.md §8.5 "Nav staleness — accepted").

**Acceptance criteria**

- Clicking a nav link swaps the content area without a full page reload AND without any rpc for the HTML swap itself — verifiable via Network tab (no `Main.doGet`, no `ApiShared_renderPage`, just the page's own data rpc that shows the `"Loading …"` placeholder).
- Browser back / forward buttons work for intra-app navigation.
- Direct-load deep links (copying a URL from the address bar and opening a new tab) still work via the `Main.doGet` flow.
- Filter-state deep links (e.g. `?p=mgr/seats&ward=CO`) work via BOTH direct-load and in-app navigation.
- No memory leaks across 20+ navigations (manual test: navigate rapidly between pages, check DOM size + listener count stay stable via DevTools Memory profile).
- Intra-app navigation time-to-interactive is limited by the page's own data rpc; no per-click `google.script.run` round-trip for the HTML.
- Every Chunk 1-10 acceptance criterion still passes (full walkthrough).
- Nav highlights the current page correctly after each swap (Chunk 5's "active" behaviour preserved).

**Non-obvious concerns to watch during implementation**

- **Iframe nesting.** The app renders inside an iframe on `n-<hash>-script.googleusercontent.com`; the top frame is on `script.google.com`. History API manipulations happen inside the iframe — the top frame's URL does not change. This is acceptable: deep-linkable sharing continues to use the top-frame URL (unchanged from Chunk 5), and in-app navigation relies on the iframe's own history stack. Document the boundary clearly in the architecture section.
- **Script loading and re-execution.** The shared `ui/ClientUtils.html` helpers (`rpc`, `toast`, `escapeHtml`, `rosterRowHtml`, `renderUtilizationBar`) already load once at `Layout` and persist across swaps — keep them there. The per-page init-fn convention means page JS runs once per swap, not once per initial parse; the pattern is: `<script>function mgr_seats_init(model) { … }</script>` in each page template, shell calls the fn after injecting HTML.
- **Exported-init-function pattern over eval.** The alternative is `new Function(scriptText)` / eval — more flexible but harder to reason about and worse for stack traces. Go with named init fns; it's cleaner and testable.
- **Memory leaks.** Event delegation on stable parents is the default pattern (no teardown needed). Where a page can't delegate (e.g. a dialog attaches to `document`), the init returns a teardown fn and the shell calls it before the next swap.
- **Filter-state URL rewrite.** Chunk 5's out-of-scope list included "URL reflects post-load filter changes on AllSeats" — the iframe couldn't manipulate the top-frame URL. 10.6 unlocks this for intra-app nav (pushState in the iframe), but the top-frame URL bar still doesn't change; only direct-load deep links and an intentional navigation show in the address bar.
- **Back-button filter preservation.** A user who filters the Audit Log, navigates to Dashboard, then hits Back, expects the filter to restore. The History API's popstate gives us that for free if pushState URLs carry the filter params. Standard pattern.

**Interaction with 10.5**

10.6 benefits from the cached reads but doesn't require them. If 10.5 isn't shipped, 10.6 still works — just without the read-path speedup. Always build 10.5 first regardless: a cache-backed read + nav-swap overlap in the latency budget, and baselining 10.6 against un-cached reads gives misleadingly flattering numbers.

**Out of scope**

- Prefetch on hover / predictive loading.
- Service Worker / offline capability.
- Route-level code splitting — all pages are small.
- Animated page transitions.
- Top-frame URL rewrite during in-app nav (architecturally impossible across the googleusercontent ↔ script.google boundary).
- Any server-side change beyond `Router_buildPageBundle` + the `pageBundle` field on the bootstrap response.

---

## Chunk 11 — Cloudflare Worker + custom domain

**Goal:** `https://kindoo.csnorth.org` serves the app.

**Dependencies:** a stable deploy from Chunk 10 (the Chunk 10.5 / 10.6 performance work is independent of Chunk 11 and can ship before OR after; ordering was "10.5, 10.6, then 11" because the performance gap was felt before the custom-domain need).

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
