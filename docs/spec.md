# Kindoo Access Tracker — Specification

> **Live source of truth.** This doc always describes the system as it is right now. Code and spec change together, in the same commit — if you want to know what the deployed app does, this is the file. Per-chunk history and deviation rationale live in [`docs/changelog/`](changelog/); read the latest chunk file plus this doc to be caught up. Ambiguities and watch-outs are tracked in [`open-questions.md`](open-questions.md).

## 1. Context

The Church of Jesus Christ of Latter-day Saints organizes members into **stakes**, each containing multiple **wards** (individual congregations). This app is built for a single stake.

**Kindoo** is a door-access system licensed per seat. The stake receives a global pool of seats and allocates them across its wards and its own stake-level pool.

There are three seat types:

| Type | How it's assigned | Lifecycle |
| --- | --- | --- |
| **Automatic** | Tied to callings (church roles) assigned in LCR (the church's membership system). | Managed via a weekly import from an existing callings spreadsheet. |
| **Manual** | Assigned to an individual. | Held until explicitly removed. |
| **Temporary** | Assigned with a start and end date. | Auto-expires on the end date. |

Bishoprics (Bishop + two counselors; one bishopric per ward) submit requests for manual/temp seats in their ward. The Stake Presidency does the same against the stake pool. One or more **Kindoo Managers** process those requests by manually mirroring changes into Kindoo (which has no API), then marking the requests complete.

## 2. Stack

- **Backend + UI**: Google Apps Script (`HtmlService` + `google.script.run`).
- **Database**: Google Sheet in the stake's Workspace (shared drive, owned by the Workspace). The Main Apps Script project is container-bound to that Sheet and inherits its Workspace ownership.
- **Auth**: a **two-project Session+HMAC pattern**. There are two distinct Apps Script projects: the Workspace-bound **Main** (this repo's `src/`, `executeAs: USER_DEPLOYING`, renders all UI and reads/writes the backing Sheet) and a personal-account-owned standalone **Identity** (this repo's `identity-project/`, `executeAs: USER_ACCESSING`, exists only to read `Session.getActiveUser().getEmail()` and HMAC-sign it). The Login button on Main navigates the top frame to Identity's URL; Identity reads the user's email, signs `{email, exp, nonce}` with `session_secret` (HMAC-SHA256), and renders a tiny redirect page that navigates the top back to Main with `?token=…`. Main's `doGet` verifies the HMAC, drops the token into `sessionStorage`, cleans the URL, and proceeds; every subsequent `google.script.run` call passes the same token, which the server re-verifies on each call. The verified `email` is resolved against the `KindooManagers` and `Access` tabs (canonical-on-the-fly comparison via `Utils_emailsEqual`: lowercase + Gmail dot/`+suffix` stripping + `googlemail.com` → `gmail.com`; addresses are stored as typed). The shared `session_secret` lives in two manually-synchronized places: Main's Sheet `Config.session_secret` cell and Identity's project Script Properties — see `identity-project/README.md` for the rotation procedure. **No Google OAuth client (GCP-managed) is involved** — neither Google Identity Services' drop-in button nor the OAuth implicit nor code flow can be used inside Apps Script HtmlService, because the iframe origin (`*.googleusercontent.com`) is on Google's permanent OAuth-origin denylist. `Session.getActiveUser` under `USER_ACCESSING` works for consumer Gmail when the script lives in a personal-account Cloud project — Workspace-owned scripts gate consumer-Gmail authorization at a tenant level the deployment dialog can't override, which is why Identity is split into a separate personal-account project while Main stays Workspace-bound. Users sign in with consumer Gmail accounts; both projects' `webapp.access` is `ANYONE` in the manifest (shown as "Anyone with Google account" in the deploy dialog). First-time per-user OAuth consent on the Identity project for the email scope only.
- **Email**: `MailApp.sendEmail()`.
- **Scheduling**: time-based triggers (daily expiry; weekly import).
- **Domain**: `kindoo.csnorth.org` → Cloudflare Worker → Apps Script `/exec` URL.
- **Dev**: `clasp` for local editing and CLI deploys.

## 3. Data model — Sheet tabs

### 3.1 Config tabs (Kindoo Manager edits via UI; Sheet is source of truth)

**`Config`** — key/value pairs.

- Columns: `key`, `value`.
- Holds: stake name, callings-sheet ID, stake seat cap, bootstrap admin email, etc.

**`KindooManagers`**

- Columns: `email`, `name`, `active`.

**`Buildings`**

- Columns: `building_name`, `address`. (`building_name` is the PK; cross-tab references use it directly — no slug column.)

**`Wards`**

- Columns: `ward_code` (2-letter PK; matches the tab name in the callings sheet), `ward_name`, `building_name` (FK), `seat_cap`. `ward_code` is also the value used in `Seats.scope` / `Access.scope` / `Requests.scope`.

**`WardCallingTemplate`**

- Columns: `calling_name`, `give_app_access`.
- Lists callings that trigger auto Kindoo seats in **every** ward.
- `give_app_access=true` means people in this calling can sign into the app (populated into the `Access` tab by the importer).

**`StakeCallingTemplate`**

- Same columns as above; applies to the Stake tab of the callings sheet.

**`Access`** — populated by the importer; visible only to Kindoo Managers.

- Columns: `email`, `scope` (`ward_code` or `"stake"`), `calling`.
- Maintained automatically from callings whose template row has `give_app_access=true`. Not manually edited.

### 3.2 Operational tabs

**`Seats`** — live roster (current state only; no active flag — rows are inserted and deleted).

- Columns:
  - `seat_id`
  - `scope` (`ward_code` or `"stake"`)
  - `type` (`auto` / `manual` / `temp`)
  - `person_email`, `person_name`
  - `calling_name` (auto only), `source_row_hash` (auto only)
  - `reason`
  - `start_date`, `end_date` (temp only)
  - `building_names` (comma-separated; defaults to ward's `building_name`)
  - `created_by`, `created_at`, `last_modified_by`, `last_modified_at`

**`Requests`**

- Columns:
  - `request_id`
  - `type` (`add_manual` / `add_temp` / `remove`)
  - `scope`
  - `target_email`, `target_name`
  - `reason`, `comment`
  - `start_date`, `end_date` (temp only)
  - `status` (`pending` / `complete` / `rejected` / `cancelled`)
  - `requester_email`, `requested_at`
  - `completer_email`, `completed_at`
  - `rejection_reason`

**`AuditLog`**

- Columns: `timestamp`, `actor_email`, `action`, `entity_type`, `entity_id`, `before_json`, `after_json`.
- One row per change, including per-row import changes.
- Automated actors use literal strings: `"Importer"` for the weekly import, `"ExpiryTrigger"` for the daily temp-expiry job.

## 4. Role resolution

On each page load, look up the signed-in email:

- In `KindooManagers` (active=true) → **Kindoo Manager**.
- In `Access` with `scope=stake` → **Stake Presidency**.
- In `Access` with `scope=<ward_code>` → **Bishopric** for that ward.
- None of the above → show "not authorized".

A user can hold multiple roles; the UI shows the union.

## 5. Page map

### 5.1 Bishopric (scoped to own ward)

- **Roster** — active ward seats. All rows show calling + person (auto rows included). Manual/temp rows show reason; temp rows show dates. Each manual/temp row has an X/trashcan; clicking opens "Remove access for [person]?" with a required reason field and submits a `remove` Request via the shared `ApiRequests_submit` endpoint. Once submitted, the row's X is replaced by a "removal pending" badge so the requester can't double-submit (server-side `RequestsService_submit` reinforces the rule by refusing a duplicate pending remove for the same `(scope, person_email)` pair). Auto rows render no X — auto seats track LCR callings and are removed by the next import after the calling change in LCR. Utilization bar: "14 of 20 seats used."
- **New Kindoo Request** — shared template `ui/NewRequest` (same page for bishopric and stake principals; scope is derived from the principal's roles, not the route). Form: add_manual / add_temp. Fields: target email (required), target name, reason (required), comment (multi-building notes etc.), dates (if temp). Client-side duplicate check via `ApiRequests_checkDuplicate` warns when the target already has a seat in the selected scope (inline render via the shared `rosterRowHtml` helper). Warns; does not block. Principals holding more than one request-capable role (bishopric+stake, or multiple bishoprics) see a "Requesting for:" scope dropdown at the top; single-role principals see an implicit scope label.
- **My Requests** — shared template `ui/MyRequests`. Shows the current user's submitted requests with status; Cancel button on pending rows; rejection reason surfaced on rejected rows. Multi-role principals see a scope filter dropdown (including an "All" option); single-role principals see their requests directly.

### 5.2 Stake Presidency

Same three pages as Bishopric, scoped to the stake pool — uses the same shared `ui/NewRequest` + `ui/MyRequests` templates. Plus:

- **Ward Rosters** — read-only dropdown to view any ward's roster.

### 5.3 Kindoo Manager

- **Dashboard** — manager default landing. Five cards: pending request counts grouped by type (deep-link to Requests Queue), recent activity (last 10 AuditLog rows, deep-link to Audit Log filtered by `entity_id`), utilization per scope (one bar per ward + stake, colour-coded ok / warn ≥ 90 % / over; deep-link to All Seats filtered by ward), warnings (over-cap pools from `Config.last_over_caps_json` — same shape the Import page banner uses, with a deep-link per pool), and last operations (timestamps for the last import, last expiry, and last triggers reinstall). Single `ApiManager_dashboard` rpc aggregates everything so the landing is one round-trip.
- **Requests Queue** — filter by state (Pending / Complete — the "Complete" option groups complete, rejected, and cancelled), ward, and type. Default state is Pending (the backlog to act on). Pending cards render metadata + a "seat preview" (what the Seats row will look like after Complete, rendered via the shared `rosterRowHtml`) + a duplicate-warning block when the target already has a seat in the scope, plus Mark Complete / Reject actions. Resolved cards (in the Complete view) render the same metadata plus resolver / timestamp / rejection-reason where applicable, with no action buttons. Pending is sorted oldest-first (FIFO); Complete is sorted newest-first (most-recent-at-top). **Mark Complete opens a confirmation dialog** with the request summary + a Buildings checkbox group (every Building pre-loaded; the requesting ward's default building pre-ticked — empty for stake-scope). The manager adjusts the selection if needed, clicks Confirm, and the resulting Seats row carries that `building_names` selection exactly. Self-approval policy: a manager who is also a bishopric/stake member may complete or reject requests they themselves submitted; the audit trail records who submitted and who completed so the chain of custody is clear even when they're the same person.
- **All Seats** — full roster; filter by ward/building/type. Inline edit (Edit button on manual/temp rows only — auto rows are importer-owned) of `person_name`, `reason`, `building_names`, plus `start_date` / `end_date` on temp rows. `scope`, `type`, `person_email`, and the seat UUID are immutable.
- **Configuration** — edit `Wards`, `Buildings`, `KindooManagers`, `WardCallingTemplate`, `StakeCallingTemplate`, and `Config`.
- **Access** — read-only view of the `Access` tab.
- **Import** — "Import Now" button; shows last import time and summary.
- **Audit Log** — filterable view over the `AuditLog` tab. Server-side-paginated (offset / limit, max 100 rows per page — the ONE page in the app that paginates, since the tab grows unbounded at ~300-500 rows/week; every other read stays on the no-pagination stance in `architecture.md` §1). Filters combine as AND: `actor_email` (canonical-email compare, or literal match against `"Importer"` / `"ExpiryTrigger"`), `action` (exact match from the data-model.md §10 vocabulary), `entity_type` (enum), `entity_id` (exact, case-sensitive), `date_from` / `date_to` (ISO dates, inclusive on both ends in the script timezone). Default window is the last 7 days when neither date is supplied. Deep-linkable via URL params (e.g. `?p=mgr/audit&action=over_cap_warning&date_from=2026-04-01`). Per-row rendering: a coloured action badge; a collapsed one-line summary (with `complete_request.completion_note` surfaced inline for the Chunk-7 R-1 no-op case); a `<details>` block that expands to a field-by-field diff (unchanged fields collapsed as "N unchanged") for update rows, or a one-sided insert / delete rendering.

## 6. Request lifecycle

State machine (pending is the only admissible starting state; each terminal state is a one-way flip):

```
              submit
                |
                v
             pending
              / | \
    complete /  |  \ cancel
            /   |   \
           v    v    v
      complete rejected cancelled
```

1. Requester submits → `Requests` row appended (`status=pending`) via `ApiRequests_submit` (consolidated endpoint used by bishopric + stake principals; scope validated against `Auth_requestableScopes(principal)`) → email to active Kindoo Managers.
2. Manager action (`ApiManager_completeRequest` / `ApiManager_rejectRequest`):
   - **Mark Complete** (after updating Kindoo manually): inside one `Lock_withLock`, `Requests` row flipped to `complete` AND the matching `Seats` row is inserted atomically (manual/temp per request type). Two AuditLog rows — one per entity. Email to requester.
   - **Reject**: `Requests` row updated with `rejection_reason`; email to requester.
3. Requester can **Cancel** a pending request via `ApiRequests_cancel` → email to active Kindoo Managers. Only the original requester may cancel (server-side enforcement via `Utils_emailsEqual` on `requester_email`); a manager wanting to shut a request down unilaterally should Reject with a reason.

Attempting to complete / reject / cancel a non-pending request returns a clean "Request is no longer pending (current status: X)" error, not a stack trace — the typical cause is a stale queue page (another manager processed the request between page load and click).

Remove-requests follow the same lifecycle; the `complete` action deletes the matching `Seats` row instead of inserting. Two extra rules apply only to remove:

- **R-1 race (seat already gone at completion time).** If the matching seat is missing when a manager clicks Complete (a duplicate remove already ran, or — once Chunk 8 ships — the daily expiry trigger removed a temp seat between submit and complete, or the row was edited out of the Sheet by hand), the request still flips to `complete` so the requester's ask is closed out. A `completion_note` of `"Seat already removed at completion time (no-op)."` is stamped on the Request row, only ONE AuditLog row is written (`complete_request` on the Request — there's no Seat to delete and therefore no Seat audit row), and the requester's completion email body mentions the no-op so they aren't confused that nothing visibly changed.
- **Submit-time guards.** A remove submit is rejected server-side if (a) no active manual/temp seat exists for `(scope, target_email)` (open-questions.md R-3 — auto seats are LCR-managed and not removable via this path; a stale roster page is the typical cause), or (b) another remove request for the same `(scope, target_email)` is already pending. Both surfaces also gate at the UI (the X is only rendered on manual/temp rows, and is disabled when `removal_pending` is set), but the server-side check defends against a stale roster page or a crafted rpc.

## 7. Temporary-seat expiry

Daily trigger: `Expiry_runExpiry` scans `Seats` where `type=temp AND end_date < today` (today = `Utils_todayIso()` in the script timezone set by `appsscript.json`, i.e. `America/Denver`), deletes each matching row, and writes an `AuditLog` entry per row (`action=auto_expire`, `actor_email="ExpiryTrigger"` literal, `before_json` preserving the deleted row, `after_json` empty). The entire run is wrapped in one `Lock_withLock` (30 s timeout, matching the Importer) and the per-row audits are flushed via `AuditRepo_writeMany` at end of run.

The trigger fires daily at `Config.expiry_hour` (default `3`, i.e. 03:00 local). Since the scan uses the script timezone to compute "today" and the fire time is in the same timezone, the boundary is unambiguous: a seat with `end_date=2026-04-21` is still alive on 2026-04-21 (`end_date < today` is false) and disappears on the 2026-04-22 03:00 run. No email is sent on auto-expire — the audit row is the trail. Kindoo removes on its side automatically; no action needed there.

The daily trigger is installed (and idempotently reinstalled) by `TriggersService_install()`, called from the bootstrap wizard's Complete-Setup step and from the manager Configuration page's "Reinstall triggers" button. Changing `Config.expiry_hour` does **not** reschedule the existing trigger — an operator must click "Reinstall triggers" for the new hour to take effect.

## 8. Weekly import

Runs weekly (trigger) and on-demand ("Import Now" button on the Manager's Import page). The trigger fires `Importer_runImport` at `Config.import_day` / `Config.import_hour` (default `SUNDAY` / `4`, i.e. 04:00 Sunday in the script timezone). Both keys are editable from the manager Configuration page; saving either fires a warn toast reminding the operator to click "Reinstall triggers" for the new schedule to take effect (same pattern as `expiry_hour` from Chunk 8). `import_day` is validated server-side against the seven canonical `ScriptApp.WeekDay` names (UPPERCASE, case-insensitive on input); `import_hour` is validated as an integer 0–23. Invalid values surface as clean error toasts, not stack traces. The trigger is installed (and idempotently reinstalled) alongside the daily expiry trigger by `TriggersService_install()`.

Both paths — manual Import Now and weekly trigger — run the same code, acquire the same `Lock_withLock(30 s)` for the diff-and-apply, and end with the same over-cap pass (§9 below). The import's `import_start` / `import_end` audit payloads record `triggeredBy=<manager email>` for manual runs and the literal `triggeredBy='weekly-trigger'` for trigger runs; per-row audit rows carry `actor_email='Importer'` regardless.

**Source**: Google Sheet ID stored in `Config`. One tab per ward, named to match the ward's `ward_code` (2-letter code). Plus one tab named `Stake`.

**Tab layout** (matches the LCR-exported callings sheet format):
- Col A: `Organization` (ignored).
- Col B: `Forwarding Email` (ignored).
- Col C: `Position` — not required to be column C exactly; the importer finds the column by header name anywhere in the top 5 rows (a title / instructions block may live above the real headers, which is common in LCR exports).
- Col D: the personal-email column. Header text varies by export (`Personal Email`, `Personal Email(s)`, `Personal Emails`, sometimes followed by an explanatory `Note: …` block bleeding into the same cell). The importer **requires the column-D header to contain `personal email` (case-insensitive)** as a sanity check, but does not require an exact match.
- Col E and rightward: additional email cells for multi-person callings. Header text in these columns is free-form and ignored.

**`Position` format**:
- Ward tabs: 2-letter prefix (matching the `ward_code`), a space, then the calling name. Example: `CO Bishop` in the Cordera tab. The importer strips the prefix before matching against `WardCallingTemplate.calling_name`.
- Stake tab: **no prefix**. Position holds the full calling name directly, e.g. `Stake Relief Society President`. The importer treats Position verbatim and matches against `StakeCallingTemplate.calling_name`. (Note: LCR's Stake-tab Position values already start with the word `Stake`; that's part of the calling name, not a prefix the importer strips.)

**Per tab:**

1. Find the header row (top 5 rows, contains `Position`). Read data rows below it. On ward tabs, strip the 2-letter `<CODE> ` prefix from `Position` to get the calling name; on the Stake tab, use `Position` verbatim.
2. Collect the email cell (column D) + any non-blank cells to its right.
3. For each `(calling, email)` pair where calling matches a row in the appropriate template (`WardCallingTemplate` for ward tabs, `StakeCallingTemplate` for the Stake tab). Template `calling_name` values may contain a `*` wildcard standing for "any run of characters"; see data-model.md "Wildcard patterns" for the matching rules (exact wins over wildcard, Sheet order wins among wildcards):
   - Compute `source_row_hash = hash(scope, calling, email)`.
   - If no matching auto-seat exists in `Seats`, insert a new row (`type=auto`); write `AuditLog` entry.
   - If it exists, no change.
   - If the template row has `give_app_access=true`, upsert into `Access` (`email`, `scope`, `calling`); write `AuditLog` entry on change.
4. Delete any existing auto-seat for this scope not seen in the current import; write `AuditLog` entry per row.
5. Delete any `Access` row for this scope whose `(email, calling)` pair wasn't seen; write `AuditLog` entry.

**Cap interaction**: imports always apply — LCR truth wins. After every import run (manual or weekly-trigger), the importer runs a read-only over-cap detection pass — for each ward and for the stake pool, it compares the total seats in that scope (counting every row regardless of `type`, matching Chunk 5's utilization math) against the pool's cap (`Wards.seat_cap` for a ward, `Config.stake_seat_cap` for the stake). A scope with no configured cap (or a cap ≤ 0) is skipped. If any pool is over, the importer persists a snapshot into `Config.last_over_caps_json`, writes one `over_cap_warning` AuditLog row (one row per run, not per pool), and emails active Kindoo Managers best-effort — see §9. A run with no over-caps persists an empty snapshot (`[]`) so the manager Import page's red banner clears the next time a resolved condition is imported. The over-cap detection runs AFTER the import's main lock releases, in a separate tiny lock of its own — the import lock stays scoped to the diff-and-apply work.

**Bishopric lag**: new bishopric members can't sign into the app until the next import runs. This lag is accepted for v1.

## 9. Email notifications

Four request-lifecycle notifications ship in Chunk 6 and cover every request type — `add_manual`, `add_temp`, and `remove` (Chunk 7). Body copy is type-aware (the lead verb reads "submitted a new manual-add request" vs "requested removal of"); the four templates and their triggers don't change. Chunk 9 adds a fifth notification — the over-cap warning that fires after an import run (manual or weekly-trigger) when any ward or the stake pool holds more seats than its cap. All five use `MailApp.sendEmail` from the deployer's identity (Main runs `executeAs: USER_DEPLOYING`), with a display-name of `"<stake_name> — Kindoo Access"` when `Config.stake_name` is set. Bodies are plain text; every email includes a link back to the relevant app page. The completion email for a remove request that hit the R-1 race carries a `Note:` line surfacing `Requests.completion_note` so the requester knows nothing visibly changed. The over-cap email lists every affected pool with its current count / cap and a deep-link to the filtered `mgr/seats` page so a manager can jump straight to the offender.

| Trigger | Recipients | Subject | Link back |
| --- | --- | --- | --- |
| Request submitted | active Kindoo Managers | `[Kindoo Access] New request from <requester> (<scope label>)` | `<main_url>?p=mgr/queue` |
| Request completed | original requester | `[Kindoo Access] Your request for <target_email> has been completed` | `<main_url>?p=my` |
| Request rejected | original requester | `[Kindoo Access] Your request was rejected` | `<main_url>?p=my` |
| Request cancelled | active Kindoo Managers | `[Kindoo Access] Request cancelled by <requester>` | `<main_url>?p=mgr/queue` |
| Over-cap after import | active Kindoo Managers | `[Kindoo Access] Over-cap warning after <manual\|weekly> import` | `<main_url>?p=mgr/seats` |

The manager Import page also surfaces the last-run over-cap state as a red banner above the import status panel — one line per pool with the same counts/cap/over-by shape as the email body and a "View seats →" deep-link. The banner reads from `Config.last_over_caps_json` so page reloads (and visits from a different browser) reflect the current persisted state without a re-import; a resolved over-cap clears the banner on the next run. Chunk 10's Dashboard will promote this into a persistent Warnings card.

**Best-effort, outside the lock.** Every request-lifecycle email send happens AFTER the `Lock_withLock` closure completes at the API layer. `MailApp.sendEmail` is slow (~1–2 s per call); holding the lock for mail I/O would starve concurrent writers. If a send fails, the API layer logs the error and surfaces a `warning` field on the response (the client shows it as a `toast('…', 'warn')`). The Sheet write is atomic + audited; the email is best-effort. See `architecture.md` "Email send policy" for the rationale.

**Global kill-switch.** `Config.notifications_enabled` (boolean; default `TRUE`) gates every mail path through `EmailService`. Flipping it to `FALSE` suppresses all sends (the would-be recipients are logged but no `MailApp.sendEmail` happens). Editable from the manager Configuration page so operators can disable notifications during testing, while the mailbox is being provisioned, or temporarily if a bad address in `KindooManagers` is generating bounces.

## 10. Bootstrap flow

`Config.bootstrap_admin_email` is seeded on deploy; `Config.setup_complete` starts as `FALSE`. Until it flips to `TRUE`, every page load first routes through a **setup-complete gate** in `ApiShared_bootstrap` (runs **before** role resolution):

- If the signed-in email matches `bootstrap_admin_email` (via `Utils_emailsEqual`) → render `ui/BootstrapWizard.html`, ignoring `?p=`.
- Otherwise → render `ui/SetupInProgress.html` (distinct from `NotAuthorized` — the user isn't unauthorised, the app isn't ready).

The wizard is a single multi-step page driven from the server; each step persists directly into the real tabs (`Config`, `Buildings`, `Wards`, `KindooManagers`), so closing and reopening mid-setup resumes where the data says it should.

Steps:

1. Stake name, callings-sheet ID, stake seat cap (writes to `Config`).
2. At least one Building (writes to `Buildings`).
3. At least one Ward with `ward_code`, `ward_name`, `building_name`, `seat_cap` (writes to `Wards`).
4. Additional Kindoo Managers (optional; writes to `KindooManagers`). The bootstrap admin is **auto-added** as an active `KindooManager` on first wizard load — they can't delete themselves from step 4, and won't be locked out after setup.

**Complete Setup** (enabled when steps 1-3 are complete): flips `Config.setup_complete=TRUE`, calls `TriggersService_install()` (stubbed until Chunks 8/9), writes an `AuditLog` row with `action='setup_complete'`, and redirects the admin to the main `/exec` URL (which now routes via normal role resolution — they land on the manager default page).

**One-shot wizard.** Every `ApiBootstrap_*` endpoint has its own auth gate that checks both (a) signed-in email equals `bootstrap_admin_email` via `Utils_emailsEqual`, AND (b) `setup_complete` is still `FALSE`. Once setup flips, every endpoint refuses regardless of caller. Post-setup changes go through the normal manager Configuration page.

## 11. Concurrency

All write operations wrap in `LockService.getScriptLock()` with a short timeout.

## 12. Custom domain

Cloudflare Worker on the `csnorth.org` zone: route `kindoo.csnorth.org/*` to the Apps Script `/exec` URL, rewriting paths and preserving query strings. Free Cloudflare tier.

## 13. Out of scope for v1

- Multi-tenant (other stakes).
- Kindoo API integration (they don't have one).
- Native mobile app (responsive web is enough).
- Direct LCR sync (we import from the existing callings sheet, which is already a derived source).
- Building permissions UI on bishopric requests (comment field handles exceptions).
- Manual overrides to `Access` (the importer owns it; weekly lag is accepted).

## 14. Build order (11 chunks)

Each chunk is independently reviewable and shippable. Expanded into sub-tasks, acceptance criteria, and dependencies in [`build-plan.md`](build-plan.md).

1. **Scaffolding** — `clasp` project, Sheet with all tabs and headers, `Config` keys, role-resolution module, "Hello, [email] — you are role X" page. Auth and routing only.
2. **Config CRUD** — Kindoo Manager's Configuration page. Edit Wards, Buildings, KindooManagers, templates, Config. Manual corrections tested.
3. **Importer** — read callings sheet, populate `Seats` (auto) and `Access`. Manual "Import Now" button; weekly trigger added later. Per-row `AuditLog`. Test with a real snapshot.
4. **Bootstrap wizard** — first-run setup flow gating access.
5. **Rosters** — bishopric Roster page, stake Roster + Ward Rosters pages, manager All Seats page. Read-only first.
6. **Requests v1** — New Request form (add manual, add temp), My Requests with Cancel, Manager Requests Queue with Complete / Reject. Writes to `Seats` on completion. Email notifications.
7. **Removals** — X/trashcan on Roster, "removal pending" badge, remove-type requests flowing through the same queue.
8. **Expiry trigger** — daily job, `AuditLog` entries, cap math includes active temp seats.
9. **Weekly import trigger + over-cap warnings** — schedule the import, dashboard warnings, over-cap emails.
10. **Audit Log page + polish** — filterable log view, utilization bars, dashboard stats, responsive CSS pass.
11. **Cloudflare Worker + custom domain** — last, since the Apps Script URL works fine during development.
