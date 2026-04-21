# Chunk 2 — Config CRUD

**Shipped:** 2026-04-19
**Commits:** _(see git log; commit messages reference "Chunk 2")_

## What shipped

A working manager-only Configuration page (`ui/manager/Config.html`,
reachable via `?p=mgr/config`) that lets a Kindoo Manager add/edit/delete
rows in the six configuration tabs — Wards, Buildings, KindooManagers,
WardCallingTemplate, StakeCallingTemplate, and Config (key/value) — with
every change locked, audited, and surfaced as a toast on success or
failure. Read paths for the same tabs and a runnable forbidden-path test
ship alongside.

Implemented:

- **`core/Lock.gs#Lock_withLock(fn, opts?)`** — 10 s default `tryLock`
  timeout per architecture.md §6; on contention throws the literal
  `"Another change is in progress — please retry in a moment."` (string
  surfaced verbatim by the client toast).
- **`repos/AuditRepo.gs#AuditRepo_write({...})`** — append-only writer.
  Validates `actor_email` / `action` / `entity_type` / `entity_id` are
  present; **no** fallback to `Session.*` per architecture.md §5
  ("Two identities"). Header-drift check on every write. `before` /
  `after` are JSON-stringified (single-line); `null`/`undefined` map to
  empty cells (insert audit rows have empty `before_json`; deletes have
  empty `after_json`).
- **`repos/ConfigRepo.gs`** — added `Config_update(key, value)` (refuses
  unknown keys; type-coerces booleans and numbers on write); added
  `Config_isProtectedKey(key)` and `Config_isImporterKey(key)` so the
  UI and the API layer share one definition of "don't expose this to
  inline edit." Header-drift check now runs on writes too.
- **`repos/KindooManagersRepo.gs`** — full CRUD by canonical email.
  `_insert` rejects duplicate canonical-emails; `_update` supports
  email rename with collision check; `_getByEmail` added for the API
  layer's "before" lookup. Reads and writes both canonicalise email at
  the boundary, so no caller has to remember.
- **`repos/WardsRepo.gs`** — full CRUD keyed on `ward_code` (the 2-char
  natural key). Duplicate-PK rejection on insert; rename-with-collision-
  check on update; ward_code length validation (must be exactly 2).
  Numeric `seat_cap` coercion. Header drift loud-throws.
- **`repos/BuildingsRepo.gs`** — same shape as Wards, keyed on
  `building_name` (free-text natural key, exact-string compare).
- **`repos/TemplatesRepo.gs`** — single repo serving both
  `WardCallingTemplate` and `StakeCallingTemplate` (identical schema);
  exported functions take a `kind ∈ {'ward','stake'}` discriminator.
  PK is `calling_name`.
- **`api/ApiManager.gs`** — every endpoint follows the canonical Chunk-2
  shape (`Auth_principalFrom` → `Auth_requireRole('manager')` →
  `Lock_withLock(before/after/audit)`). Endpoints shipped:
  `ApiManager_configList`, `ApiManager_configUpdate`,
  `ApiManager_wardsList`/`Upsert`/`Delete`,
  `ApiManager_buildingsList`/`Upsert`/`Delete`,
  `ApiManager_kindooManagersList`/`Upsert`/`Delete`,
  `ApiManager_wardTemplateList`/`Upsert`/`Delete`,
  `ApiManager_stakeTemplateList`/`Upsert`/`Delete`. FK guard on
  `ApiManager_buildingsDelete` (refuses if any Ward references the
  building, error message lists blocking ward_codes). Soft-warn on
  `ApiManager_kindooManagersDelete` when the deletion drops the active-
  manager count to zero (no block — just a warn toast). Plus
  `ApiManager_test_forbidden` — runnable from the editor, asserts
  `Auth_requireRole` throws `Forbidden` for empty-roles and
  bishopric-only principals.
- **`ui/manager/Config.html`** — six-tab editor. Each tab loads its data
  on first activation (lazy), renders rows as inline-editable inputs
  with Save/Delete buttons, plus an Add-row form below. After every
  successful write, only that tab refreshes. Errors arrive as red
  toasts; warnings (e.g., last-active-manager) as orange toasts. PK
  rename fires a `confirm()` warning before submission. Config tab
  splits keys into Editable (text/number/checkbox by type) and
  Read-only (protected + importer-owned, with badges).
- **`ui/ClientUtils.html`** — added `toast(msg, kind?)` (info/success/
  warn/error). Auto-dismiss; multiple toasts stack. Used by Config
  page; future chunks reuse.
- **`ui/Styles.html`** — added toast CSS, manager Config-page CSS
  (tabs, table, inputs, buttons, add-row form, badges, empty state).
- **`core/Router.gs`** — extended to dispatch `?p=mgr/config` →
  `ui/manager/Config` for principals holding the `manager` role; non-
  managers fall back to the role default (the spec's "redirect with
  toast" model — toast is Chunk 5).
- **`ui/Hello.html`** — single conditional link "Open Configuration
  page" for managers, so Chunk-2 testing doesn't require URL surgery.
  Hello is still the Chunk-1-only scaffolding template; the link goes
  away with the file in Chunk 5.
- **`services/Setup.gs#onOpen`** — fixed a Chunk-1 typo
  (`Utils_test_base64UrlDecode` → `Utils_test_base64Url`); added a
  `Run forbidden-path tests` menu item bound to
  `ApiManager_test_forbidden`.

## Deviations from the pre-chunk spec

- **Schema pivot: dropped `building_id` and `ward_id` slug PKs; use
  `building_name` and `ward_code` as natural keys.** Mid-Chunk-2 the
  user pointed out the slug PKs were just bookkeeping — building names
  are user-chosen and unique by usage; `ward_code` is already the
  importer's tab-join key. Dropping the slugs simplifies every cross-
  tab reference: `Wards.building_name` (FK to `Buildings.building_name`),
  `Seats.scope` / `Access.scope` / `Requests.scope` (= `ward_code`),
  `Seats.building_names` (was `building_ids`). Wards columns reordered
  to put `ward_code` first as the obvious PK; renamed `Wards.name` →
  `Wards.ward_name` and `Buildings.name` → `Buildings.building_name`
  for clarity at FK call sites. The Wards add/edit form now renders
  the building field as a `<select>` populated from current Buildings
  rows (orphaned values surface as "(missing)" options). Spec edits:
  data-model.md (Buildings, Wards, Seats, Access, Requests tab tables
  + scope description + natural-keys section); architecture.md D3
  rewritten (UUIDs for synthetic IDs, natural keys for Wards/Buildings);
  spec.md §3 (Buildings/Wards/Seats/Access/Requests bullets + role
  resolution `<ward_code>`); sheet-setup.md Path 2 manual headers;
  build-plan.md Chunks 4 + 6 sub-task references; open-questions.md
  R-5 + C-5 + D3 footnote rewritten. Code: Setup.gs SETUP_TAB_DEFS_,
  BuildingsRepo (rewritten for `building_name` PK), WardsRepo
  (rewritten for `ward_code` PK with 2-char validation), ApiManager
  buildings + wards endpoints, Config.html Buildings + Wards tabs +
  the new building combobox. **Migration from old schema:** Sheet's
  Buildings and Wards tabs need to be deleted by hand (setupSheet
  refuses to touch tabs with header drift); re-run setupSheet to
  recreate; re-enter rows via the Config UI. Other tabs are unaffected
  in Chunk 2 (Seats / Access / Requests are still empty).
- **Bound Sheet must live in a personal Drive, not a Workspace.**
  Discovered during Chunk-2 manual testing: the original Chunk-1
  deployment was set up against a Sheet in the deployer's
  `csnorth.org` Workspace. The deployer (Workspace account) could
  sign in fine; testing with a *consumer Gmail* account hit Google's
  `You do not have permission to access the requested document` page
  before `Identity_serve` ran. None of "Who has access = Anyone with
  Google account", OAuth consent External + In production, Workspace
  Admin App access control unrestricted, bare-form URL, or incognito
  fixed it — the Workspace tenant gates external accounts at a level
  the deployment dialog can't override. **Fix: move the bound Sheet
  to a personal Drive** so the script's linked Cloud project is
  personal-account-owned. Spec impacts: architecture.md D1 (added
  personal-Drive constraint) + D10 (cross-reference); spec.md §2
  Stack "Database" bullet rewritten; sheet-setup.md step 1 + checklist
  rewritten; new open-questions.md D-3 with the full discovery trail.
  **Migration runbook for any existing Workspace-bound install:**
  (1) create new Sheet in deployer's personal Drive,
  (2) Extensions → Apps Script binds a new project,
  (3) update `.clasp.json` scriptId to the new project's,
  (4) `npm run push` (uploads all Chunk-2 code),
  (5) refresh editor tab, run `setupSheet` (creates 10 tabs +
  auto-generates `session_secret`),
  (6) seed `Config.bootstrap_admin_email`,
  (7) Deploy → New deployment → Web app for both Main
  (`USER_DEPLOYING`) and Identity (`USER_ACCESSING`); both
  "Anyone with Google account",
  (8) paste the two `/exec` URLs into `Config.main_url` and
  `Config.identity_url`,
  (9) visit Identity URL once as deployer to grant first-time
  OAuth consent,
  (10) add the deployer's row to `KindooManagers` directly in the
  Sheet, then sign into Main and re-enter the rest of the config
  via the Configuration page,
  (11) optionally archive the old Workspace deployments.
- **Email canonicalisation revised: compare canonical, store as typed.**
  The pre-chunk D4 said canonical was the *stored* form, with no display
  column. Mid-chunk we found that this strips information the user
  typed (e.g. `first.last@gmail.com` → `firstlast@gmail.com`), which is
  wrong for display, wrong for any future "email this person" path, and
  wrong as a record of what was actually entered. New rule:
  `Utils_cleanEmail` (trim only) is what hits cells, signed tokens, and
  `AuditLog.actor_email`; `Utils_emailsEqual` (canonical-on-the-fly) is
  what every comparison goes through. `source_row_hash` (importer)
  still uses the canonical form so it's stable across LCR's format
  wobbles. Spec edits: architecture.md D4 rewritten;
  data-model.md "Conventions → Email" rewritten; open-questions.md I-8
  flagged `[REVISED]` with the full new rule; new helpers
  `Utils_cleanEmail` and `Utils_emailsEqual` in `core/Utils.gs` plus a
  `Utils_test_emailsEqual` runner. KindooManagersRepo, AccessRepo,
  Auth (sign/verify/resolveRoles), and ApiManager kindooManagers
  endpoints all updated. Pre-chunk-2 inserted rows that landed in
  canonical form need a one-time hand-edit in the Sheet to restore
  the typed form.
- **Repo writes don't acquire the lock or emit the audit row themselves;
  the API layer does both.** The pre-chunk text in architecture.md §7
  said "All writes must be called from a `Lock_withLock` context. Each
  emits a corresponding `AuditRepo.write(...)` call **inside the same
  lock**." That's still the *user-facing* invariant — the data write and
  the audit write happen inside the same `Lock_withLock` closure — but
  it's the **API endpoint** that wraps both, not the repo. Rationale:
  keeps repos pure single-tab data access (so cross-tab FK enforcement
  doesn't need to leak into them, and so `KindooManagers_insert` doesn't
  need to know what an `actor_email` is). Spec edited accordingly:
  architecture.md §7 patterns rewritten with the repo-vs-API split
  spelled out, and a sentence added clarifying that cross-tab invariants
  (e.g., Buildings → Wards FK) live in the API layer.
- **Action vocabulary follows data-model.md §10 generic verbs** (`insert`
  / `update` / `delete`), not the per-entity verbs (`ward_insert` /
  `ward_update`) shown in the chunk-1 "Next" example. The example was
  illustrative of the shape, not the action vocabulary; data-model.md
  is the canonical source. `entity_type` values are capitalised per
  data-model.md (`Ward`, not `ward`).
- **Repo function names use no `Repo_` suffix** (`Wards_getById`, not
  `WardsRepo_getById`). Matches the existing Chunk-1 convention
  (`Config_get`, `KindooManagers_isActiveByEmail`, `Access_getAll`).
  The chunk-1 "Next" example used the `Repo_` form for clarity, but the
  actual codebase doesn't.
- **Lock contention error message is now part of the architecture.md §6
  contract.** Added a "Contention contract" bullet documenting the
  literal user-facing message, since the client surfaces it verbatim
  via `toast()` and Chunks 5+ may want to special-case it.

## Decisions made during the chunk

- **Protected Config keys are excluded from inline edit; not gated by
  confirm-text-match.** `session_secret`, `main_url`, `identity_url`,
  and `bootstrap_admin_email` render in a separate "Read-only keys"
  table on the Config tab, badged `protected`. Server-side
  `ApiManager_configUpdate` rejects them (defence-in-depth).
  Recorded as: `open-questions.md` C-4.
- **Importer-owned Config keys (`last_import_at`,
  `last_import_summary`) are also UI-read-only**, badged
  `importer-owned`. Different reason from "protected" — they're not
  security-sensitive, but manager edits would just get clobbered on
  the next import run.
- **`session_secret` value is masked when sent over the wire.**
  `ApiManager_configList` replaces the value with
  `(set — N chars; hidden)` before returning, so the read-only row in
  the UI doesn't ship the actual secret to the browser.
- **`ApiManager_*Upsert` is the canonical insert-or-update endpoint
  shape.** Read by PK, branch to repo `_insert` or `_update` with the
  audit `action` set accordingly. Single rpc call for both add and
  edit makes the client UI symmetric.
- **Building → Ward FK is enforced; Ward → Seat FK is deferred.**
  Building delete refuses if any Ward references it, with the blocking
  ward_codes in the error message. Wards has nothing to reference yet
  in Chunk 2 (Seats is empty until Chunk 3); a `// TODO` marker in
  `ApiManager_wardsDelete` flags the spot for Chunk 5 to add the Seats
  FK check using `Seats_countByScope` (which lands with SeatsRepo).
- **PK rename is allowed but `confirm()`-gated client-side.** Renaming
  `ward_code`, `building_name`, or template `calling_name` produces an
  inline browser confirm warning that downstream rows will dangle. No
  server-side cascade. Recorded as: `open-questions.md` C-5.
- **Last-active-manager delete is allowed with a warn toast, not a
  block.** Per the user's Chunk-2 directive: "deleting the only active
  manager is allowed but should produce a warning toast, not a block."
  `ApiManager_kindooManagersDelete` returns `{ ok, deleted, warning }`;
  the client surfaces `warning` via `toast(msg, 'warn')`.
- **Config row schema for "Add" form is hard-coded per tab, not derived
  from headers.** Plain HTML/JS, no framework, no metadata reflection.
  Six tabs is small enough that the duplication is more readable than
  abstraction.
- **Toast helper added to `ui/ClientUtils.html`.** The Chunk-2 spec
  said "ClientUtils.html already has this," but it didn't —
  `ClientUtils.html` previously contained only `rpc()`. Added a
  ~25-line `toast(msg, kind)` so Chunks 5+ can reuse.

## Spec / doc edits in this chunk

- `docs/architecture.md` — §7 rewritten to spell out the repo-vs-API
  responsibility split (writes pure in repo; lock + audit in API; FK
  checks in API), plus the `ApiManager_*Upsert` convention and the
  shared-schema two-tab repo pattern (Templates).
- `docs/architecture.md` — §6 added a "Contention contract" bullet
  documenting the literal user-facing message thrown by `Lock_withLock`
  on `tryLock` timeout.
- `docs/build-plan.md` — Chunk 2 sub-tasks ticked through and rewritten
  to reflect the lock/audit-in-API split; new sub-task added for the
  router wiring + Hello deep-link; "Out of scope" expanded to call out
  protected/importer-owned Config keys and the deferred Ward→Seat FK.
  Marked `[DONE — see docs/changelog/chunk-2-config-crud.md]`.
- `docs/open-questions.md` — added **C-4** (RESOLVED 2026-04-19) on
  the protected-Config-keys exclusion, with the rationale and the
  rejected confirm-text-match alternative; added **C-5** (P1) on
  `ward_code` / `building_name` rename breaking references — accepted for
  v1 with a client-side `confirm()` warning, future cascade-rename
  noted as a possible follow-up.
- `docs/changelog/chunk-2-config-crud.md` — this file.

## New open questions

- **C-5** (above) — formalised. Whether to forbid PK rename outright,
  cascade renames across referencing tabs inside the same lock, or
  leave the current `confirm()`-gated free-rename. Defer until misuse.

## Files created / modified

**Created**

- `docs/changelog/chunk-2-config-crud.md` — this file.

**Implemented (replaced 1-line stubs with real code)**

- `src/core/Lock.gs` — `Lock_withLock`.
- `src/repos/AuditRepo.gs` — `AuditRepo_write`.
- `src/repos/WardsRepo.gs` — full CRUD.
- `src/repos/BuildingsRepo.gs` — full CRUD.
- `src/repos/TemplatesRepo.gs` — full CRUD for both ward + stake
  templates via a `kind` discriminator.
- `src/api/ApiManager.gs` — all Chunk-2 endpoints + `test_forbidden`.
- `src/ui/manager/Config.html` — six-tab editor.

**Modified**

- `src/repos/ConfigRepo.gs` — added `Config_update`,
  `Config_isProtectedKey`, `Config_isImporterKey`.
- `src/repos/KindooManagersRepo.gs` — added `_insert`, `_update`,
  `_delete`, `_getByEmail`; `_getByEmail` is now the basis of
  `_isActiveByEmail`.
- `src/core/Router.gs` — extended to dispatch `?p=mgr/config`.
- `src/ui/Hello.html` — added a manager-only deep-link to the Config
  page (will be removed when Hello.html is deleted in Chunk 5).
- `src/ui/ClientUtils.html` — added `toast(msg, kind)`.
- `src/ui/Styles.html` — added toast CSS + manager Config-page CSS.
- `src/services/Setup.gs` — fixed `onOpen` menu item name typo
  (`Utils_test_base64UrlDecode` → `Utils_test_base64Url`); added
  `Run forbidden-path tests` menu item.

**Untouched (still 1-line stubs, deferred per build-plan Chunk 2 + later)**

- `src/repos/SeatsRepo.gs`, `src/repos/RequestsRepo.gs` — Chunks 5/6.
- `src/services/Bootstrap.gs`, `src/services/Importer.gs`,
  `src/services/Expiry.gs`, `src/services/RequestsService.gs`,
  `src/services/EmailService.gs`, `src/services/TriggersService.gs`
  — Chunks 3/4/6/8/9.
- `src/api/ApiBishopric.gs`, `src/api/ApiStake.gs` — Chunks 5/6.
- `src/ui/BootstrapWizard.html` — Chunk 4.
- `src/ui/bishopric/*`, `src/ui/stake/*`, `src/ui/manager/{Dashboard,
  RequestsQueue, AllSeats, Access, Import, AuditLog}.html` —
  Chunks 5+.

## Confirmation that the Chunk 2 deferrals list was respected

Per `build-plan.md` Chunk 2 → "Out of scope":

- ✅ `Access` edits — not built. The Access tab has no write path from
  the manager UI; its repo is still read-only (Chunk-1 form). Importer
  (Chunk 3) will own the writes.
- ✅ `Seats` inline edit on the manager All Seats page — not built.
  No SeatsRepo CRUD, no `ApiManager_seatsUpsert`. Chunk 5/6.
- ✅ Protected Config keys — read-only in UI + server-rejected, per
  C-4; no inline-edit affordance shipped.
- ✅ Ward → Seats FK on delete — deferred to Chunk 5 (TODO marker in
  `ApiManager_wardsDelete`).
- ✅ All Chunk 1 deferrals that landed in Chunk 2 (Lock, AuditRepo,
  config repos with CRUD) shipped. Chunks 4/5/6/8/9 deferrals
  (Bootstrap, Importer, Seats, Requests, Email, Triggers) all
  remain as 1-line stubs.

## Manual test setup (Chunk-2 verification)

1. `npm run push` to upload Chunk-2 code. **Re-deploy both Main and
   Identity** (`Deploy → Manage deployments → Edit → Version: New
   version → Deploy`) — the `/exec` URL serves the deployed version,
   not the pushed code. Footer `v: <ts>` should update.
2. Sign in as the deployer. The Hello page now shows "Open
   Configuration page" for managers; click it (or visit
   `/exec?p=mgr/config` directly).
3. **Wards / Buildings / KindooManagers / Templates / Config** —
   exercise add / edit / delete in each tab, then check `AuditLog`
   (in the backing Sheet) for one row per change with the actor's
   canonical email.
4. **Forbidden-path** — from the Apps Script editor, run
   `ApiManager_test_forbidden` (or `Kindoo Admin → Run forbidden-path
   tests` from the bound Sheet). Expect "All ApiManager forbidden-path
   checks passed." in the execution log.
5. **Header drift** — manually rename the `value` header in the Config
   tab to `value2`. Re-load the Config page tab; expect a red toast
   `Config header drift at column 2: expected "value", got "value2"`
   and the Config tab reads no rows. Restore the header; reload;
   normal operation resumes.
6. **Concurrency** — open the Configuration page in two browser
   windows. In window A, simulate a long write (e.g., add a Building
   from one window while triggering a write from the other in rapid
   succession). One write succeeds; the other surfaces the
   "Another change is in progress — please retry in a moment." toast.
7. **FK on Building delete** — try to delete a Building referenced by
   a Ward; expect a red toast naming the blocking ward_codes. Reassign
   or delete the wards first; the Building delete then succeeds.

## Next

Chunk 3 (Importer) introduces the first non-API write path:
`services/Importer.gs#runImport({ triggeredBy })` runs under
`Lock_withLock` (raise `timeoutMs` per architecture.md §6 — imports take
minutes), uses `actor_email = "Importer"` for every audit row, and
brackets the per-row entries with `import_start` / `import_end` audit
rows. The tab-name → ward lookup wants a `Wards_getByWardCode(code)`
helper added to `WardsRepo` (cheap addition; data-model has the column).

The `ApiManager_importerRun` endpoint should mirror the Chunk-2 shape —
`Auth_principalFrom` → `Auth_requireRole('manager')` → call
`Importer_runImport({ triggeredBy: principal.email })`. The actor_email
on audit rows is **`"Importer"`** (literal string), not the manager's
email; the manager's email is recorded only as the run's `triggeredBy`
in the `import_start`/`import_end` payload. See architecture.md §5.

Access tab gets its first writes in Chunk 3 (importer-owned per spec.md
§3 + open-questions.md A-6); `repos/AccessRepo.gs` will need
`_insert(row)` / `_delete(email, scope, calling)` + `_getByScope(scope)`
added in the Chunk-1 shape.
