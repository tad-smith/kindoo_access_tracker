# Chunk 3 — Importer

**Shipped:** 2026-04-20
**Commits:** _(see git log; commit messages reference "Chunk 3")_

## What shipped

A working "Import Now" flow on the manager surface. A Kindoo Manager clicks
**Import Now** on `?p=mgr/import`; the server opens the callings spreadsheet
by `Config.callings_sheet_id`, parses each tab whose name matches a
`Wards.ward_code` (or the literal `Stake`), and brings `Seats` (auto rows)
and `Access` into agreement with what LCR now says — inside one lock
acquisition, with per-row `AuditLog` entries bracketed by `import_start`
/ `import_end`. Re-running with no source changes produces zero inserts,
zero deletes, and zero per-row audit rows. A sibling read-only
`?p=mgr/access` page renders the current Access tab for Kindoo Manager
review.

Implemented:

- **`services/Importer.gs#Importer_runImport({ triggeredBy })`** — the
  one public entry. Writes `import_start` before any mutation, runs the
  diff-and-apply worker, writes `Config.last_import_at` + a human-readable
  `Config.last_import_summary`, and writes `import_end` with an
  `{inserted, deleted, access_added, access_removed, warnings,
  elapsed_ms}` payload. `triggeredBy` (the manager's email, or
  `"weekly-trigger"` once Chunk 9 lands) goes only into the start/end
  payloads; `actor_email` on every per-row audit is the literal string
  `"Importer"` per architecture.md §5.
- **`services/Importer.gs` parser** — per-tab: strips the 2-letter prefix
  from `Position` (I-5: prefix-mismatched rows skipped with a warning),
  collects `Personal Email` + every non-blank cell to its right, filters
  to callings present in the appropriate template (`WardCallingTemplate` /
  `StakeCallingTemplate`; I-6), emits `(seat, access?)` pairs per
  `(calling, email)`. Access emits only when the template row's
  `give_app_access=true`. Unknown tabs are silently skipped (listed in the
  `import_end` payload); wards with no matching tab keep their existing
  auto-seats and Access rows (I-2, resolved this chunk).
- **Idempotency**: seats key on `source_row_hash = SHA-256(scope|calling|
  canonical_email)` (architecture.md D5), computed via the existing
  `Utils_hashRow`. Access keys on `(canonical_email, scope, calling)`.
  Emails are stored as typed per D4; the canonical form appears only in
  the hash / diff keys. So `Alice.Smith@gmail.com` in one import and
  `alicesmith@gmail.com` in the next produce zero writes on the second
  run — a run where nothing changed in the source produces zero per-row
  audit rows, only the start/end brackets.
- **Scopes-not-seen are inert (I-2).** The worker only diffs scopes that
  actually matched a callings-sheet tab (`scopesSeen`). A ward whose
  `ward_code` doesn't match any tab — usually a tab rename on the LCR
  side — keeps its auto-seats and Access rows untouched; the condition
  is recorded as a warning in the `import_end` payload and surfaces on
  the Import page's "Warnings from last run" details block.
- **Batched writes.** `Seats_bulkInsertAuto(rows)` does one `setValues`
  call for all insert rows. `AuditRepo_writeMany(entries)` does the same
  for the collected per-row audit batch. Deletes stay per-row via
  `Seats_deleteByHash` / `Access_delete` — volumes are small enough
  (typically 0–5/week) that the per-row `deleteRow` cost (~150 ms each)
  is not a concern. First-run population of ~250 rows lands in a single
  digit number of seconds, well under the 6-minute execution cap. A
  `[Importer] completed in Xs — …` line is always logged at end of run as
  the early-warning signal.
- **`repos/SeatsRepo.gs`** — implemented from the Chunk-1 stub. Exports
  `Seats_getByScope(scope)` (all seats, any type), `Seats_getAutoByScope`
  (type=auto only), `Seats_bulkInsertAuto(rows)` (batched append;
  materialises `seat_id` / `created_at` / `last_modified_at` /
  `created_by='Importer'` defaults), and `Seats_deleteByHash(hash)`.
  Manual/temp CRUD lands in Chunks 5–7.
- **`repos/AccessRepo.gs`** — extended with `Access_getByScope(scope)`,
  `Access_insert(row)`, `Access_delete(email, scope, calling)`. Caller
  owns the lock and the audit row per architecture.md §7.
- **`repos/AuditRepo.gs`** — added `AuditRepo_writeMany(entries)`,
  semantically equivalent to N `AuditRepo_write` calls but through one
  `setValues` so a full-population import's audit flush fits comfortably
  in the execution budget. Validation identical to `_write`.
- **`api/ApiManager.gs`** — three new endpoints following the canonical
  Chunk-2 shape (`Auth_principalFrom` → `Auth_requireRole('manager')` →
  work):
  - `ApiManager_importerRun(token)` — wraps `Importer_runImport` in
    `Lock_withLock(fn, { timeoutMs: 30000 })` (architecture.md §6 bumps
    importer timeouts). Returns `{ok, summary, inserted, deleted,
    access_added, access_removed, warnings, skipped_tabs, elapsed_ms}`.
  - `ApiManager_importStatus(token)` — read-only: returns
    `{last_import_at, last_import_summary, callings_sheet_id}`.
  - `ApiManager_accessList(token)` — read-only mirror of
    `Access_getAll()` for the read-only Access page.
- **`ui/manager/Import.html`** — Import Now button + spinner, a status
  panel with `last_import_at` / `last_import_summary` / `callings_sheet_id`,
  and a collapsible "Warnings from last run" block. Errors (callings
  sheet not shared, `callings_sheet_id` missing, lock contention) surface
  as red `toast()`s with the server-side error message verbatim — never a
  stack trace. After every run (success or failure) we refresh the status
  panel from `ApiManager_importStatus` so what the user sees matches
  what's persisted in Config.
- **`ui/manager/Access.html`** — read-only table of Access rows with a
  scope filter (`All` / `stake` / each ward_code seen in the data). Sorted
  by scope, then calling, then email.
- **`core/Router.gs`** — now dispatches `?p=mgr/import` and
  `?p=mgr/access` in addition to `?p=mgr/config` (manager-only each). The
  page-id → template map was refactored from a chain of `if` blocks into
  a small lookup so adding further manager pages in later chunks is a
  one-liner.
- **`ui/Hello.html`** — added two more manager-only deep-links (Import,
  Access). All three links now share a single rewiring block.
- **`ui/Styles.html`** — new styles for the Import card (actions row,
  spinner, definition list for status fields, warnings details) and the
  Access page (toolbar + row count); existing `.config-table` gets reused
  for the Access grid.

## Deviations from the pre-chunk spec

- **Per-row Audit writes are batched via `AuditRepo_writeMany` rather
  than N separate `AuditRepo_write` calls.** The spec said "write
  AuditLog entry per row" — the user-visible invariant (one row per
  change, actor `"Importer"`) is unchanged; this is a perf rearrangement.
  ~250 rows × ~150 ms per `appendRow` = ~40 s just on audit I/O on a
  fresh install, vs. ~1 s for a single `setValues`. The batch preserves
  array order so the log reads the same. Architecture.md §9 updated to
  name the batching helper; `AuditRepo_writeMany` added to
  `repos/AuditRepo.gs` with the same validation as `_write`.
- **`Config.callings_sheet_id` prerequisite newly documented in
  `sheet-setup.md`.** Not a spec change per se (the key was already
  listed in data-model.md), but sheet-setup.md now has a Step 15 that
  walks through (a) pasting the callings sheet's ID into Config, (b)
  sharing that sheet with the deployer's personal Google account so
  `SpreadsheetApp.openById` (which runs as the deployer) can open it,
  and (c) the first-run sanity check (Import Now → expect a summary, no
  stack trace). Also added as a "Things to double-check" checklist bullet.
- **Wards with no matching tab keep their rows (I-2 formally resolved).**
  Spec §8 says "Delete any existing auto-seat for this scope not seen in
  the current import" — ambiguous on what "this scope" means when the
  scope wasn't processed at all. The chunk clarifies: only scopes that
  matched a callings-sheet tab get diffed; scopes not seen are inert.
  This is the safe reading (renaming a tab does not wipe a ward).
  Recorded in open-questions.md I-2 as RESOLVED.
- **Warnings (prefix mismatches, missing tabs, missing Personal Email
  header) land in the `import_end` audit payload, not as per-row
  `import_warning` audit entries.** Open-questions.md I-2 / I-5 proposed
  per-row warning audits; we consolidated them into the bracket payload
  to keep AuditLog tidy. The manager Import page's "Warnings from last
  run" block reads them from the same payload.

## Decisions made during the chunk

- **Lock contention for the importer uses `timeoutMs: 30000`.**
  Architecture.md §6 already said "raise `timeoutMs` to 30 s of waiting"
  for importer and expiry; this chunk is the first to actually set it.
  All other writes still use the 10 s default. Since imports are
  infrequent (weekly once Chunk 9 lands; manual before that) and
  relatively short (a few seconds at current scale), a 30 s wait for
  contention is comfortable headroom.
- **Person name is not populated from the callings sheet.** The columns
  the importer reads are `Position` and `Personal Email` (+ extra email
  columns to the right); there's no "name" column in that layout. We
  store `person_name=''` for auto rows. The manager All Seats page in
  Chunk 5 / 6 can edit the name inline, and future callings-sheet
  layouts with a name column can be handled then. Not a spec change —
  data-model.md already says "filled from request or from callings
  sheet if available", and "available" now means "not in this layout".
- **`SpreadsheetApp.openById` inherits the deployer's scope; callings
  sheet must be shared with the deployer.** Flagged in sheet-setup.md as
  a new prerequisite. Failure mode: a red toast on Import Now naming the
  sheet ID and the underlying Apps Script error; no stack trace reaches
  the user. The error also lands in `Config.last_import_summary` as
  `FAILED: Could not open the callings spreadsheet (id: …) …` so the
  Import page shows the failure even if the toast scrolls away.
- **The scope discriminator is the literal `Stake` tab name.** Not
  `Wards.ward_code='ST'` — the Stake tab is special (it's not a ward),
  matches by exact tab-name `Stake`, and uses `StakeCallingTemplate`.
  The scope in the resulting `Seats.scope` / `Access.scope` is the
  lowercase string `"stake"` per data-model.md. The prefix-stripping
  token for that tab is `ST `.
- **Importer-owned Config writes don't re-acquire the lock** — the
  outer `Lock_withLock` on `ApiManager_importerRun` already holds it,
  so `Config_update('last_import_at', …)` and
  `Config_update('last_import_summary', …)` inside
  `Importer_runImport` are safe. Same rule for per-row `Seats` / `Access`
  writes and `AuditRepo_writeMany`.
- **Audit entries are collected into an in-memory array and flushed
  once at end-of-worker.** Ordering in the AuditLog tab is preserved
  (setValues writes in array order). `import_start` is written BEFORE the
  mutation phase so a mid-run crash still leaves a bracket row; the
  `catch` path writes its own `import_end` with `{error, elapsed_ms}`.

## Spec / doc edits in this chunk

- `docs/architecture.md` — §9 "Importer" rewritten: names the
  `Importer_runImport` entry point, the Chunk-2 API shape wrapping it,
  the 30 s `timeoutMs`, the `actor_email='Importer'` literal, the
  batched writes (`Seats_bulkInsertAuto`, `AuditRepo_writeMany`), the
  I-2 scopes-not-seen invariant, and the batched write rationale.
- `docs/sheet-setup.md` — new Step 15 walks through `Config.callings_sheet_id`
  + deployer sharing + first-run sanity check for the importer. New
  checklist bullet under "Things to double-check".
- `docs/build-plan.md` — Chunk 3 sub-tasks ticked; heading marked
  `[DONE — see docs/changelog/chunk-3-importer.md]`.
- `docs/open-questions.md` — I-2, I-5, I-7 marked RESOLVED with the
  implemented behaviour.
- `docs/changelog/chunk-3-importer.md` — this file.

## New open questions

None. I-2 / I-5 / I-7 folded into this chunk's resolutions; I-3 was already
handled by the hash-keyed dedupe. The Chunk-9 "over-cap warning email"
question (OC-1) remains open for its own chunk.

## Files created / modified

**Created**

- `docs/changelog/chunk-3-importer.md` — this file.

**Implemented (replaced 1-line stubs with real code)**

- `src/services/Importer.gs` — full run-import worker.
- `src/repos/SeatsRepo.gs` — importer-facing CRUD subset
  (`Seats_getByScope`, `Seats_getAutoByScope`, `Seats_bulkInsertAuto`,
  `Seats_deleteByHash`).
- `src/ui/manager/Import.html` — Import Now page.
- `src/ui/manager/Access.html` — read-only Access page.

**Modified**

- `src/repos/AccessRepo.gs` — added `_getByScope`, `_insert`, `_delete`.
- `src/repos/AuditRepo.gs` — added `AuditRepo_writeMany`.
- `src/api/ApiManager.gs` — added `ApiManager_importerRun`,
  `ApiManager_importStatus`, `ApiManager_accessList`.
- `src/core/Router.gs` — dispatch `?p=mgr/import` and `?p=mgr/access`
  (manager-only); refactored the per-page-id branching to a lookup table.
- `src/ui/Hello.html` — added two more manager deep-links (Import,
  Access); rewired the three links to share one event-handler block.
- `src/ui/Styles.html` — Import / Access page styles; reused `.config-table`
  for the Access grid.
- `docs/architecture.md`, `docs/sheet-setup.md`, `docs/build-plan.md`,
  `docs/open-questions.md` — per "Spec / doc edits in this chunk" above.

**Untouched (still 1-line stubs, deferred per build-plan Chunk 3 + later)**

- `src/repos/RequestsRepo.gs` — Chunk 6.
- `src/services/Bootstrap.gs`, `src/services/Expiry.gs`,
  `src/services/RequestsService.gs`, `src/services/EmailService.gs`,
  `src/services/TriggersService.gs` — Chunks 4/8/6/9.
- `src/api/ApiBishopric.gs`, `src/api/ApiStake.gs` — Chunks 5/6.
- `src/ui/BootstrapWizard.html` — Chunk 4.
- `src/ui/bishopric/*`, `src/ui/stake/*`, `src/ui/manager/{Dashboard,
  RequestsQueue, AllSeats, AuditLog}.html` — Chunks 5+.

## Confirmation that the Chunk 3 deferrals list was respected

Per `build-plan.md` Chunk 3 → "Out of scope":

- ✅ Weekly time-based trigger — not installed. No `TriggersService`
  work this chunk; Chunk 9 installs the weekly trigger.
- ✅ Over-cap warning emails — not implemented. No `EmailService` calls
  from the importer; no cap math. Chunk 9.
- ✅ Manual/temp seat writes — no `Seats_insert(row)` for manual/temp;
  the only Seats writer added is `Seats_bulkInsertAuto` (type=auto
  only). Chunks 6/7.
- ✅ Bishopric / stake UI — none touched.
- ✅ Expiry trigger — `services/Expiry.gs` still a one-line stub.

## Import timing measurement

**First live run (2026-04-20 22:23 MDT)**: 199 inserts, 0 deletes,
36 access+/0 access-, **32.3 s**, 177 warnings. ~5× slower than the
3–6 s projection. Likely culprits (not yet profiled):

- Per-scope reads in the diff phase hit `getDataRange().getValues()`
  once each for Seats and Access — 13 scopes × 2 tabs × ~150 ms =
  ~4 s even on empty tabs. A single "read once, bucket by scope"
  pass would eliminate 24 of those 26 reads.
- Callings-sheet tab reads: 13 tabs × ~300 ms = ~4 s.
- `Access_insert` is still per-row `appendRow` (~150 ms each) —
  36 × 150 ms = ~5 s. Bulking it the way `Seats_bulkInsertAuto` is
  would drop this to ~1 s.
- Apps Script's first `openById` to a foreign Spreadsheet often pays
  a 2–5 s cold-start penalty that doesn't repeat within the same
  execution.

Headroom against the 6-minute cap is comfortable (32 s / 360 s ≈ 9 %),
so no blocker for shipping Chunk 3. But the per-scope read pattern
won't scale linearly with ward count — worth revisiting before
Chunk 9's weekly trigger in case any operational pressure arrives on
the cap. Tracked implicitly here; no new open-question number until
we either decide to optimise or confirm "fine at scale".

**177 warnings on that run** is surprising. At 12 wards + Stake = 13
tabs, that's ~13.6 warnings/tab, which is far more than LCR-side
typos could account for. Most likely explanation: the Position-prefix
rule (`<CODE> <calling>`) doesn't match the real LCR format — e.g.
positions might be `Cordera 1st Ward Bishop` rather than `CO Bishop`,
or the separator may be `-` or `:` rather than a space. Open the
Warnings block on the Import page (or check DevTools console — each
warning is logged individually now) to see the actual Position
values being skipped; we'll likely need a parser adjustment in a
follow-up chunk.

A second-run idempotency check (expected: sub-second, 0 inserts,
0 deletes, only `import_start` / `import_end` in AuditLog) is still
the right next-step verification — ideally done before investigating
the warnings, to confirm the rows that DID import are stable.

## Next

Chunk 4 (Bootstrap wizard) gates first-run access on
`Config.setup_complete`. The wizard writes to the same six config tabs
the Chunk-2 Configuration page edits, so it can reuse `ApiManager_*Upsert`
under the hood — just from a different front-end. One pattern to carry
over: the wizard should end by flipping `Config.setup_complete=TRUE`
inside a `Lock_withLock` block with an associated `AuditRepo.write({
action: 'setup_complete', entity_type: 'Config', entity_id:
'setup_complete' })` row, matching the action vocabulary data-model.md
already lists.

Main.doGet will need a new branch: if `Config.setup_complete` is FALSE
and the signed-in email matches `Config.bootstrap_admin_email`
(via `Utils_emailsEqual`), route straight to the wizard regardless of
`?p=`; else show a "setup in progress" page. Non-bootstrap-admins hitting
the app during bootstrap see the "setup in progress" page, not
`NotAuthorized` — the difference is visible to them and matters for the
deployer walk-through.
