# Chunk 6 — Requests v1 (add flows + queue)

**Shipped:** 2026-04-21
**Commits:** _(see git log; commit messages reference "Chunk 6")_

## What shipped

The full write side of the add-manual / add-temp request lifecycle. A
bishopric or stake principal submits a request from the shared
`ui/NewRequest` page; the active Kindoo Managers get an email; one of
them marks it complete (which atomically flips the Request row to
`complete` AND inserts a matching `Seats` row inside one lock) or
rejects it with a reason; the requester gets an email either way. The
requester can cancel their own pending requests. Managers also get an
inline edit affordance on manual/temp rows in `ui/manager/AllSeats` —
auto rows stay importer-owned.

Implemented:

- **`repos/RequestsRepo.gs`** — full CRUD minus delete. Canonical-email
  lookup on `Requests_getByRequester`; limited-field `Requests_update`
  enforces that only `status` / `completer_email` / `completed_at` /
  `rejection_reason` can change (the rest of a request row is immutable
  once inserted). No `Requests_delete` — cancelled / rejected /
  completed rows persist for audit.
- **`services/RequestsService.gs`** — `submit`, `complete`, `reject`,
  `cancel`. State-machine enforcement: every transition reads the row
  inside the caller's lock and asserts `status==='pending'`, returning
  a clean `"Request is no longer pending (current status: X)"` error on
  a stale attempt. `complete` writes the Seats row + the Request flip
  in one closure and emits two audit rows (one per entity). Action
  vocabulary matches `data-model.md §10`: `submit_request`,
  `complete_request`, `reject_request`, `cancel_request` for Request
  lifecycle events; generic `insert` / `update` for the Seat rows
  touched along the way.
- **`services/EmailService.gs`** — four typed wrappers over
  `MailApp.sendEmail` (`notifyManagersNewRequest`,
  `notifyRequesterCompleted`, `notifyRequesterRejected`,
  `notifyManagersCancelled`). Plain-text bodies; subject lines follow
  the `[Kindoo Access] <verb> …` convention with scope labels for
  inbox triage. Link back: managers → `?p=mgr/queue`, requesters →
  `?p=my`. Display-name uses `Config.stake_name` when set.
- **Global kill-switch** — new `Config.notifications_enabled` boolean
  key (default `TRUE`) consulted by `EmailService_send_` on every
  call. When `FALSE`, logs what would have been sent and returns; no
  `MailApp.sendEmail` call made. Editable from the manager
  Configuration page as a checkbox (not protected, not
  importer-owned). Seeded by `setupSheet` for new installs; existing
  installs get it when re-running `setupSheet`.
- **`api/ApiRequests.gs`** — new file. Consolidated endpoints used by
  both bishopric and stake principals:
  - `ApiRequests_submit(token, draft, scope?)`
  - `ApiRequests_listMy(token, scope?)`
  - `ApiRequests_cancel(token, requestId)`
  - `ApiRequests_checkDuplicate(token, targetEmail, scope?)`
  Scope is always validated against `Auth_requestableScopes(principal)`
  — inferred when the principal holds exactly one request-capable
  role, required otherwise, rejected with `Forbidden` if it's not in
  the allowed set. Every write path wraps the service call in
  `Lock_withLock`; email sends happen outside the lock, best-effort,
  with a `warning` field on the response on failure.
- **`api/ApiManager.gs` extended** — `ApiManager_listRequests(filters)`
  (queue feed; supports ward / type / status filters, attaches
  `duplicate_existing` preview rows to each pending request),
  `ApiManager_completeRequest`, `ApiManager_rejectRequest`,
  `ApiManager_updateSeat` (inline edit; server-side narrowing accepts
  only `person_name` / `reason` / `building_names` / `start_date` /
  `end_date` from the client patch).
- **`core/Auth.gs`** — `Auth_requestableScopes(principal)` returns the
  `[{type, scope, label}]` list of scopes a principal may submit for.
  Order: bishopric-first, then stake. Labels use `Ward <code> — <name>`
  for wards and `Stake Pool` for the stake.
- **`core/Router.gs`** — added `new`, `my`, `mgr/queue` page entries.
  `new` and `my` are the first page-map entries that accept MORE THAN
  ONE role (`roles: ['bishopric', 'stake']`). Added
  `Router_hasAllowedRole_` to match either the old `role:` string or
  the new `roles:` array shape.
- **`ui/NewRequest.html`** — single shared template. Multi-role
  principals see a "Requesting for:" dropdown; single-role see an
  implicit scope label. Client-side duplicate check on target-email
  blur and on scope change, rendered via the shared `rosterRowHtml`
  so the warning preview matches what the manager will see.
- **`ui/MyRequests.html`** — single shared template. Multi-role users
  get a scope filter dropdown (including "All"); single-role users see
  their requests directly. Cancel button on pending rows; rejection
  reason surfaced as a click-to-reveal hint on rejected rows. Status
  row-coloured: pending (white), complete (green tint), rejected (red
  tint), cancelled (muted).
- **`ui/manager/RequestsQueue.html`** — queue cards per pending
  request. Each card shows metadata + a seat-preview row (rendered via
  `rosterRowHtml`, matching the Rosters_mapRow_ shape), + a duplicate
  block rendered inline when the target already has a seat in that
  scope. Complete confirms before firing; Reject prompts for a reason.
  Deep-link filter state via `?p=mgr/queue&ward=CO&type=add_manual`
  (same pattern as Chunk 5's AllSeats).
- **`ui/manager/AllSeats.html` + `ui/ClientUtils.html`** — Chunk-5
  shared roster renderer extended with optional `opts.rowActions` +
  `opts.actionsHeader` so AllSeats can append an Edit button column
  on manual/temp rows only (auto rows get an empty cell). Editing
  opens a modal dialog; Save calls `ApiManager_updateSeat`. The modal
  shows immutable fields (scope, type, email) as read-only inputs for
  context.
- **`ui/Nav.html`** — hidden Chunk-6 links lit up: "New Kindoo Request"
  and "My Requests" for any bishopric OR stake principal, plus
  "Requests Queue" for managers. Dashboard + Audit Log remain hidden
  (Chunk 10).

## Deviations from the pre-chunk spec

- **Consolidated role-specific request pages to shared top-level
  templates.** The Chunk-0 directory structure had
  `ui/bishopric/NewRequest.html` + `ui/stake/NewRequest.html` (and the
  same pair for MyRequests) — four files whose only meaningful
  difference would have been scope, which is derived from the
  principal's roles anyway. Shipped as `ui/NewRequest.html` +
  `ui/MyRequests.html` at the top level. A multi-role user sees a
  single "Requesting for:" dropdown; a single-role user sees an
  implicit scope label. The four old role-specific stub files were
  deleted. Spec: `spec.md §5.1 + §5.2` rewritten to point at the
  shared templates; `architecture.md §3` directory structure updated;
  `architecture.md §8` page map rewritten with `new` / `my` entries
  accepting `bishopric` OR `stake`; `build-plan.md` Chunk 6 sub-tasks
  rewritten.
- **Consolidated request endpoints to `api/ApiRequests.gs`.** The
  pre-chunk plan had parallel `ApiBishopric_submitRequest` /
  `ApiStake_submitRequest` (and the same shape for cancel / listMy /
  checkDuplicate). Shipped as a single consolidated surface
  (`ApiRequests_submit`, `ApiRequests_listMy`, `ApiRequests_cancel`,
  `ApiRequests_checkDuplicate`) that takes an optional `scope`
  parameter. The existing Chunk-5 `ApiBishopric_roster` /
  `ApiStake_*` endpoints are untouched (explicitly out of scope per
  the Chunk-6 prompt). Spec: `architecture.md §12` quick-reference
  table gains a RequestsService row; `architecture.md §3` directory
  structure adds `api/ApiRequests.gs`.
- **Email sends happen OUTSIDE `Lock_withLock`, not inside.** The
  pre-chunk plan (and the build-plan.md text) said "submit … sends
  email, returns request_id" as if the email was part of the service
  call. It's not — `MailApp.sendEmail` is slow (~1-2 s per recipient),
  and holding the script lock for mail I/O would serialise every
  other writer behind a side effect. Shipped as: atomic write + audit
  inside the lock; mail invoked AFTER the closure completes,
  best-effort, with a `warning` field surfaced on the response if a
  send fails. The client renders the warning as `toast('…', 'warn')`
  alongside the success toast. Spec: `spec.md §9` rewritten with the
  best-effort table + link-back columns; `architecture.md §9.5`
  "Email send policy" added as a new section.
- **Action vocabulary for lifecycle events uses the per-verb names.**
  Data-model.md §10 already defined `submit_request`, `complete_request`,
  `reject_request`, `cancel_request` for the Requests tab's lifecycle
  events. Chunk 2's changelog noted it was using the generic
  `insert` / `update` / `delete` for CRUD on config entities. Both are
  correct — generic verbs for Config / Ward / Building / KindooManager
  / Template / Seat CRUD, and the per-verb names for Request
  lifecycle transitions. Seat inserts from a `complete` flow still
  use generic `insert`. No spec change needed; this is how
  data-model.md already reads, just applied here for the first time.
- **Global notifications kill-switch (`Config.notifications_enabled`).**
  Not in the pre-chunk spec — added mid-chunk at the user's request
  to support test / provisioning / triage scenarios where the
  operator needs to stop outbound mail temporarily. Default `TRUE`
  (spec-compliant behaviour). Spec: `spec.md §9` gained a "Global
  kill-switch" paragraph; `data-model.md Tab 1` gained the new Config
  key; `architecture.md §9.5` Email send policy documents it.

## Decisions made during the chunk

- **Self-approval is allowed, no guard.** Per `build-plan.md` Chunk 6
  "Policy (confirmed)" + `open-questions.md R-6`: a manager who
  submits a request (wearing their bishopric / stake hat) sees it in
  the queue and can complete or reject it. The audit trail records
  who submitted and who completed, so the chain of custody is clear
  even when they're the same email. No code guard in the queue UI or
  the handler.
- **Cancel is requester-only.** Even though manager self-approval is
  allowed on Complete / Reject, `RequestsService_cancel` enforces
  that only the original requester may cancel (via `Utils_emailsEqual`
  on `requester_email`). Rationale: cancel is conceptually "I changed
  my mind"; a manager wanting to shut a request down unilaterally
  should Reject with a reason, which also emails the requester.
  Recorded as an inline comment on `RequestsService_cancel`.
- **Scope-resolution helper returns `[]` when the principal has no
  request-capable role, rather than throwing.** `ApiRequests_listMy`
  returns an empty allowed-scopes list + zero rows in that case, so
  the UI can render "You don't have a role that can submit requests"
  without having to handle a `Forbidden` exception. `ApiRequests_submit`
  still throws `Forbidden` in that state (a submit attempt is a
  stronger violation than an incidental page-view).
- **Inline seat edit is modal, not in-row.** Considered an in-row
  editable form (matching Config.html's pattern), decided against it
  because the roster table has too many columns already and the edit
  fields are wide (reason / building_names). A modal keeps the
  roster scannable and the edit UI legible. The modal uses
  `position: fixed` to overlay the whole page; click-outside closes.
- **`Seats_update` throws on auto rows and on immutable-field patches.**
  Belt-and-braces — the UI hides the Edit button on auto rows, and
  the API layer narrows the patch to whitelisted fields — but the
  repo still throws loudly if an auto row or an immutable-field
  patch slips through. A client bug that thinks it's renaming a
  person should surface, not silently succeed. Recorded as an
  inline comment on `Seats_update`.
- **Duplicate check warns, never blocks — on both surfaces.** The
  `NewRequest` client-side check and the `RequestsQueue` manager
  surface both surface duplicates identically. Spec-consistent: two
  scopes could legitimately overlap (a bishopric member who also has
  a stake-pool seat for a separate reason), so blocking the submit
  would be wrong. The manager applies judgment at complete time.
- **Completing a request opens a confirmation dialog with Building
  checkboxes.** Mark Complete on the queue doesn't fire instantly —
  it opens a modal with the request summary and a checkbox group for
  every row in the `Buildings` tab, with the requesting ward's default
  building pre-ticked (nothing pre-ticked for stake-scope). The
  manager adjusts and clicks Confirm; the resulting `Seats.building_names`
  carries exactly the selected list (comma-separated). Server-side
  `RequestsService_complete` accepts an `overrides.building_names`
  argument and validates every listed name against `Buildings_getAll`
  (typo / stale-UI guard); falls back to the ward's default when the
  override is omitted. This supersedes the earlier "silently default
  to the ward's building" behaviour — both the default and the manual
  edit path now live in one UX surface. Per `data-model.md` Tab 8
  ("Defaults to the ward's `building_name` on insert; editable by
  managers"). The pending-card's seat preview also uses the ward
  default so the manager sees what they'll get before the click.
- **Date validation is both client-side and server-side.** Client
  uses `<input type="date">` for the temp-seat dates (native picker,
  ISO YYYY-MM-DD on the wire); server re-parses via
  `RequestsService_isIsoDate_` for defence against a crafted rpc.
  End-date ≥ start-date check is server-side only.
- **Email subject lines are descriptive, not decorative.** No emojis;
  no exclamation marks. Format: `[Kindoo Access] <verb> <who>
  (<scope>)`. Rationale: the emails go to volunteers who also receive
  every other church notification email, so inbox-filterability
  matters more than visual interest. Recorded as inline comments in
  EmailService.
- **Queue shows only pending by default, but `listRequests` takes a
  `state` filter.** The queue page has a State dropdown with two
  options: "Pending" (default) and "Complete (incl. rejected +
  cancelled)". The `state='complete'` server value groups the three
  terminal statuses (`complete`, `rejected`, `cancelled`) — the queue
  UI doesn't need to distinguish them for triage purposes; managers
  care about "what's waiting on me" vs "what's already resolved". A
  future Chunk-10 audit-log page can use the existing `status`
  parameter for exact-status matches. Pending cards render the full
  seat preview + action buttons; terminal cards render a resolver /
  timestamp / rejection-reason summary and no action row. Pending
  view is sorted oldest-first (FIFO); Complete view is sorted
  newest-first (most-recent-at-top — the "what just happened" need).
  Deep-link filter state via `?p=mgr/queue&state=complete&ward=CO`.

## Spec / doc edits in this chunk

- `docs/spec.md` — §5 Page map rewritten: single-template NewRequest /
  MyRequests (scope selector for multi-role); manager queue and inline
  seat edit descriptions aligned with what shipped. §6 Request
  lifecycle rewritten: added the state-machine diagram; called out the
  atomic Requests+Seats write on complete; documented the requester-
  only cancel rule. §9 Email notifications rewritten: table of four
  notifications with subject lines + link-back URLs; "best-effort
  outside the lock" paragraph; global kill-switch paragraph.
- `docs/architecture.md` — §3 Directory structure: moved `ui/bishopric/*`
  and `ui/stake/*` request pages out, added `ui/NewRequest.html` +
  `ui/MyRequests.html` at the top level; added `api/ApiRequests.gs`.
  §8 Page ID map: rewrote Chunk-6 placeholder rows into real entries;
  added the "Multi-role page access" paragraph documenting the
  `{ roles: ['bishopric', 'stake'] }` entry shape and the new
  `Router_hasAllowedRole_`. New §9.5 "Email send policy" section
  (full policy: atomic inside the lock, mail outside, best-effort
  with warning, kill-switch via `notifications_enabled`, link-back
  conventions, from-address discussion). §12 quick reference: added
  `RequestsService` and `EmailService` rows; Auth row now lists
  `Auth_requestableScopes` alongside `Auth_findBishopricRole`.
- `docs/data-model.md` — Tab 1 Config: added `notifications_enabled`
  key (boolean, default TRUE, description of the kill-switch).
- `docs/build-plan.md` — Chunk 6 marked
  `[DONE — see docs/changelog/chunk-6-requests.md]`; sub-tasks
  rewritten to match shipped surface.
- `docs/changelog/chunk-6-requests.md` — this file.

No open-questions.md edits — R-6 (manager self-approval) was already
RESOLVED pre-chunk and the policy matched what shipped. The email
kill-switch is a Chunk-6 addition, not a pre-existing open question.

## New open questions

- **Q-6.1 (P2) — Email body format**: plain text for v1 per decision
  above. HTML with the scope + roster-preview table would be nicer
  for managers who want to triage without opening the app, but has
  compatibility risks with mail clients that render HTML poorly.
  Revisit in a future polish chunk if managers ask for it. Not
  blocking; recorded here and deferred.
- **Q-6.2 (P2) — Queue row ordering**: currently oldest-pending-first
  (FIFO). A manager with 20 backed-up requests might prefer
  scope-grouped ordering (all CO requests together). At current scale
  (1–2 requests/week) ordering is moot; revisit if any manager
  complains.

Neither rises to `open-questions.md` at this stage — both are
UI-polish calls that don't affect data or invariants. Chunk-10
polish pass is the right landing spot if either matters.

## Files created / modified

**Created**

- `src/api/ApiRequests.gs` — consolidated submit / listMy / cancel /
  checkDuplicate endpoints.
- `src/ui/NewRequest.html` — shared submit form for bishopric + stake.
- `src/ui/MyRequests.html` — shared requester-own-list for bishopric
  + stake.
- `docs/changelog/chunk-6-requests.md` — this file.

**Implemented (replaced 1-line stubs with real code)**

- `src/repos/RequestsRepo.gs` — full read-set + `_insert` + limited-
  field `_update`.
- `src/services/RequestsService.gs` — submit / complete / reject /
  cancel.
- `src/services/EmailService.gs` — four typed wrappers + global
  kill-switch.
- `src/ui/manager/RequestsQueue.html` — queue cards + filters +
  Complete / Reject.

**Modified**

- `src/core/Auth.gs` — added `Auth_requestableScopes`.
- `src/core/Router.gs` — added `new`, `my`, `mgr/queue` page entries;
  added `Router_hasAllowedRole_` for multi-role page access.
- `src/repos/SeatsRepo.gs` — added `Seats_getById`,
  `Seats_getActiveByScopeAndEmail`, `Seats_insert` (manual/temp only),
  `Seats_update` (limited-field + auto-row refusal).
- `src/repos/ConfigRepo.gs` — added `notifications_enabled` to
  `CONFIG_TYPED_KEYS_` as boolean.
- `src/services/Setup.gs` — added `notifications_enabled` to the
  seed list (default `true`).
- `src/api/ApiManager.gs` — added `ApiManager_listRequests`,
  `ApiManager_completeRequest`, `ApiManager_rejectRequest`,
  `ApiManager_updateSeat`.
- `src/ui/Nav.html` — unhid Chunk-6 links (New Kindoo Request, My
  Requests, Requests Queue).
- `src/ui/Layout.html` — unchanged at the core; Chunk-6 pages work
  via the same `proceedWithToken` path.
- `src/ui/manager/AllSeats.html` — inline seat edit via a modal
  dialog; Edit button column on manual/temp rows only.
- `src/ui/ClientUtils.html` — `rosterRowHtml` / `renderRosterTable`
  gained optional `rowActions` / `actionsHeader` options.
- `src/ui/Styles.html` — Chunk-6 CSS added (NewRequest / MyRequests
  / RequestsQueue / seat-edit modal / status badges).
- `docs/spec.md`, `docs/architecture.md`, `docs/data-model.md`,
  `docs/build-plan.md` — see "Spec / doc edits in this chunk" above.

**Deleted**

- `src/ui/bishopric/NewRequest.html`
- `src/ui/bishopric/MyRequests.html`
- `src/ui/stake/NewRequest.html`
- `src/ui/stake/MyRequests.html`
  (All four were Chunk-1 one-line stubs; superseded by the
  consolidated top-level templates.)

**Untouched (still 1-line stubs, deferred per build-plan later chunks)**

- `src/services/Expiry.gs` — Chunk 8.
- `src/services/TriggersService.gs` — Chunks 8 / 9.
- `src/ui/manager/Dashboard.html`, `src/ui/manager/AuditLog.html` —
  Chunk 10.

## Confirmation that the Chunk 6 deferrals list was respected

Per `build-plan.md` Chunk 6 → "Out of scope":

- ✅ **Remove requests** — not built. `Requests_insert` + `Requests_update`
  accept `type='remove'` at the schema level (so Chunk 7 doesn't need a
  schema change), but no UI path emits one, and `RequestsService_complete`
  explicitly refuses to handle remove (`"Request type 'remove' is not
  completable in Chunk 6"`). No X/trashcan on roster pages, no
  "removal pending" badge. Chunk 7.
- ✅ **Expiry trigger** — `services/Expiry.gs` still a 1-line stub.
- ✅ **Weekly import trigger** — `services/TriggersService.gs` untouched.
- ✅ **Dashboard / Audit Log pages** — stubs untouched.
- ✅ **Cloudflare Worker** — untouched.
- ✅ **Chunk 5's roster endpoints** — `ApiBishopric_roster` /
  `ApiStake_*` are unchanged; Chunk 6 explicitly did not refactor
  them into the consolidated ApiRequests shape.

## Next

Chunk 7 (Removals) adds the third request type: `remove`. Touch
points:

- **Roster pages** (`bishopric/Roster.html`, `stake/Roster.html`)
  gain an X/trashcan control on manual/temp rows only. Clicking opens
  a "Remove access for [person]? Reason:" modal; submits a `remove`
  Request via the same `ApiRequests_submit` surface (type='remove',
  scope inferred from the row's scope, target_email + target_name
  pre-filled from the row).
- **`RequestsService_complete`** gains a remove branch: instead of
  inserting a Seats row, it deletes the matching one via a new
  `Seats_deleteById` helper. Must be re-entrant with the R-1 race
  (seat already gone → auto-complete the request with a note,
  requester still gets the completion email).
- **"Removal pending" badge** on roster rows: a new
  `Rosters_mapRow_` field or a sibling API shape that lets the
  client mark rows with an outstanding remove request for the same
  (scope, person_email). Reuse `rosterRowHtml` by passing an extra
  opt (same pattern Chunk 6 used for `rowActions`).
- **Queue + MyRequests rendering for remove-type**: update the type
  labels + seat preview to show what's being removed (use the
  existing seat, not a placeholder).

One convention to carry over: the self-approval policy confirmed in
Chunk 6 applies unchanged to remove requests. No additional guards.
Reject-with-reason is still the "manager shuts it down" path for
removes too.

Email timing (outside-lock, best-effort, with warning) applies
unchanged; Chunk 7 adds no new notification types (complete / reject
/ cancel cover remove).

Inline seat edit on AllSeats doesn't need to handle remove flows —
removal goes through the Requests queue, not through AllSeats.
