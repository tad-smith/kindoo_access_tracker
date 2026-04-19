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

## Chunk 1 — Scaffolding

**Goal:** deploy an empty-but-real web app that demonstrates the full auth handshake — unauthenticated users get a login, signed-in users see their resolved roles or a clean "not authorized" page. Same shape as a pre-GSI "hello, you are role X" chunk, with the GSI handshake in front.

**Dependencies:** none.

**Proof-driven scope.** Chunk 1 exists to demonstrate six specific things. Everything in this chunk maps to one of them; anything that doesn't is explicitly deferred below.

**The 6 proofs (acceptance criteria)**

1. **Login page loads and renders the GSI button.** Visiting `/exec` while signed out shows `ui/Login.html` with the GSI widget populated from `Config.gsi_client_id`. No blank pages, no server errors.
2. **GSI returns a JWT; the client hands it to the server.** Clicking the button (or accepting One Tap) gives the client a signed ID token, which lands in `sessionStorage.jwt` and is sent to the server via `rpc('bootstrap', ...)`.
3. **Server verifies the JWT against JWKS and extracts email.** `Auth.verifyIdToken` fetches+caches Google's JWKS, validates signature/`iss`/`aud`/`exp`/`email_verified`, and returns a canonical email. Tampered signature, wrong `aud`, and expired `exp` each cleanly reject. JWKS is fetched at most once per ~6 h across all calls (verified via CacheService contents + execution logs).
4. **Role resolver resolves that email against the Sheet.** `Auth.resolveRoles` reads `KindooManagers` (active=true) and `Access` and returns the union of roles for the verified email. Canonical-email matching (D4) lets `alice.smith@gmail.com` in the sheet match `alicesmith@gmail.com` from the JWT claim.
5. **Hello page renders with email + roles.** A Chunk-1-only `ui/Hello.html` template shows "Hello, [name] ([email]) — you are role X (wardId Y)" for every role the user holds. No real roster / request UI yet.
6. **Failure modes land correctly.** No JWT → login page. JWT OK but the email has no role → `NotAuthorized.html`. Stale/invalid JWT → client clears `sessionStorage.jwt` and re-shows login.

**Sub-tasks, grouped by which proof they support**

_Infrastructure (serves all six proofs)_

- [ ] Create the backing Google Sheet and bind an Apps Script project (see `docs/sheet-setup.md`).
- [ ] `clasp clone <scriptId>` into `src/`.
- [ ] Write `appsscript.json` with the scopes and web-app config from `architecture.md` (`access: ANYONE_WITH_GOOGLE_ACCOUNT`).
- [ ] Implement `services/Setup.gs#setupSheet()` — creates all 10 tabs with headers, idempotent. (Creates future tabs too so the data model is stable from chunk 1, even though only `Config` / `KindooManagers` / `Access` are read this chunk.)
- [ ] Run `setupSheet()` once; verify all 10 tabs/headers.
- [ ] Deploy as a web app and note the `/exec` URL.

_Proof 1 — login page loads_

- [ ] Create an OAuth 2.0 Client ID in Google Cloud Console (Authorized JS origins: `https://script.google.com` and the current Apps Script user-content host). Publish the consent screen.
- [ ] Seed `Config.bootstrap_admin_email` and `Config.gsi_client_id` by hand in the Sheet; leave `setup_complete=FALSE`.
- [ ] Implement `ui/Layout.html` — shell that injects `gsi_client_id`, pulls in `Styles` and `ClientUtils`.
- [ ] Implement `ui/Login.html` — GSI button markup (`<script src="https://accounts.google.com/gsi/client">`), `data-client_id` populated from the server-side template.
- [ ] Implement `core/Main.gs#doGet(e)` — renders `Layout.html`. No server-side auth decisions here; the client drives the handshake.

_Proof 2 — JWT travels client → server_

- [ ] Implement `ui/ClientUtils.html#rpc(name, args)` — promise wrapper over `google.script.run`; auto-injects `sessionStorage.jwt` as the first argument. On `AuthExpired` / `AuthInvalid` response, clear `sessionStorage.jwt` and switch to login view.
- [ ] Wire `ui/Login.html`'s GSI callback: stash `credential` (the ID token) into `sessionStorage.jwt`, call `rpc('bootstrap', { requestedPage })`, render the returned page.

_Proof 3 — server verifies JWT_

- [ ] Implement `core/Utils.gs` with `normaliseEmail` (D4 canonicalisation), `hashRow`, `nowTs`, `todayIso`, plus base64url decode and RSA-SHA256 signature verify helpers. Unit-test `normaliseEmail` with at least: `Alice.Smith@Gmail.com`, `alicesmith+church@googlemail.com`, `alice@csnorth.org` (dots retained), `  Bob@Foo.COM  ` (trim + lowercase only).
- [ ] Implement `repos/ConfigRepo.gs` — read-only accessors for `gsi_client_id`, `bootstrap_admin_email`, `setup_complete` (no writes in this chunk).
- [ ] Implement `core/Auth.gs#verifyIdToken(jwt)` — fetches Google JWKS, caches in `CacheService` keyed `gsi_jwks` with 6 h TTL; validates signature, `iss ∈ {"accounts.google.com", "https://accounts.google.com"}`, `aud === Config.gsi_client_id`, `exp > now`, `email_verified === true`; returns `{ email: normaliseEmail(claims.email), name, picture }` or throws `AuthInvalid` / `AuthExpired`.

_Proof 4 — role resolver_

- [ ] Implement `repos/KindooManagersRepo.gs`, `repos/AccessRepo.gs` — read-only `getAll` / `getByEmail` (no writes in this chunk).
- [ ] Implement `core/Auth.gs#resolveRoles(email)` — returns `{ email, roles: [{type, wardId?}, ...] }` using the three read repos. Matching is on canonical email.
- [ ] Implement `core/Auth.gs#principalFrom(jwt)` — `verifyIdToken` → `resolveRoles` composition.
- [ ] Implement `core/Auth.gs#requireRole(principal, matcher)` and `requireWardScope(principal, wardId)` so Chunk 2+ has them ready.

_Proof 5 — hello page_

- [ ] Implement `core/Router.gs#pick(requestedPage, principal)` — for Chunk 1 this always returns the hello template regardless of `requestedPage`.
- [ ] Implement `api/ApiShared.gs#bootstrap(jwt, requestedPage)` — `principalFrom(jwt)` → `Router.pick` → return `{ principal, pageModel, pageHtml }`.
- [ ] Implement `ui/Hello.html` — temporary Chunk-1-only template that renders "Hello, [name] ([email]) — you are role X (wardId Y)" for every role held. **This file is deleted in Chunk 5** when real rosters land; do not reuse it.

_Proof 6 — failure modes_

- [ ] Implement `ui/NotAuthorized.html` — shown when `principal.roles.length === 0`; mentions the bishopric-import-lag possibility.
- [ ] Exercise the client's `AuthExpired` / `AuthInvalid` branch by hand-invalidating `sessionStorage.jwt`.

**Explicitly deferred to later chunks** (listed here so scope creep doesn't pull them in)

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

## Chunk 2 — Config CRUD

**Goal:** Kindoo Managers can edit all configuration tabs from the app.

**Dependencies:** Chunk 1.

**Sub-tasks**

- [ ] Implement `core/Lock.gs#withLock(fn, opts)` — `LockService.getScriptLock()`, 10 s default tryLock timeout, throws a user-friendly error on contention. (Deferred from Chunk 1; this is the first chunk with writes.)
- [ ] Implement `repos/AuditRepo.gs#write({ actor_email, action, entity_type, entity_id, before, after })` — append-only; callers pass `actor_email` explicitly (per the "two identities" note in architecture.md §5).
- [ ] Extend each config repo with `insert`, `update`, `delete`, all called inside `Lock_withLock`, each emitting an `AuditLog` row inside the same lock acquisition.
- [ ] Implement `repos/WardsRepo.gs`, `repos/BuildingsRepo.gs`, `repos/TemplatesRepo.gs` (full CRUD).
- [ ] Implement `api/ApiManager.gs` endpoints: `config_list`, `config_update`, `wards_list`, `wards_upsert`, `wards_delete`, `buildings_*`, `kindooManagers_*`, `wardTemplate_*`, `stakeTemplate_*`. Each calls `Auth.requireRole(principal, 'manager')` first.
- [ ] Implement `ui/manager/Config.html` — tabbed editor, one tab per editable table. Simple HTML tables with inline forms. Re-uses `rpc` from Chunk 1's `ui/ClientUtils.html`.
- [ ] Manual test: add a ward, toggle a manager inactive, add a template row, edit a Config key.

**Acceptance criteria**

- Manager can add/edit/delete every configurable row from the UI.
- Non-manager users cannot hit the manager API endpoints (403-equivalent error surfaced as a toast).
- Every edit produces one `AuditLog` row with before/after JSON.
- No writes happen without acquiring the script lock (verified by reading the code).

**Out of scope**

- `Access` edits (Chunk 3 — the importer owns that tab).
- `Seats` inline edit on the manager All Seats page (Chunk 5/6).

---

## Chunk 3 — Importer

**Goal:** Kindoo Manager can click "Import Now" and have auto-seats + Access rows reflect the current callings spreadsheet.

**Dependencies:** Chunk 2 (needs Wards + templates).

**Sub-tasks**

- [ ] Implement `services/Importer.gs#runImport({ triggeredBy })`:
  - Open the callings sheet via `SpreadsheetApp.openById(Config.callings_sheet_id)`.
  - Loop tabs; match tab names against `Wards.ward_code` or `"Stake"`.
  - For each matched tab: parse rows, strip prefix, collect `(calling, email)` pairs from `Personal Email` + right-hand-side columns.
  - Filter pairs to those matching the appropriate template.
  - Compute `source_row_hash` for each.
  - Diff against existing auto-seats for that scope; insert new, delete missing.
  - Diff against existing `Access` rows (where template row has `give_app_access=true`); upsert new, delete missing.
  - Write `import_start` / `import_end` brackets around the per-row AuditLog entries, all inside one lock acquisition.
  - Update `Config.last_import_at` and `Config.last_import_summary`.
- [ ] Implement `api/ApiManager.gs#runImport()`.
- [ ] Implement `ui/manager/Import.html` — "Import Now" button, shows spinner, then shows last import time and summary.
- [ ] Implement `ui/manager/Access.html` — read-only table of `Access` rows.
- [ ] Test with a snapshot of the real callings spreadsheet — confirm expected inserts/deletes.

**Acceptance criteria**

- Given a prepared callings sheet, clicking "Import Now" populates `Seats` (auto rows) and `Access` correctly the first time.
- Running it again with no changes produces zero inserts and zero deletes (idempotent).
- Changing a person in the callings sheet and re-running produces exactly one delete + one insert for the affected row.
- Removing a calling from the template deletes the corresponding auto-seats on the next run.
- Every change produces a per-row `AuditLog` entry with actor `"Importer"`.
- Every email written to `Seats`, `Access`, and `AuditLog` is in the canonical form per D4 (Gmail dot/`+suffix` stripping verified against real callings-sheet examples).

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
  - Step 3: at least one Ward (with `ward_code`, `building_id`, `seat_cap`).
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
- [ ] Manager inline edit of `Seats` on All Seats page (reason, building_ids, person_name, dates on temp).

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
