# Chunk 4 — Bootstrap wizard

**Shipped:** 2026-04-20
**Commits:** _(see git log; commit messages reference "Chunk 4")_

## What shipped

A first-run setup wizard that gates access to the app until the deployer
configures it end-to-end. On a fresh install (`Config.setup_complete=FALSE`),
signing in as `Config.bootstrap_admin_email` lands the admin on a four-step
wizard (stake info → Buildings → Wards → optional extra Kindoo Managers →
Complete Setup). Other signed-in users see a "setup in progress" page.
On Complete, `setup_complete` flips to `TRUE` and every subsequent page
load routes through normal role resolution — the wizard is one-shot.

Implemented:

- **`api/ApiShared.gs` — setup-complete gate.** `ApiShared_bootstrap`
  now reads `Config.setup_complete` **before** `Router_pick` /
  role resolution. Three outcomes:
  - `setup_complete=TRUE` → normal role resolution (Chunks 1-3 path,
    unchanged).
  - `setup_complete=FALSE` + signed-in email matches
    `Config.bootstrap_admin_email` (via `Utils_emailsEqual`) →
    `ui/BootstrapWizard.html`, regardless of `?p=`.
  - `setup_complete=FALSE` + email does NOT match → `ui/SetupInProgress.html`
    (deliberately distinct from `NotAuthorized` — the user isn't
    unauthorised, the app isn't ready yet).
  The gate runs before role resolution so the bootstrap admin — who has
  no roles during bootstrap (KindooManagers empty, Access empty) —
  doesn't land on `NotAuthorized`.
- **`services/Bootstrap.gs` — state machine + API surface** (the
  rpc-callable `ApiBootstrap_*` endpoints live in this same file, same
  pattern as Chunk-3's `ApiManager_importerRun` being next to
  `Importer_runImport`). Endpoints:
  - `ApiBootstrap_getState` — read-only; returns the full shape the
    wizard UI renders from (current step, all four steps' data,
    `canFinish` boolean). Also performs the one-time auto-add of the
    admin as an active KindooManager inside the lock, so by the time
    Complete Setup runs, the admin is already a manager and role
    resolution on the next page load returns `'manager'` without any
    manual seed.
  - `ApiBootstrap_step1Submit` — writes `stake_name`,
    `callings_sheet_id`, `stake_seat_cap` to Config inside one lock;
    three audit rows.
  - `ApiBootstrap_buildingsUpsert` / `ApiBootstrap_buildingsDelete` —
    thin wrappers over `BuildingsRepo`, same shape as
    `ApiManager_buildings*`, with the same FK guard on delete.
  - `ApiBootstrap_wardsUpsert` / `ApiBootstrap_wardsDelete` — same
    over `WardsRepo`, same building-FK validation.
  - `ApiBootstrap_kindooManagersUpsert` /
    `ApiBootstrap_kindooManagersDelete` — same over
    `KindooManagersRepo`. The admin can't delete themselves during the
    wizard (server-side + UI-side guard).
  - `ApiBootstrap_complete` — `TriggersService_install()` (stubbed this
    chunk) → `Config_update('setup_complete', true)` → `AuditLog`
    (`action='setup_complete'`) all inside one lock. Returns `{ok:
    true, redirect: <main_url>}` so the client redirects the top
    frame to the normal entry.
  Every endpoint begins with `Bootstrap_principalFrom_(token)` — a
  wrapper over `Auth_principalFrom` + `Bootstrap_requireBootstrapAdmin_`
  that checks both (a) signed-in email equals `bootstrap_admin_email`
  via `Utils_emailsEqual` AND (b) `setup_complete` is still FALSE.
  Both required — fails either check and the endpoint throws. Post-
  setup, every endpoint refuses.
- **`ui/BootstrapWizard.html`** — single multi-step page, server-
  state-driven (every rpc returns the full refreshed state; no
  client-side wizard state store). Free navigation between completed
  steps; `Complete Setup` button enabled only when steps 1-3 are all
  complete (guarded on the server in `ApiBootstrap_complete` too).
- **`ui/SetupInProgress.html`** — shown to non-admins during bootstrap.
  No sign-out button; tells the user to contact the admin (email pulled
  from `Config.bootstrap_admin_email`).
- **`ui/Styles.html`** — added `.bootstrap-wizard`, `.wizard-steps`,
  `.wizard-panel`, `.wizard-finish-card`, `.setup-in-progress`, and the
  step-indicator styles (active / complete / numbered pill).
- **`services/TriggersService.gs`** — stubbed. `TriggersService_install`
  logs a no-op message and returns; real trigger creation lands in
  Chunks 8 (daily expiry) and 9 (weekly import). The wizard calls it
  anyway and records the call in the `setup_complete` audit row's
  `after_json.triggers_install` field so the operator can see it ran.

## Late-breaking: batched writes within a step

After the initial Chunk-4 implementation shipped (2026-04-20), per-row
Add latency in the wizard felt slow — each single-row rpc ran full
`Bootstrap_getState_` at the end (4 sheet reads + 1 write + 1 audit +
google.script.run overhead ≈ 2–3 s per Add). At 12 wards and a few
buildings the wizard was spending 30–60 s just on serial Add calls.
Reworked on 2026-04-21 so that within a step, Adds queue client-side
into a `pending` list and flush in one bulk rpc on navigation.

User-facing shape:

- Each step's "Add" button is now "Add to list" and queues the row
  client-side (no rpc). Pending rows render with a yellow `unsaved`
  badge alongside saved rows.
- Navigation actions (step-bar button, Back, Next, Complete Setup)
  auto-commit the current step's pending rows via a new
  `ApiBootstrap_*BulkInsert` endpoint. On commit failure, the pending
  list stays so the user can fix the bad row and retry.
- A `beforeunload` warning surfaces a generic "leave without saving?"
  prompt if the user closes the tab with pending rows.
- Step-bar tab labels show `N unsaved` when the step has pending.
- Complete Setup flushes all three steps' pending (in order) before
  calling `ApiBootstrap_complete`.

Server-side:

- New repo methods: `Buildings_bulkInsert`, `Wards_bulkInsert`,
  `KindooManagers_bulkInsert`. Each validates every row up-front
  (PK presence, cross-row uniqueness within the batch, uniqueness
  against existing rows) before any `setValues` — a bad row
  aborts the whole batch, leaving the Sheet untouched. FK checks
  (e.g. Wards' `building_name` → Buildings) stay in the API layer
  per architecture.md §7.
- New API endpoints: `ApiBootstrap_buildingsBulkInsert`,
  `ApiBootstrap_wardsBulkInsert`, `ApiBootstrap_kindooManagersBulkInsert`.
  Each runs inside one `Lock_withLock` block:
  `Bootstrap_ensureAdminAsManager_` (at most one audit row) → bulk-
  validate + bulk `setValues` → `AuditRepo_writeMany` (one audit
  entry per inserted row, preserving array order). No partial-batch
  writes are possible.
- Single-row `ApiBootstrap_*Upsert` / `*Delete` endpoints are
  preserved and still used for edits and deletes on existing saved
  rows (rare during initial setup; not worth batching).

**Cost of the change:** pending rows live only in the browser. A
crash or deliberate close mid-step loses them (mitigated by the
`beforeunload` warning but not prevented). The "close browser
mid-wizard and resume" property still holds for committed rows —
the server state is authoritative — it just no longer holds for
rows the user has typed but not committed. Acceptable for a one-
shot setup flow; documented in the user-visible intro text on each
step ("queue a row locally; clicking Back / Next / a step tab /
Complete Setup saves the whole batch in a single write").

## Deviations from the pre-chunk spec

- **The setup-gate lives in `ApiShared_bootstrap`, not in `Main.doGet`.**
  `Main.doGet` is called before the client has a verified session token
  (the first call just renders Layout so the client-side boot can read
  `sessionStorage.jwt` and call `ApiShared_bootstrap`). The gate needs
  the verified principal to compare against `bootstrap_admin_email`, so
  putting it in `ApiShared_bootstrap` is the natural fit. The effect is
  the same as "Main.doGet gating" from the reader's perspective — the
  UI rendered on first page load is the wizard or SetupInProgress — but
  the implementation lives one level deeper. Spec: `architecture.md` §4
  step 7.ii + §10 updated; `spec.md` §10 rewritten.
- **Bootstrap admin is auto-added as the first KindooManager.** Pre-
  chunk spec §10 said "additional Kindoo Managers (optional — admin is
  already one)" without saying how the admin becomes one. Adding them
  explicitly on wizard entry removes the forgetting-to-add-myself
  footgun that would lock the admin out post-setup; requiring them to
  re-type their own email was friction for no safety benefit. The admin
  can't delete themselves during the wizard (UI-side + server-side
  guard in `ApiBootstrap_kindooManagersDelete`). Spec: `spec.md` §10,
  `architecture.md` §10 rewritten to spell this out.
- **The wizard is one-shot.** Every `ApiBootstrap_*` endpoint refuses
  once `Config.setup_complete=TRUE`. Post-setup edits route through the
  normal manager Configuration page (Chunk 2). Pre-chunk spec didn't
  say one way or the other; "Post-setup re-running of the wizard"
  appeared only under Chunk 4's "Out of scope" in build-plan.md. Making
  it a one-shot is the safer reading: avoids a dangling admin-elevation
  vector and keeps the auth story simple. Spec: `architecture.md` §10
  + `spec.md` §10 explicit.
- **Admin's `AuditLog.actor_email` is their own email, not a synthetic
  `"Bootstrap"` literal.** Automated-actor literals (`Importer`,
  `ExpiryTrigger`) exist because those runs are time-triggered and have
  no human actor. The wizard is human-initiated, so the audit rows it
  writes should show the admin's own email — consistent with
  `ApiManager_*` audit rows and with the "two identities" rule in
  `architecture.md` §5.

## Decisions made during the chunk

- **`ApiBootstrap_*` endpoints delegate to the Chunk-2 repos directly,
  rather than call `ApiManager_*Upsert` via a "bootstrap admin counts as
  manager" role check.** Both options were sketched in the Chunk-3
  "Next" note. The direct-delegation path wins because it keeps
  `Auth_requireRole('manager')` strict and its call sites auditable —
  no special-case role logic leaks into every other manager endpoint.
  The cost is some apparent duplication between
  `ApiManager_buildingsUpsert` and `ApiBootstrap_buildingsUpsert`, but
  the bodies are thin wrappers around the same `BuildingsRepo` CRUD
  plus the same Lock+audit pattern — the real logic isn't duplicated,
  only the per-endpoint boilerplate (which is exactly what the
  canonical Chunk-2 shape is made of).
- **`ApiBootstrap_complete` returns `redirect: Config_get('main_url')`
  rather than relying on a client-side reload.** Two reasons: (1) the
  client already has `MAIN_URL` injected from Layout.html, but the
  explicit server-returned value means a deployment-URL change between
  initial render and finish would still land correctly; (2) a
  top-frame replace to `MAIN_URL` strips any `?p=` that might have
  been in the address bar, giving a clean first landing post-setup.
  Fallback to `MAIN_URL` global and then to a plain reload if neither
  is available.
- **Wizard state is reloaded (full-state return) on every step rpc,
  rather than a diff-style response.** At 4 steps × handful of rows
  this is trivially cheap, and it makes the UI recover automatically
  from partial failures and concurrent-admin-tab edits. This is also
  what makes the "close-browser-mid-wizard and reopen" flow work
  without any client-side state hydration step.
- **TriggersService_install is a no-op stub in Chunk 4.** Chunk 4's
  build-plan Out of scope explicitly defers real trigger installation
  to Chunks 8/9 (daily expiry / weekly import). The wizard still calls
  the stub at finish so the call-path is real, and audits the call so
  Chunk 8 / 9 can drop in real trigger creation without changing
  `Bootstrap.gs`. The `setup_complete` audit row's `after_json` carries
  a `triggers_install` string that's either the stub's log line or
  (Chunks 8/9+) the real install summary.
- **Gate compares on `Utils_emailsEqual`, not literal equality.** The
  admin might seed `Tad.Smith@gmail.com` in Config but Google hands
  Identity `tadsmith@gmail.com`; the dot-stripping rule (architecture.md
  D4 + open-questions.md I-8) is consistent with every other email
  comparison in the code.

## Spec / doc edits in this chunk

- `docs/spec.md` — §10 "Bootstrap flow" rewritten: names the
  setup-gate in `ApiShared_bootstrap`, the three gate outcomes, the
  four wizard steps, the auto-add-as-KindooManager rule, the one-shot
  guarantee.
- `docs/architecture.md` — §4 step 7.ii updated to mark the setup-gate
  live (was "(Chunk 4)" flagged placeholder); §10 rewritten to spell
  out the gate, the state-driven wizard UI, the Finish flow, and a new
  "`ApiBootstrap_*` endpoint pattern" subsection documenting the
  endpoint auth gate, the one-shot guarantee, and the auto-add rule.
- `docs/build-plan.md` — Chunk 4 marked `[DONE — see
  docs/changelog/chunk-4-bootstrap.md]`; sub-tasks ticked through and
  rewritten to match what shipped; "Out of scope" expanded to call out
  the stubbed TriggersService.
- `docs/sheet-setup.md` — step 14 now documents that the wizard owns
  everything past the four pre-wizard hand-edits (`bootstrap_admin_email`,
  `session_secret`, `main_url`, `identity_url`); "What the bootstrap
  wizard does" at the bottom rewritten to match shipped behaviour.
- `docs/changelog/chunk-4-bootstrap.md` — this file.

## New open questions

None. The one-shot-wizard decision closes the question the Chunk-3 "Next"
note flagged (whether `ApiBootstrap_*` should refuse post-setup — yes,
unconditionally). No new questions surfaced during implementation.

## Files created / modified

**Created**

- `src/ui/SetupInProgress.html` — "setup in progress" page for non-
  admins during bootstrap.
- `docs/changelog/chunk-4-bootstrap.md` — this file.

**Implemented (replaced 1-line stubs with real code)**

- `src/services/Bootstrap.gs` — state machine + every `ApiBootstrap_*`
  endpoint.
- `src/services/TriggersService.gs` — no-op install stub; real trigger
  creation lands in Chunks 8/9.
- `src/ui/BootstrapWizard.html` — the four-step wizard UI.

**Modified**

- `src/api/ApiShared.gs` — `ApiShared_bootstrap` now runs the setup-
  complete gate before `Router_pick`.
- `src/ui/Styles.html` — added wizard + SetupInProgress CSS.
- `docs/spec.md`, `docs/architecture.md`, `docs/build-plan.md`,
  `docs/sheet-setup.md` — per "Spec / doc edits in this chunk" above.

**Untouched (still 1-line stubs, deferred per build-plan later chunks)**

- `src/repos/RequestsRepo.gs` — Chunk 6.
- `src/services/Expiry.gs`, `src/services/RequestsService.gs`,
  `src/services/EmailService.gs` — Chunks 8/6.
- `src/api/ApiBishopric.gs`, `src/api/ApiStake.gs` — Chunks 5/6.
- `src/ui/bishopric/*`, `src/ui/stake/*`, `src/ui/manager/{Dashboard,
  RequestsQueue, AllSeats, AuditLog}.html` — Chunks 5+.

## Confirmation that the Chunk 4 deferrals list was respected

Per `build-plan.md` Chunk 4 → "Out of scope":

- ✅ Post-setup re-running of the wizard — not possible.
  `Bootstrap_requireBootstrapAdmin_` refuses when
  `setup_complete=TRUE`; the setup-gate in `ApiShared_bootstrap` no
  longer routes to the wizard after the flag flips.
- ✅ Real installation of daily-expiry / weekly-import triggers — not
  done. `TriggersService_install` is a no-op stub; Chunks 8/9 will
  replace it without any change required in `Bootstrap.gs` (interface
  stable: nullary, returns a string).

Other chunks' deferrals remain respected — no Roster, Request,
Removal, or Expiry code touched.

## Manual test walk-through

Mirrors the "demonstrate" list in the chunk-4 prompt:

1. **Fresh sheet, admin sign-in** — clear all config tabs, set
   `setup_complete=FALSE`, `bootstrap_admin_email` to the deployer's
   email. Sign in. Land on Step 1 of the wizard regardless of whether
   the URL carries `?p=mgr/config`, `?p=foo`, etc.
2. **Non-admin sign-in during bootstrap** — sign in with a different
   Google account. Land on `SetupInProgress`, not `NotAuthorized`;
   email displayed; admin email included in the contact hint.
3. **Resume after browser close** — complete Step 1 + add a Building.
   Close the browser. Re-open the Main URL, sign in. Land on Step 3
   (the next incomplete step) — reading from the real tabs.
4. **Complete Setup** — after adding a Ward, click Complete Setup.
   Confirm:
   - `Config.setup_complete` is now `TRUE` (visible in the Sheet).
   - A new `AuditLog` row has `action='setup_complete'`,
     `entity_type='Config'`, `entity_id='setup_complete'`, actor = the
     admin's email, `after_json` carries `triggers_install` message.
   - The admin is redirected to Main `/exec` and lands on the Chunk-1
     Hello page with `manager` role (Chunk 5 replaces this with the
     real dashboard).
5. **Wizard URL refuses post-setup** — navigate back to Main
   `/exec`. Page routes to the normal role-based default, not the
   wizard. Any `ApiBootstrap_*` rpc from the browser console throws
   `Setup is already complete — the bootstrap wizard is one-shot`.
6. **Non-bootstrap-admin calls `ApiBootstrap_*`** — from a signed-in
   non-admin session's browser console, `google.script.run
   .ApiBootstrap_getState(<their token>)` returns `Forbidden: only
   the bootstrap admin can run setup.`
7. **Step-2 delete disables Next** — during the wizard, delete the
   only Building. Step 2's Next button becomes disabled; Complete
   Setup button becomes disabled. Re-add a Building; buttons re-enable.

## Next

Chunk 5 (Rosters, read-only) replaces `ui/Hello.html` with real role-
aware dashboards — bishopric Roster, stake Roster + WardRosters, manager
AllSeats. That chunk deletes `Hello.html` entirely; any deep-links
currently in Hello (the three manager-page anchors) should move into
`ui/Nav.html` which becomes the real role-aware navigation.

The wizard's "redirect to Main URL post-completion" currently lands on
`Hello.html` for the admin. In Chunk 5 the admin will land on the
manager dashboard directly — no code change needed in Bootstrap; the
redirect target (`Config.main_url`) is unchanged, Router_pick just
returns a different template once Chunk 5 wires it up.

No other Chunk-5 prep is needed from this chunk.
