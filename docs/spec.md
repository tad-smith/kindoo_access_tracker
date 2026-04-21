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

- **Roster** — active ward seats. All rows show calling + person (auto rows included). Manual/temp rows show reason; temp rows show dates. Each manual/temp row has an X/trashcan; clicking opens "Remove access for [person]? Reason:" and submits a `remove` Request. Row shows "removal pending" badge once submitted. Utilization bar: "14 of 20 seats used."
- **New Request** — form: add manual / add temp. Fields: target email (required), target name, reason, comment (multi-building notes etc.), dates (if temp). Duplicate warning if target has an active seat in this ward.
- **My Requests** — submitted requests with status; Cancel button on pending.

### 5.2 Stake Presidency

Same three pages as Bishopric, scoped to the stake pool. Plus:

- **Ward Rosters** — read-only dropdown to view any ward's roster.

### 5.3 Kindoo Manager

- **Dashboard** — pending request count, recent activity, per-ward utilization, over-cap warnings.
- **Requests Queue** — all pending; filter by ward/type. Actions: Mark Complete, Reject (with reason).
- **All Seats** — full roster; filter by ward/building/type. Inline edit for manual corrections.
- **Configuration** — edit `Wards`, `Buildings`, `KindooManagers`, `WardCallingTemplate`, `StakeCallingTemplate`, and `Config`.
- **Access** — read-only view of the `Access` tab.
- **Import** — "Import Now" button; shows last import time and summary.
- **Audit Log** — filterable view.

## 6. Request lifecycle

1. Requester submits → `Requests` row appended (`status=pending`) → email to active Kindoo Managers.
2. Manager action:
   - **Mark Complete** (after updating Kindoo manually): `Requests` row updated; `Seats` row inserted (adds) or deleted (removes); email to requester.
   - **Reject**: `Requests` row updated with rejection reason; email to requester.
3. Requester can **Cancel** a pending request → email to active Kindoo Managers.

## 7. Temporary-seat expiry

Daily trigger: scan `Seats` where `type=temp AND end_date < today`. Delete the row and write an `AuditLog` entry (`action=auto_expire`, `actor_email="ExpiryTrigger"`, `before_json` preserving the deleted row). Kindoo removes on its side automatically; no action needed there.

## 8. Weekly import

Runs weekly (trigger) and on-demand ("Import Now" button on the Manager's Import page).

**Source**: Google Sheet ID stored in `Config`. One tab per ward, named to match the ward's `ward_code` (2-letter code). Plus one tab named `Stake`. Columns: `Organization`, `Forwarding Email`, `Position`, `Personal Email`, and additional columns to the right holding emails for multi-person callings.

**`Position` format**: 2-letter prefix (matching the ward code), space, then the calling name. Example: `CO Bishop` in the Cordera tab. The Stake tab uses prefix `ST`.

**Per tab:**

1. Read rows. Strip the 2-letter prefix from `Position` to get the calling name.
2. Collect `Personal Email` + any non-blank cells to its right.
3. For each `(calling, email)` pair where calling matches a row in the appropriate template (`WardCallingTemplate` for ward tabs, `StakeCallingTemplate` for the Stake tab):
   - Compute `source_row_hash = hash(scope, calling, email)`.
   - If no matching auto-seat exists in `Seats`, insert a new row (`type=auto`); write `AuditLog` entry.
   - If it exists, no change.
   - If the template row has `give_app_access=true`, upsert into `Access` (`email`, `scope`, `calling`); write `AuditLog` entry on change.
4. Delete any existing auto-seat for this scope not seen in the current import; write `AuditLog` entry per row.
5. Delete any `Access` row for this scope whose `(email, calling)` pair wasn't seen; write `AuditLog` entry.

**Cap interaction**: imports always apply — LCR truth wins. Over-cap conditions surface as a Dashboard warning and an email to Kindoo Managers.

**Bishopric lag**: new bishopric members can't sign into the app until the next import runs. This lag is accepted for v1.

## 9. Email notifications

- Request submitted → active Kindoo Managers.
- Request completed → requester.
- Request rejected → requester (with reason).
- Request cancelled → active Kindoo Managers.
- Over-cap after import → active Kindoo Managers.

## 10. Bootstrap flow

`Config.bootstrap_admin_email` is seeded on deploy. First page load by that email runs a setup wizard: stake name, callings-sheet ID, at least one Building, at least one Ward, additional Kindoo Managers. Until setup completes, no other user can access the app.

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
