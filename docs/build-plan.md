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

## Chunk 4 — Bootstrap wizard

**Goal:** a fresh install can be configured end-to-end by the bootstrap admin without touching the sheet by hand.

**Dependencies:** Chunk 2 (wizard steps write to config tabs).

**Sub-tasks**

- [ ] Add gating to `core/Main.doGet`: if `Config.setup_complete=false`, only the bootstrap admin hits a wizard; others get a "setup in progress" page.
- [ ] Implement `services/Bootstrap.gs` state-machine:
  - Step 1: stake name + callings-sheet ID + stake seat cap.
  - Step 2: at least one Building.
  - Step 3: at least one Ward (with `ward_code`, `ward_name`, `building_name`, `seat_cap`).
  - Step 4: additional Kindoo Managers (optional).
  - Finish: install triggers, set `setup_complete=true`, write `setup_complete` audit row, redirect to manager dashboard.
- [ ] Implement `ui/BootstrapWizard.html`.
- [ ] Test on a fresh sheet end-to-end.

**Acceptance criteria**

- Fresh sheet + first visit as bootstrap admin → wizard appears.
- Non-admins hitting the app during bootstrap see the "setup in progress" page.
- Completing the wizard flips `setup_complete` to true and installs triggers (verified via `ScriptApp.getProjectTriggers()`).
- Re-visiting after completion lands on the normal role-based default page.

**Out of scope**

- Post-setup re-running of the wizard (not a requirement).

---

## Chunk 5 — Rosters (read-only)

**Goal:** bishoprics, stake presidency, and managers can read seat rosters.

**Dependencies:** Chunk 3 (so rosters have real data).

**Sub-tasks**

- [ ] Extend `repos/SeatsRepo.gs` with `getByScope(scope)` returning a uniform shape including human-readable fields.
- [ ] Implement `api/ApiBishopric.gs#roster()`, `api/ApiStake.gs#roster()`, `api/ApiStake.gs#wardRoster(wardId)`, `api/ApiManager.gs#allSeats(filters)`.
- [ ] Implement `ui/bishopric/Roster.html` — ward roster with utilization bar.
- [ ] Implement `ui/stake/Roster.html` — stake roster with utilization bar.
- [ ] Implement `ui/stake/WardRosters.html` — dropdown + read-only ward roster.
- [ ] Implement `ui/manager/AllSeats.html` — full roster with `ward`/`building`/`type` filters.
- [ ] Implement `ui/Nav.html` with role-aware links.

**Acceptance criteria**

- Bishopric sees only their own ward's seats.
- A bishopric member cannot retrieve another ward's roster by crafting a URL or direct `rpc` call (enforced in `Auth.requireWardScope`).
- Stake sees stake pool + can pick any ward via dropdown.
- Manager can filter by ward, building, or type.
- Utilization bar shows `active seats / seat_cap`.

**Out of scope**

- Request submission (Chunk 6), removal actions (Chunk 7), manager inline edits (Chunk 6).
- Server-side pagination. Target scale (~20 seats/ward, 250 seats total) fits a single-page render with room to spare.

---

## Chunk 6 — Requests v1 (add flows + queue)

**Goal:** the full add-manual / add-temp request lifecycle works, including email.

**Dependencies:** Chunk 5.

**Policy (confirmed):** A manager may complete or reject a request they themselves submitted. No self-approval guard is needed in the queue UI or the server-side handler.

**Sub-tasks**

- [ ] Implement `repos/RequestsRepo.gs` (full CRUD).
- [ ] Implement `services/RequestsService.gs`:
  - `submit(requesterPrincipal, draft)` — writes pending row, sends email, returns request_id.
  - `complete(managerPrincipal, requestId)` — updates status, inserts `Seats` row, sends email to requester.
  - `reject(managerPrincipal, requestId, reason)` — updates status, sends email to requester.
  - `cancel(requesterPrincipal, requestId)` — updates status, sends email to managers.
  - All wrapped in `Lock_withLock`; all emit `AuditLog` entries.
- [ ] Implement `services/EmailService.gs` with typed functions: `notifyManagersNewRequest`, `notifyRequesterCompleted`, `notifyRequesterRejected`, `notifyManagersCancelled`.
- [ ] Implement `ui/bishopric/NewRequest.html`, `ui/bishopric/MyRequests.html`, `ui/stake/NewRequest.html`, `ui/stake/MyRequests.html`, `ui/manager/RequestsQueue.html`.
- [ ] New Request client-side duplicate check (calls a `checkDuplicate(target_email, scope)` API before submit and warns).
- [ ] Manager inline edit of `Seats` on All Seats page (reason, building_names, person_name, dates on temp).

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

## Chunk 7 — Removals

**Goal:** bishoprics and stake can request removal of a manual/temp seat via the Roster X button; managers complete the request to delete the seat.

**Dependencies:** Chunk 6.

**Sub-tasks**

- [ ] Add X/trashcan control on `bishopric/Roster.html` and `stake/Roster.html` for `manual`/`temp` rows only.
- [ ] Modal: "Remove access for [person]? Reason:" → submits `type=remove` request via `RequestsService.submit`.
- [ ] "Removal pending" badge on any roster row with an outstanding `remove` request for that `(scope, person_email)`.
- [ ] `RequestsService.complete` handles `remove` type: deletes the matching `Seats` row (matched on `scope + person_email`).
- [ ] Handle edge case: seat already gone when the remove request is completed (auto-complete the request with a note; don't error).

**Acceptance criteria**

- Bishopric can request removal; badge appears immediately.
- Manager completes; `Seats` row deleted; badge gone.
- Concurrent race (two remove requests for same seat) doesn't double-delete or error.

**Out of scope**

- Removals for auto-seats (not allowed by spec — that's an LCR change).

---

## Chunk 8 — Expiry trigger

**Goal:** temp seats disappear on their `end_date`.

**Dependencies:** Chunk 6 (to have temp seats to expire).

**Sub-tasks**

- [ ] Implement `services/Expiry.gs#runExpiry()` — scans `Seats` for `type=temp AND end_date < today (local tz)`, deletes inside a lock, writes per-row `AuditLog` entries.
- [ ] Extend `services/TriggersService.gs` to install a daily time-based trigger on `Expiry_runExpiry`.
- [ ] Ensure the bootstrap wizard finishes by calling `TriggersService.install()`.
- [ ] Update all utilization math to count only currently-living rows (temp rows with `end_date >= today`).

**Acceptance criteria**

- A temp row with an end-date in the past is deleted within 24 hours of reaching that date.
- The deletion appears in `AuditLog` with `actor_email="ExpiryTrigger"` and a populated `before_json`.
- Running `runExpiry` manually twice in a row produces zero deletes on the second run.

**Out of scope**

- Notifying users when their temp seat expires (not in spec).

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
