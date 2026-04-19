# Data model

Every tab in the backing Google Sheet. Column order in this doc matches the order the columns must appear in the Sheet. Header names in the Sheet must match exactly (case-sensitive).

## Conventions

- **Empty cell** is how we represent "not applicable" (e.g. `end_date` for a manual seat). The repo layer returns these as `null` / `undefined`.
- **Email** — stored in canonical form: trimmed, lowercased, and (for `@gmail.com`/`@googlemail.com` only) with local-part `.`s and `+suffix` stripped, with `googlemail.com` collapsed to `gmail.com`. Non-Gmail addresses are preserved literally aside from lowercasing. The canonical form is what's stored and what every match/compare operates on — no separate display column. Implemented in `Utils.normaliseEmail` and applied at every boundary (UI input, importer read, JWT claim).
- **`scope`** — the string `"stake"` or a `ward_id` value. Same column appears in `Seats`, `Requests`, `Access`.
- **IDs**
  - `seat_id`, `request_id`: UUID via `Utilities.getUuid()`.
  - `ward_id`, `building_id`: human-readable slug (e.g., `cordera-1st`, `stake-center`). Generated from the `name` on insert if not supplied.
- **Dates** (`start_date`, `end_date`): ISO date string `YYYY-MM-DD` (no time component). Stored as text so it survives round-trips and sorts lexically.
- **Timestamps** (`*_at`): native `Date` objects, displayed in sheet's time-zone (set in `appsscript.json`).
- **Booleans** (`active`, `give_app_access`): actual booleans (`TRUE`/`FALSE` in sheet), not strings.
- **JSON** (`before_json`, `after_json`): stringified JSON. Pretty-printing is disabled so the cell stays single-line.

---

## Tab 1 — `Config`

Key/value pairs. The primary "knobs" the app reads on startup.

| Column | Type | Notes |
| --- | --- | --- |
| `key` | string | Unique. |
| `value` | string/number/boolean | Stored as-typed; repo converts on read based on known keys. |

### Known keys (seeded empty by `setupSheet()` unless noted)

| Key | Expected type | Purpose |
| --- | --- | --- |
| `stake_name` | string | Display name, used in emails and page chrome. Seeded via bootstrap wizard. |
| `callings_sheet_id` | string | Google Sheet ID for the weekly import source. Seeded via bootstrap wizard. |
| `stake_seat_cap` | number | Max seats in the stake pool. Seeded via bootstrap wizard. |
| `bootstrap_admin_email` | string | Seeded manually in the Sheet before first deploy. |
| `gsi_client_id` | string | Google OAuth 2.0 Client ID used by GSI and verified as the JWT `aud`. Seeded manually before first deploy. Changing this value logs everyone out. |
| `setup_complete` | boolean | `FALSE` until bootstrap wizard finishes. |
| `last_import_at` | timestamp | Written by Importer. |
| `last_import_summary` | string | Short human-readable summary of the last run. |
| `expiry_hour` | number | Local hour for the daily expiry trigger. Default `3`. |

### Example rows

| key | value |
| --- | --- |
| `stake_name` | `CS North Stake` |
| `callings_sheet_id` | `1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789` |
| `stake_seat_cap` | `15` |
| `bootstrap_admin_email` | `tad.e.smith@gmail.com` |
| `gsi_client_id` | `1234567890-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com` |
| `setup_complete` | `TRUE` |
| `last_import_at` | `2026-04-19 03:02:11` |
| `last_import_summary` | `CO: +2/-1 auto, +1 access · ST: +0/-0 auto · over cap: none` |
| `expiry_hour` | `3` |

---

## Tab 2 — `KindooManagers`

| Column | Type | Notes |
| --- | --- | --- |
| `email` | string | Lowercased. Unique. |
| `name` | string | Display name for UI/audit. |
| `active` | boolean | Only `active=TRUE` rows count for role resolution and email notifications. |

### Example rows

| email | name | active |
| --- | --- | --- |
| `tad.e.smith@gmail.com` | `Tad Smith` | `TRUE` |
| `bob.jones.csn@gmail.com` | `Bob Jones` | `TRUE` |
| `carol.lee72@gmail.com` | `Carol Lee` | `FALSE` |

---

## Tab 3 — `Buildings`

| Column | Type | Notes |
| --- | --- | --- |
| `building_id` | string (slug) | Unique. |
| `name` | string | |
| `address` | string | Free text. |

### Example rows

| building_id | name | address |
| --- | --- | --- |
| `stake-center` | `Stake Center` | `12345 Powers Blvd, Colorado Springs, CO` |
| `north-ranch` | `North Ranch Building` | `555 Northgate Rd, Colorado Springs, CO` |

---

## Tab 4 — `Wards`

| Column | Type | Notes |
| --- | --- | --- |
| `ward_id` | string (slug) | Unique. Used in `scope` columns. |
| `name` | string | Display name. |
| `ward_code` | string (2 chars) | Must match the ward's tab name in the callings spreadsheet. Unique, case-sensitive. |
| `building_id` | string | FK to `Buildings.building_id`. Default building assigned to new seats. |
| `seat_cap` | number | Max seats for this ward. |

### Example rows

| ward_id | name | ward_code | building_id | seat_cap |
| --- | --- | --- | --- | --- |
| `cordera-1st` | `Cordera 1st Ward` | `CO` | `stake-center` | `20` |
| `cordera-2nd` | `Cordera 2nd Ward` | `C2` | `stake-center` | `20` |
| `north-ranch` | `North Ranch Ward` | `NR` | `north-ranch` | `18` |

---

## Tab 5 — `WardCallingTemplate`

Callings that trigger auto Kindoo seats in every ward. Applied uniformly to every ward's tab in the callings spreadsheet.

| Column | Type | Notes |
| --- | --- | --- |
| `calling_name` | string | Must match the post-prefix string in the callings sheet's `Position` column. Unique. |
| `give_app_access` | boolean | If `TRUE`, the importer writes an `Access` row so the person can sign into the app. |

### Example rows

| calling_name | give_app_access |
| --- | --- |
| `Bishop` | `TRUE` |
| `First Counselor` | `TRUE` |
| `Second Counselor` | `TRUE` |
| `Ward Clerk` | `FALSE` |
| `Ward Executive Secretary` | `FALSE` |
| `Elders Quorum President` | `FALSE` |
| `Relief Society President` | `FALSE` |

---

## Tab 6 — `StakeCallingTemplate`

Same columns as `WardCallingTemplate`, but applied only to the `Stake` tab of the callings spreadsheet.

### Example rows

| calling_name | give_app_access |
| --- | --- |
| `Stake President` | `TRUE` |
| `Stake First Counselor` | `TRUE` |
| `Stake Second Counselor` | `TRUE` |
| `Stake Clerk` | `FALSE` |
| `Stake Executive Secretary` | `FALSE` |
| `High Council` | `FALSE` |

---

## Tab 7 — `Access`

Populated and maintained by the Importer. **Not edited by hand.** Visible to Kindoo Managers only.

| Column | Type | Notes |
| --- | --- | --- |
| `email` | string | Lowercased. |
| `scope` | string | `ward_id` or `"stake"`. |
| `calling` | string | The calling that granted access. Someone holding two access-granting callings in the same scope has two rows. |

### Example rows

| email | scope | calling |
| --- | --- | --- |
| `alice@csnorth.org` | `cordera-1st` | `Bishop` |
| `dave@csnorth.org` | `cordera-1st` | `First Counselor` |
| `emily@csnorth.org` | `cordera-1st` | `Second Counselor` |
| `tad@csnorth.org` | `stake` | `Stake President` |

---

## Tab 8 — `Seats`

Live roster. No active/soft-delete flag — rows are inserted on add, deleted on remove/expire.

| Column | Type | Notes |
| --- | --- | --- |
| `seat_id` | UUID | Unique. |
| `scope` | string | `ward_id` or `"stake"`. |
| `type` | enum | `auto` / `manual` / `temp`. |
| `person_email` | string | Lowercased. |
| `person_name` | string | For display; filled from request or from callings sheet if available. |
| `calling_name` | string | Auto only; blank for manual/temp. |
| `source_row_hash` | string | Auto only; SHA-256 of `scope|calling|canonical_email` (email canonicalised per the conventions section). Used by importer to detect same-row-across-runs, resilient to Gmail dot/`+suffix` variants. |
| `reason` | string | Free text. Required for manual/temp; blank for auto. |
| `start_date` | ISO date (YYYY-MM-DD) | Temp only; optional on manual (blank for auto). |
| `end_date` | ISO date (YYYY-MM-DD) | Temp only. Expires at end of this day (local tz). |
| `building_ids` | string | Comma-separated `building_id` values. Defaults to the ward's `building_id` on insert; editable by managers. |
| `created_by` | string | Email or automated actor (`Importer`, `ExpiryTrigger`). |
| `created_at` | timestamp | |
| `last_modified_by` | string | |
| `last_modified_at` | timestamp | |

### Example rows

| seat_id | scope | type | person_email | person_name | calling_name | source_row_hash | reason | start_date | end_date | building_ids | created_by | created_at | last_modified_by | last_modified_at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `7b3f…-a1e2` | `cordera-1st` | `auto` | `alice@csnorth.org` | `Alice Nguyen` | `Bishop` | `a9f3…` | | | | `stake-center` | `Importer` | `2026-04-19 03:02:11` | `Importer` | `2026-04-19 03:02:11` |
| `c14a…-3e11` | `cordera-1st` | `manual` | `frank@csnorth.org` | `Frank Pierce` | | | `Youth activity coordinator — needs weeknight access` | | | `stake-center` | `alice@csnorth.org` | `2026-04-10 18:22:04` | `bob@csnorth.org` | `2026-04-11 09:11:30` |
| `8d91…-92b0` | `cordera-1st` | `temp` | `guest@example.com` | `Mark Long` | | | `Visiting facilities crew` | `2026-04-20` | `2026-04-27` | `stake-center,north-ranch` | `alice@csnorth.org` | `2026-04-18 14:00:00` | `bob@csnorth.org` | `2026-04-18 20:15:22` |
| `42aa…-7e77` | `stake` | `auto` | `tad@csnorth.org` | `Tad Smith` | `Stake President` | `5c2e…` | | | | `stake-center` | `Importer` | `2026-04-19 03:02:11` | `Importer` | `2026-04-19 03:02:11` |

---

## Tab 9 — `Requests`

| Column | Type | Notes |
| --- | --- | --- |
| `request_id` | UUID | Unique. |
| `type` | enum | `add_manual` / `add_temp` / `remove`. |
| `scope` | string | `ward_id` or `"stake"`. |
| `target_email` | string | The person being added/removed. Lowercased. |
| `target_name` | string | For display. |
| `reason` | string | Required for all types. |
| `comment` | string | Free text (e.g. multi-building notes on adds, removal context). |
| `start_date` | ISO date | Temp only. |
| `end_date` | ISO date | Temp only. |
| `status` | enum | `pending` / `complete` / `rejected` / `cancelled`. |
| `requester_email` | string | Lowercased. |
| `requested_at` | timestamp | |
| `completer_email` | string | Set on `complete` or `rejected`. |
| `completed_at` | timestamp | Set on `complete` or `rejected` (name kept for both for simplicity). |
| `rejection_reason` | string | Required on `rejected`. |

### Example rows

| request_id | type | scope | target_email | target_name | reason | comment | start_date | end_date | status | requester_email | requested_at | completer_email | completed_at | rejection_reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `r1…` | `add_manual` | `cordera-1st` | `frank@csnorth.org` | `Frank Pierce` | `Youth activity coordinator` | `Needs access on Tuesdays after 6pm.` | | | `complete` | `alice@csnorth.org` | `2026-04-10 17:55:11` | `bob@csnorth.org` | `2026-04-10 19:03:02` | |
| `r2…` | `add_temp` | `cordera-1st` | `guest@example.com` | `Mark Long` | `Visiting facilities crew` | | `2026-04-20` | `2026-04-27` | `pending` | `alice@csnorth.org` | `2026-04-18 13:45:20` | | | |
| `r3…` | `remove` | `cordera-1st` | `frank@csnorth.org` | `Frank Pierce` | `No longer serving in that capacity` | | | | `pending` | `alice@csnorth.org` | `2026-04-19 09:00:00` | | | |
| `r4…` | `add_manual` | `stake` | `grace@csnorth.org` | `Grace Woo` | `Stake activity chair` | | | | `rejected` | `tad@csnorth.org` | `2026-04-15 11:30:00` | `bob@csnorth.org` | `2026-04-16 08:12:55` | `Stake pool full — please resubmit after next quarter.` |

---

## Tab 10 — `AuditLog`

One row per state-changing event. Append-only.

| Column | Type | Notes |
| --- | --- | --- |
| `timestamp` | timestamp | |
| `actor_email` | string | **Authorship** — the canonical email of the signed-in user who initiated the change (from the verified GSI JWT), or `"Importer"` / `"ExpiryTrigger"` for automated runs. **Not** the Apps Script execution identity (which is always the deployer under `executeAs: USER_DEPLOYING`); Sheet file revision history will show the deployer for every write, but that's infrastructure, not authorship. Callers must pass `actor_email` explicitly; `AuditRepo.write` does not fall back to `Session.getActiveUser`. |
| `action` | enum | See action vocabulary below. |
| `entity_type` | enum | `Seat` / `Request` / `Access` / `Config` / `Ward` / `Building` / `KindooManager` / `Template`. |
| `entity_id` | string | PK of the affected row (e.g., `seat_id`, `request_id`, `ward_id`, or a composite like `email\|scope\|calling` for `Access`). |
| `before_json` | JSON string | Empty for inserts. |
| `after_json` | JSON string | Empty for deletes. |

### Action vocabulary

- `insert`, `update`, `delete` — generic CRUD for any entity.
- `submit_request`, `complete_request`, `reject_request`, `cancel_request` — request lifecycle.
- `auto_expire` — daily expiry.
- `import_start`, `import_end` — bracket an importer run (`after_json` on `import_end` includes a counts summary).
- `over_cap_warning` — emitted after import if any pool exceeds its cap.
- `setup_complete` — bootstrap wizard finishes.

### Example rows

| timestamp | actor_email | action | entity_type | entity_id | before_json | after_json |
| --- | --- | --- | --- | --- | --- | --- |
| `2026-04-10 17:55:11` | `alice@csnorth.org` | `submit_request` | `Request` | `r1…` | | `{"type":"add_manual","scope":"cordera-1st","target_email":"frank@csnorth.org",...}` |
| `2026-04-10 19:03:02` | `bob@csnorth.org` | `complete_request` | `Request` | `r1…` | `{"status":"pending",...}` | `{"status":"complete",...}` |
| `2026-04-10 19:03:02` | `bob@csnorth.org` | `insert` | `Seat` | `c14a…-3e11` | | `{"seat_id":"c14a…","scope":"cordera-1st","type":"manual",...}` |
| `2026-04-19 03:02:08` | `Importer` | `import_start` | `Config` | `last_import_at` | | `{"scope":"all"}` |
| `2026-04-19 03:02:10` | `Importer` | `insert` | `Seat` | `7b3f…-a1e2` | | `{"type":"auto","scope":"cordera-1st","person_email":"alice@csnorth.org","calling_name":"Bishop",...}` |
| `2026-04-19 03:02:11` | `Importer` | `import_end` | `Config` | `last_import_at` | | `{"inserted":3,"deleted":1,"access_changes":2,"over_cap":[]}` |
| `2026-04-28 03:00:00` | `ExpiryTrigger` | `auto_expire` | `Seat` | `8d91…-92b0` | `{"seat_id":"8d91…","type":"temp","end_date":"2026-04-27",...}` | |
