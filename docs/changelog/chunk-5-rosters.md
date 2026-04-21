# Chunk 5 — Rosters (read-only)

**Shipped:** 2026-04-21
**Commits:** _(see git log; commit messages reference "Chunk 5")_

## What shipped

Read-only roster pages for every role. A bishopric member lands on
`bishopric/roster` and sees only their own ward's seats; the stake
presidency lands on `stake/roster` (stake pool) and can read any ward
via `stake/ward-rosters`; a Kindoo Manager lands on `mgr/seats` — the
full cross-scope roster with ward/building/type filters, deep-link
filter state via URL query params, and per-scope utilization summary
cards above the filtered table. The Chunk-1 `Hello.html` scaffolding
is gone; `ui/Nav.html` is now a real role-aware navigation template
rendered server-side by `Router_pick` alongside page content.

Every roster endpoint enforces scope at the API layer, not the UI. A
bishopric for CO physically cannot read GE's roster by crafting a URL
or calling `ApiBishopric_roster` with a spoofed scope — the scope is
derived from the verified principal via `Auth_findBishopricRole`,
never from a parameter. Stake-only and manager-only users similarly
get `Forbidden` on any endpoint they don't hold the role for.

Implemented:

- **`services/Rosters.gs`** — new file. `Rosters_buildResponseForScope`
  / `Rosters_buildResponseFromSeats_` produce the uniform
  `{ summary, rows }` shape every roster UI renders from; row mapper
  strips internal fields (`source_row_hash`, `created_by`,
  `last_modified_by`) and adds the `expiry_badge` field
  (`'' | 'expired' | 'expires_today'`) so Chunk-5 UIs can flag stale
  temp rows until Chunk 8's expiry trigger deletes them. Sort rule
  (`Rosters_sortRows_`) is shared: auto first (by calling_name), then
  manual (by person_name), then temp (by end_date asc). Utilization
  math counts every row regardless of type (spec-aligned: auto +
  manual + temp all count against the cap, including past-end-date
  temps).
- **`repos/SeatsRepo.gs`** — added `Seats_getAll()` (one
  `getDataRange()` read over the full tab) for `ApiManager_allSeats`;
  the per-scope `Seats_getByScope` already shipped in Chunk 3.
- **`core/Auth.gs`** — added `Auth_findBishopricRole(principal)`:
  returns the first `{type:'bishopric', wardId}` role on the
  principal, or `null`. Used by `ApiBishopric_roster` so the endpoint
  doesn't accept a ward-scope parameter at all (scope is always the
  role's `wardId`, verified from the HMAC-signed token).
- **`api/ApiBishopric.gs`** — `ApiBishopric_roster(token)`: verifies
  the principal, looks up the bishopric role, returns that ward's
  roster via `Rosters_buildResponseForScope`. Non-bishopric callers
  (including managers or stake users without a bishopric role) get
  `Forbidden: bishopric role required`.
- **`api/ApiStake.gs`** — `ApiStake_roster` (scope hard-coded to
  `'stake'`), `ApiStake_wardRoster(wardCode)` (validates the
  ward_code exists), and `ApiStake_wardsList` (dropdown feed:
  `{ ward_code, ward_name }[]`). All three require `stake` role via
  `Auth_requireRole`.
- **`api/ApiManager.gs`** — `ApiManager_allSeats(token, filters)`:
  reads every seat once via `Seats_getAll`, applies the three
  filters as AND, buckets by scope, returns a flat row list + an
  array of per-scope summaries (stake first, wards alphabetical) +
  filter-option lists (wards, buildings) so the UI renders the
  filter dropdowns without a second rpc. Extended the runnable
  `ApiManager_test_forbidden` with scope-guard checks (see "Manual
  test" below).
- **`core/Router.gs`** — rewritten. Single `ROUTER_PAGES_` lookup
  table replaces the Chunk-3 `managerPages` map; covers every
  shipped bishopric / stake / manager page. Each entry declares the
  role required, so role mismatch and unknown `?p=` both fall back
  to `Router_defaultPageFor_(principal)`. Priority on multi-role
  principals: manager > stake > bishopric. Also returns `navHtml`
  (rendered from `ui/Nav` with the principal and `current_page`) so
  `Layout.html` renders nav alongside page content.
- **`api/ApiShared.gs`** — `ApiShared_bootstrap` now propagates
  `navHtml` from `Router_pick`; wizard/SetupInProgress paths return
  empty `navHtml`.
- **`core/Main.gs`** — forwards query params (minus reserved `p` /
  `token`) to Layout as a JSON blob so deep-link filter state on
  `mgr/seats` survives the iframe-can't-read-top-frame-URL
  cross-origin restriction.
- **`ui/Nav.html`** — real template. Renders only links for roles
  the principal holds; highlights the current page via
  `class="nav-link active"`; rewires each `data-page` anchor to
  `MAIN_URL + ?p=<page>` client-side. Links for unbuilt chunks (new
  request / my requests / requests queue / dashboard / audit log)
  are deliberately omitted so clicking a nav entry never lands on a
  broken page.
- **`ui/Layout.html`** — added `#nav-host` slot between topbar and
  main, plus a sign-out button (`#signout-btn`) in the topbar's
  right-hand area. Boot flow renders navHtml (with
  rehydrateScripts), shows/hides the sign-out button based on
  principal presence, and clears `sessionStorage.jwt` on sign-out
  click. Exposes `QUERY_PARAMS` global for pages that need deep-link
  state.
- **`ui/ClientUtils.html`** — added shared helpers: `escapeHtml`,
  `renderUtilizationBar(summary)`, `rosterRowHtml(row, opts)`, and
  `renderRosterTable(rows, opts)`. Every roster UI (bishopric, stake,
  stake WardRosters, manager AllSeats) renders through these so
  column ordering, badge classes, and row sorting stay identical.
- **`ui/bishopric/Roster.html`** — bishopric ward roster + utilization
  bar + empty state. One `rpc('ApiBishopric_roster')` call; renders
  into the shared helpers.
- **`ui/stake/Roster.html`** — stake pool roster; same shape as
  bishopric via shared helpers.
- **`ui/stake/WardRosters.html`** — dropdown of every ward from
  `ApiStake_wardsList`, on change fetches `ApiStake_wardRoster` and
  renders. Server-side rejection of unknown ward_code surfaces as a
  red error block in the table host.
- **`ui/manager/AllSeats.html`** — full roster with ward / building /
  type filters; per-scope summary cards above the filtered table;
  deep-link state hydration from `QUERY_PARAMS`. Sticky table header;
  truncate-with-tooltip on email columns for narrow viewports.
- **`ui/Styles.html`** — Chunk-5 CSS added: nav host + active link
  highlight, sign-out button in topbar, utilization bar (blue /
  amber near-cap / red over-cap), roster table row colouring by
  type, type / expired / expires-today badges, AllSeats filter row,
  summary-card grid. Removed the now-unused `.scaffold-links` block
  from Chunk 1.
- **`ui/Hello.html`** — deleted. Router no longer references it.

## Deviations from the pre-chunk spec

- **Role labels in Nav are role-prefixed unconditionally.** Pre-chunk
  docs implied "Roster" as the label for both bishopric and stake
  users; a dual bishopric+stake user would see two entries both
  labelled "Roster" and have no way to tell which is which. Nav now
  uses "Ward Roster" / "Stake Roster" / "Ward Rosters" even for
  single-role users (costs nothing, screenshots read the same
  regardless of the viewer's role). Spec: none — this is purely UI
  copy, not a protocol change.
- **Page IDs are role-prefixed.** The architecture.md §8 table had
  `roster` / `new` / `my` as role-agnostic page ids that Router was
  to resolve to "the right role's template". Ship-time version uses
  explicit `bishopric/roster`, `stake/roster`, `stake/ward-rosters`
  (plus the manager `mgr/*` entries that were already prefixed). The
  ambiguity cost of the role-default IDs — which roster does a
  multi-role user land on for `?p=roster`? — outweighed the URL
  brevity. Spec: `architecture.md` §8 page-id map rewritten; reserved
  entries for Chunk-6/10 pages flagged with *(Chunk N)* parentheticals.
- **Manager default landing is `mgr/seats` until Chunk 10.** The spec
  has Dashboard (`mgr/dashboard`) as the manager's first-page target;
  it lands in Chunk 10. Until then, a manager's default is
  `mgr/seats` — the single most-useful manager page in the Chunk-5
  state (auditable, shows over-cap, supports deep links). Swap the
  default in `Router_defaultPageFor_` when Chunk 10's Dashboard
  ships. Spec: `architecture.md` §8 default landing row notes the
  interim.
- **Filter state survives deep-link in, but URL does not update on
  filter change.** The HtmlService iframe runs on
  `*.googleusercontent.com`; the top frame runs on
  `script.google.com`; cross-origin restrictions prevent the
  iframe from calling `window.top.history.replaceState`. So
  `?p=mgr/seats&ward=CO&type=manual` correctly pre-populates the
  filters on page load (Main.doGet forwards the query params to
  Layout's `QUERY_PARAMS` global), but changing a filter after load
  does not rewrite the address bar. Deep-link-sharing still works;
  copy-current-view does not. Acceptable trade-off at current scale;
  spec: `architecture.md` §8 Deep links bullet rewritten. Flagged in
  build-plan Chunk 5 "Out of scope" so nobody files a bug for it.

## Decisions made during the chunk

- **Roster row shape drops internal fields** — `source_row_hash`,
  `created_by`, `last_modified_by` are omitted from the wire shape.
  They're diagnostic / infrastructure columns the UI doesn't need; the
  shape stays small and obviously-UI-oriented. `Rosters_mapRow_` is
  the single place where this decision lives; Chunk 6+ roster-edit
  endpoints can mirror it.
- **`Rosters_mapRow_` computes `expiry_badge` server-side** rather
  than letting the client compare `end_date` to "today". Reason:
  "today" in the client is the user's browser tz; "today" on the
  server is the sheet's `Session.getScriptTimeZone()`. For a stake
  spanning a single time zone the difference is zero, but computing
  the badge server-side means the badge matches the tz Chunk-8's
  expiry trigger will use, so the UI can't ever disagree with the
  trigger that just ran.
- **Utilization math counts every row regardless of type.** The
  Chunk-5 prompt called this out specifically; implementation does
  `total = rows.length` unconditionally. Past-end-date temp rows
  count until Chunk 8 deletes them (the `expired` badge tells the
  user why the number is high).
- **`ApiManager_allSeats` returns per-scope summaries on the
  filtered view**, not on the unfiltered total. So filtering to
  `type=auto` shows a proportionally small utilization — that
  reflects the filtered data the manager is looking at, not the
  tab's true over-cap state. Header-level over-cap alerts
  belong on the Dashboard (Chunk 10), not here. Flagged in a
  comment on `ApiManager_allSeats`.
- **Nav is rendered server-side by `Router_pick`, returned as
  `navHtml` alongside `pageHtml`.** Alternative (client-side
  rendering from `principal.roles`) would have been simpler but
  would lose SSR benefits — role-appropriate nav shows immediately
  on page load rather than flashing empty. Router does it once per
  page change, which is the rhythm nav updates anyway (active link
  highlight tracks `current_page`).
- **Sign-out lives in the topbar (Layout), not Nav.** The prompt
  said "Sign-out link (top-right)" which matched Layout's topbar
  right-hand side. Sign-out is always present whenever the user is
  signed in (not just when they have roles), so rendering it in
  Layout avoids the edge case where a no-roles principal lands on
  NotAuthorized (no nav) with no way to sign out.
- **`Router_defaultPageFor_`'s manager default is a single page, not
  a "pick the first reachable page" policy.** The code path is
  deliberately dumb: highest-privilege role determines the default
  landing, and that mapping is `manager → mgr/seats`. No fallback
  logic. When Dashboard ships in Chunk 10 the constant flips in one
  place.

## Spec / doc edits in this chunk

- `docs/architecture.md` — §3 directory structure: added
  `services/Rosters.gs`. §8 HTML & routing: rewrote the Role-based
  menus + Deep links bullets to reflect server-rendered Nav and the
  cross-origin-iframe URL restriction; rewrote the Page ID map to
  use role-prefixed ids and annotate future-chunk entries; added a
  new "Role-scoped reads" subsection documenting the API-layer scope
  enforcement pattern. §12 What-lives-where: added `services/Rosters.gs`,
  `ui/ClientUtils.html`'s shared renderer, and `ui/Nav.html`.
- `docs/build-plan.md` — Chunk 5 marked
  `[DONE — see docs/changelog/chunk-5-rosters.md]`; sub-tasks
  rewritten to match shipped surface (Rosters service, scope-guard
  tests, sign-out button, QUERY_PARAMS pass-through); acceptance
  criteria expanded with the specific verification each one tests;
  "Out of scope" gained the post-load-URL-no-reflect and
  silent-forbidden-fall-through items.
- `docs/changelog/chunk-5-rosters.md` — this file.

## New open questions

None. The filter-URL-reflect limitation and the "redirect with toast"
polish are both flagged in build-plan Chunk 5 "Out of scope" and
Chunk 10 respectively — not open questions so much as accepted
Chunk-5 scope boundaries.

## Files created / modified

**Created**

- `src/services/Rosters.gs` — shared roster shape + utilization
  math.
- `docs/changelog/chunk-5-rosters.md` — this file.

**Implemented (replaced 1-line stubs with real code)**

- `src/api/ApiBishopric.gs` — `ApiBishopric_roster`.
- `src/api/ApiStake.gs` — `ApiStake_roster`, `ApiStake_wardRoster`,
  `ApiStake_wardsList`.
- `src/ui/bishopric/Roster.html` — ward roster UI.
- `src/ui/stake/Roster.html` — stake roster UI.
- `src/ui/stake/WardRosters.html` — ward-rosters dropdown + viewer.
- `src/ui/manager/AllSeats.html` — full roster with filters.
- `src/ui/Nav.html` — real role-aware navigation template
  (replaced the Chunk-1 stub).

**Modified**

- `src/core/Auth.gs` — added `Auth_findBishopricRole`.
- `src/core/Router.gs` — rewritten with full Chunk-5 page map,
  role-default picker, Nav rendering. Dropped Hello.html branch.
- `src/core/Main.gs` — forwards query params to Layout as
  `query_params` template var (Chunk-5 deep-link state).
- `src/api/ApiShared.gs` — propagates `navHtml` through the
  bootstrap response.
- `src/api/ApiManager.gs` — added `ApiManager_allSeats`; extended
  `ApiManager_test_forbidden` with Chunk-5 scope-guard checks.
- `src/repos/SeatsRepo.gs` — added `Seats_getAll()`; doc header
  amended for Chunk-5's read-side entry.
- `src/ui/Layout.html` — added `#nav-host` slot, sign-out button,
  `QUERY_PARAMS` global; boot flow now renders navHtml and manages
  sign-out visibility.
- `src/ui/ClientUtils.html` — added `escapeHtml`,
  `renderUtilizationBar`, `rosterRowHtml`, `renderRosterTable`.
- `src/ui/Styles.html` — added Chunk-5 CSS (nav, sign-out,
  utilization bars, roster table, badges, AllSeats filter + summary
  cards); removed the defunct `.scaffold-links` block.
- `docs/architecture.md`, `docs/build-plan.md` — per "Spec / doc
  edits in this chunk" above.

**Deleted**

- `src/ui/Hello.html` — Chunk-1 scaffolding; role-aware dashboards
  replaced it.

**Untouched (still 1-line stubs, deferred per build-plan later chunks)**

- `src/repos/RequestsRepo.gs` — Chunk 6.
- `src/services/Expiry.gs`, `src/services/RequestsService.gs`,
  `src/services/EmailService.gs` — Chunks 8/6.
- `src/ui/bishopric/{NewRequest, MyRequests}.html`,
  `src/ui/stake/{NewRequest, MyRequests}.html` — Chunk 6.
- `src/ui/manager/{Dashboard, RequestsQueue, AuditLog}.html` —
  Chunks 10/6/10.

## Confirmation that the Chunk 5 deferrals list was respected

Per `build-plan.md` Chunk 5 → "Out of scope":

- ✅ Request submission — not built. `ApiBishopric_*` /
  `ApiStake_*` have only read endpoints; no `submitRequest`, no
  `checkDuplicate`, no `cancelRequest`. Chunk 6.
- ✅ Removal actions via X/trashcan on Roster — not built. The
  Chunk-5 `Roster.html` templates render rows read-only; no remove
  button or "removal pending" badge. Chunk 7.
- ✅ Manager inline Seat edits — not built. `AllSeats.html` renders
  a read-only table; no per-row edit form, no `ApiManager_seatsUpsert`
  endpoint. Chunk 6 / 7.
- ✅ Server-side pagination — not added. `AllSeats.html` renders
  every row in one table (sticky header); `Seats_getAll` does one
  `getDataRange` read. Target scale fits; architecture.md §1
  confirms pagination is deferred unless scale shifts >5×.

Other chunks' deferrals remain respected — no Request, Removal,
Expiry, or Trigger code touched in this chunk.

## Manual test walk-through

Mirrors the "demonstrate" list in the chunk-5 prompt. Each proof below
has a quick verify step.

1. **Bishopric sees only their own ward.** Seed `Access` with a
   bishopric row for `CO` for the test user; sign in; land on
   `bishopric/roster`. Table renders only CO rows.
2. **Bishopric Forbidden on stake/other-ward.** From the same session's
   browser devtools console:
   `google.script.run.withSuccessHandler(console.log).withFailureHandler(console.log).ApiStake_roster(sessionStorage.jwt)`
   → error `Forbidden`. Visiting `?p=stake/roster` silently
   redirects to `bishopric/roster` (the role default).
3. **Stake → any ward.** Seed `Access` with `scope=stake` for the
   test user; sign in; visit `stake/ward-rosters`. Dropdown lists
   every ward from the Wards tab; picking one renders that ward's
   roster. `ApiStake_wardRoster(token, 'XX')` where XX isn't in
   Wards throws `Unknown ward: XX`.
4. **Manager AllSeats filter combinations.** Add the test user to
   `KindooManagers` with `active=TRUE`; visit `mgr/seats`. Set
   ward=`CO` + type=`manual` — only CO's manual seats show; summary
   card shows `CO` with its filtered utilization.
5. **Deep link pre-populates filters.** Visit
   `<MAIN_URL>?p=mgr/seats&ward=CO&type=manual` fresh (no prior
   state). Both filter selects show their deep-link values and the
   table renders the filtered view on first paint.
6. **Utilization bar.** Configure Ward CO with `seat_cap=20` and add
   seats via the importer or by hand in the Sheet. 18 seats → blue
   bar at 90% with `18 / 20 seats used`. 21 seats → red bar at 100%
   width with `21 / 20 seats used — OVER CAP`.
7. **Temp expiry badge.** Hand-insert a `Seats` row with
   `type=temp`, `end_date=<yesterday>`, `scope=CO`. Visit
   `bishopric/roster`; row shows an `expired` badge in the Type
   column. A row with `end_date=<today>` shows `expires today`.
8. **Nav highlights current page; hides unbuilt.** Manager nav shows
   exactly: All Seats, Configuration, Access, Import. No Dashboard,
   no Requests Queue, no Audit Log. Active tab matches the current
   `?p=`.
9. **Hello.html is gone.** `src/ui/Hello.html` no longer exists;
   visiting `/exec` with no `?p=` for a manager lands on
   `mgr/seats` (not a 404). For a stake user, `/exec` lands on
   `stake/roster`; for a bishopric user, `bishopric/roster`.
10. **Post-bootstrap landing.** Re-run the bootstrap wizard on a
    fresh sheet end-to-end. `ApiBootstrap_complete` redirects to
    `Config.main_url`; the admin lands on `mgr/seats` (since the
    auto-add step made them a manager).
11. **Sign-out.** Click sign-out in the topbar. `sessionStorage.jwt`
    is cleared; top re-navigates to bare `MAIN_URL`; Login page
    renders again.
12. **Forbidden-path tests runnable.** From the Apps Script editor's
    Run dropdown or the Kindoo Admin menu (Setup.gs `onOpen`), run
    `ApiManager_test_forbidden`. Execution log ends with
    `All ApiManager forbidden-path checks passed.` — includes the
    Chunk-5 additions (`Auth_findBishopricRole(stake-only)` returns
    null; CO bishopric fails stake role check; CO bishopric fails
    ward-scope check for GE; CO bishopric passes ward-scope check
    for CO).

## Next

Chunk 6 (Requests v1) adds the write side of the seat-management
flow: add_manual / add_temp submission from bishopric + stake roster
pages, My Requests with cancel, manager Requests Queue with
Complete / Reject. That chunk:

- **Implements `repos/RequestsRepo.gs`** (full CRUD) and
  `services/RequestsService.gs` (submit / complete / reject / cancel,
  all wrapped in `Lock_withLock` with one AuditLog row each).
- **Adds `services/EmailService.gs`** (typed wrappers over
  `MailApp.sendEmail`) for the four notifications (manager on submit,
  requester on complete, requester on reject, manager on cancel).
- **Lights up the hidden nav links**: `bishopric/new` + `bishopric/my`,
  `stake/new` + `stake/my`, `mgr/queue`. Nav already has the
  `principal.roles.indexOf(...)` skeleton for these — just uncomment
  / add the `__navLink` calls.
- **Reuses Chunk-5 roster shape + `Rosters_*` helpers** for the
  duplicate-check preview: when a bishopric member submits a request
  for an email that already has an active seat, the client surfaces
  a warning using the same row renderer (`rosterRowHtml`) so the
  preview matches what the manager will see on the Requests Queue.

One convention to carry over: every write path uses the Chunk-2
shape (`Auth_principalFrom → Auth_requireRole → Lock_withLock(repo
write + AuditRepo_write)` inside one closure), and all per-row audit
`actor_email` values are the verified principal's email (never
`Session.*`). Chunk-5 adds no new actors; Chunk 6 is the next human
write surface.

The `Rosters_mapRow_` shape is the contract the Chunk-6 Requests
Queue should also return for any "seat preview" on a complete
action, so the queue UI can render rows using the same
`rosterRowHtml`. Keep the field set and the `expiry_badge` semantics
identical.
