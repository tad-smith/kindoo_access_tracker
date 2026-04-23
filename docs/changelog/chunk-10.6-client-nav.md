# Chunk 10.6 — Client-side navigation (SPA-style)

**Shipped:** 2026-04-22
**Commits:** _(see git log; commit messages reference "Chunk 10.6")_

## What shipped

The initial `ApiShared_bootstrap` rpc now returns every role-allowed
page's HTML pre-rendered in a `pageBundle: {pageId → pageHtml}` map.
The `Layout.html` shell stashes it; intra-app nav-link clicks are a
pure client-side lookup against the bundle — zero rpc per tab click,
zero re-render of the shell. Browser back/forward work via
`history.pushState` / `popstate` inside the iframe.

The only server round-trip per tab click is the page's own data rpc
(`ApiManager_dashboard`, `ApiManager_allSeats`, etc.) inside its init
fn — and that runs AFTER the HTML is already on screen, so the user
sees a "Loading …" placeholder in the content area rather than a
blank pause.

Also folded in: Dashboard card reorder (row 1 Pending + Utilization;
row 2 Warnings + Recent Activity; row 3 Last Operations).

## What did NOT ship

An earlier draft of Chunk 10.6 added an `ApiShared_renderPage(token,
pageId, queryParams)` rpc that re-rendered page HTML server-side on
every nav click. Measuring it showed the swap was still felt as a ~1s
pause per click — that's the baseline `google.script.run` transport
round-trip, independent of how trivial the handler is. Shipping
that endpoint would have been a speed win over the pre-chunk
full-doGet path, but it missed the real architectural mismatch: the
page HTML is static and there was no reason to re-render it on the
server per click. Dropped entirely; not in the final commit.

Related cleanup: the `.nav-loading-bar` progress indicator that
covered the earlier draft's rpc latency is also gone — swaps are now
fast enough (single-digit-millisecond) that an indicator isn't needed
and would just flash.

### Server — `core/Router.gs#Router_buildPageBundle(principal)` (new)

Walks `ROUTER_PAGES_`, filters each entry through the existing
`Router_hasAllowedRole_`, and renders each allowed entry's HTML via
`HtmlService.createTemplateFromFile(entry.template).evaluate().getContent()`.
Returns `{pageId → pageHtml}`. Role-gating is enforced server-side at
bundle-build time — a bishopric user's bundle doesn't contain manager
pages, so even a hand-crafted `data-page="mgr/seats"` link can't
surface HTML the user isn't entitled to. (Manager pages still enforce
their own role checks at the API layer; the bundle filter is a
defense-in-depth layer, not a replacement.)

Returns `{}` for no-roles principals. Bootstrap wizard + SetupInProgress
are pre-role-resolution surfaces and never reach here.

### Server — `api/ApiShared.gs#ApiShared_bootstrap` (extended)

Adds a `pageBundle` field to the response, built by
`Router_buildPageBundle(principal)` on the normal (setup-complete,
has-roles) path. Empty `{}` on the bootstrap-wizard / setup-in-progress
branches (those surfaces don't have intra-app nav).

Cost: one additional `Router_buildPageBundle` call on every bootstrap.
At the 12-page `ROUTER_PAGES_` menu that's ~50-150ms of additional
server time and a few tens of KB more on the wire (gzipped). Acceptable
at target scale — the alternative was paying ~1s per nav click for the
life of the session.

No other endpoints changed. `ApiShared_bootstrap`'s existing contract
(principal, pageModel, pageHtml, navHtml, template) is unchanged
except for the added field.

### Shell — `ui/Layout.html`

State carried across intra-app swaps:

- `currentPageId` — last-rendered pageId; keys teardown and
  nav-active.
- `currentPrincipal` — the bootstrap-time principal, reused to build
  `pageModel` on every swap (`{principal, current_page: pageId}` —
  identical to what `Router_pick` produces server-side).
- `pageBundle` — the `{pageId → pageHtml}` map from bootstrap.
- `navReady` — flips true once the initial render finishes; guards
  the click and popstate handlers against pre-render clicks.

The delegated click handler on `document` catches `a[data-page]`
anchors:

- Modifier-clicks (cmd / ctrl / shift / alt) and non-primary buttons
  skip interception so "open in new tab" works.
- `parseHrefParams` extracts the query string from the anchor's
  `href` (minus `p` and `token` — same strip set `Main.doGet` applies).
- `navigateTo(pageId, parseHrefParams(href))` runs the swap.

`navigateTo` — **synchronous, no rpc**:

1. Look up `pageBundle[pageId]`. If missing (shouldn't happen in
   normal operation — would require a stale bundle after a
   mid-session role change), toast and fall back to a full
   top-frame reload.
2. Call the outgoing page's `window.page_<X>_teardown` if defined.
3. `innerHTML`-replace `#content`. `rehydrateScripts` re-runs each
   page's inline `<script>`, re-defining `window.page_<X>_init` on
   `window`.
4. Update `window.QUERY_PARAMS` for pages still reading the
   Chunk-5-era global.
5. `history.pushState({pageId, queryParams}, '', '?p=<pageId>&...')`
   unless `opts.skipPushState`.
6. Toggle the `active` class on every `a[data-page]` link to match.
7. Call `window.page_<X>_init(pageModel, queryParams)`.

A `window.addEventListener('popstate', …)` re-runs `navigateTo` with
`{skipPushState: true}` so back/forward don't double-push.

### Initial bootstrap path

`showContent` is called with the bootstrap response, including the
bundle. It:

1. Injects `pageHtml` into `#content`, rehydrates scripts.
2. Shows `navHtml` in `#nav-host`.
3. Stashes `currentPrincipal`, `currentPageId`, `pageBundle`.
4. Flips `navReady = true`.
5. `history.replaceState({pageId, queryParams}, '', window.location.href)`
   so the first back-button press has a state object.
6. Calls the initial page's init fn — same entry point as the swap path.

### Per-page init-function convention

Unchanged from the earlier draft of Chunk 10.6:

- Every page template exports `window.page_<pageId>_init(pageModel,
  queryParams)`. PageId → fn-name rule: replace every `/` and `-` with
  `_`, prefix `page_`, suffix `_init`. (Hyphens aren't valid in JS
  identifiers; `stake/ward-rosters` → `page_stake_ward_rosters_init`.)
- Optional `window.page_<pageId>_teardown` runs before the next swap.
- Shell calls both from `callPageInit` / `callPageTeardown`, which
  no-op when the function isn't defined.

The 12 page templates now in init-fn form:

| Page template | pageId | init fn | teardown |
| --- | --- | --- | --- |
| `ui/manager/Dashboard.html` | `mgr/dashboard` | `page_mgr_dashboard_init` | — |
| `ui/manager/AllSeats.html` | `mgr/seats` | `page_mgr_seats_init` | — |
| `ui/manager/RequestsQueue.html` | `mgr/queue` | `page_mgr_queue_init` | — |
| `ui/manager/Config.html` | `mgr/config` | `page_mgr_config_init` | — |
| `ui/manager/Access.html` | `mgr/access` | `page_mgr_access_init` | — |
| `ui/manager/Import.html` | `mgr/import` | `page_mgr_import_init` | — |
| `ui/manager/AuditLog.html` | `mgr/audit` | `page_mgr_audit_init` | — |
| `ui/NewRequest.html` | `new` | `page_new_init` | `page_new_teardown` |
| `ui/MyRequests.html` | `my` | `page_my_init` | — |
| `ui/bishopric/Roster.html` | `bishopric/roster` | `page_bishopric_roster_init` | — |
| `ui/stake/Roster.html` | `stake/roster` | `page_stake_roster_init` | — |
| `ui/stake/WardRosters.html` | `stake/ward-rosters` | `page_stake_ward_rosters_init` | — |

`NewRequest` has a teardown because its duplicate-check debounce is a
`setTimeout` at module scope; cancelling it prevents a pending blur
handler from firing `checkDuplicate()` into a torn-out DOM. Every
other page's listeners are attached to elements inside `#content` and
get garbage-collected with the DOM on the next swap.

Pages with URL-driven filter state — `AllSeats`, `RequestsQueue`,
`AuditLog` — re-seed their filter state from the init-arg
`queryParams` on every entry. Re-entering the page from an in-app
deep-link (e.g. Dashboard → AllSeats?ward=CO) lands on the right
filters, matching direct-load behaviour.

### Dashboard / Import `data-page` attributes

Dashboard's five deep-link anchor sites (pending → `mgr/queue`,
recent-activity → `mgr/audit`, utilization → `mgr/seats`, warnings →
`mgr/seats`, "view queue" / "full audit log" footers) gained
`data-page="<pageId>"`. Import's over-cap banner "View seats →" link
gained `data-page="mgr/seats"`. The href stays as the right-click /
middle-click fallback; the shell intercepts normal clicks.

### Dashboard card reorder (2026-04-22)

Folded in at user request: (pending, utilization, warnings, recent,
ops). On a two-column desktop grid this lands as row 1 Pending +
Utilization, row 2 Warnings + Recent Activity, row 3 Last Operations.
Rationale: the two action-driving cards (pending queue + over-cap
warnings) cluster on the left; the two glanceable-state cards
(utilization + recent activity) on the right; rarely-read "Last
Operations" timestamps land at the bottom. No `ApiManager_dashboard`
wire-shape change.

### Out-of-scope pages

`BootstrapWizard`, `SetupInProgress`, and `NotAuthorized` were not
refactored. They're rendered outside the normal nav flow (via
bootstrap's `pageHtml` field on the bootstrap/setup/no-roles branches;
`pageBundle` is empty for those). They don't need init-fn treatment —
the shell's `callPageInit` is a no-op when the function isn't defined.

## Deviations from the pre-chunk spec

- **No `ApiShared_renderPage` endpoint.** The pre-chunk spec added one;
  it was dropped in favour of bundling every allowed page's HTML into
  the bootstrap response. Intra-app nav is pure client-side. Spec:
  architecture.md §8.5 rewritten around `pageBundle`.
- **Shell lives in `Layout.html`, not `ClientUtils.html`.** Pre-chunk
  architecture.md §8.5 said "Shell swap — `ui/ClientUtils.html`
  additions". `ClientUtils.html` stays focused on cross-page helpers
  (`rpc`, `toast`, render helpers); putting the shell there would have
  split the Layout-DOM-manipulating code across two files. Spec:
  architecture.md §8.5 "Shell swap" heading updated.
- **Teardown is a sibling function on `window`, not a return value
  from init.** Pre-chunk spec said `function <pageId>_init(pageModel)
  { …; return teardownFn?; }`. Using a separate
  `window.page_<pageId>_teardown` avoids the ambiguity of "what if
  init's return value is something else" and keeps the two surfaces
  symmetric. Spec: architecture.md §8.5 "Per-page init-function
  convention" updated.
- **Init-fn names are prefixed `page_`.** Pre-chunk spec said pageId
  `mgr/seats` → `mgr_seats_init`. The `page_` prefix namespaces init
  fns on `window` so they can't collide with unrelated library fns.
  Spec: architecture.md §8.5 updated.
- **Hyphens in pageId normalise to `_` too.** Pre-chunk spec said
  "replace `/` with `_`". The only hyphenated pageId is
  `stake/ward-rosters` and JS function names can't contain hyphens, so
  the normaliser replaces both `/` and `-`. Spec: architecture.md §8.5
  updated.
- **Pages don't use event delegation on stable parents.** Pre-chunk
  spec called delegation on `#content` "the default pattern". Every
  existing page already attaches listeners directly to its own
  elements, which live inside `#content` and get GC'd on swap — same
  guarantee, simpler code. Kept the existing pattern. Spec:
  architecture.md §8.5 "Memory-leak discipline" rewritten to match.

## Decisions made during the chunk

- **Bundle all role-allowed pages at bootstrap, not on-demand.** Two
  alternative designs were on the table: (a) cache HTML client-side
  after first fetch (first-visit-per-tab still pays a rpc), (b) bundle
  all up-front (current shape — heavier bootstrap, zero per-click).
  User picked (b) after seeing the rpc-per-click approach feel slow.
  At target scale the up-front cost is small, and every tab click is
  instant for the rest of the session.
- **Role-gating at bundle-build time is the authorization boundary.**
  A hand-crafted `data-page="mgr/seats"` on a bishopric user's session
  can't surface manager HTML because the bundle doesn't contain it.
  The page's own API endpoints still enforce their role checks — the
  bundle filter is defense-in-depth, not the primary guard.
- **No loading indicator on swap.** With the client-side bundle, a
  swap is single-digit-millisecond. An indicator would flash too
  briefly to be useful and would distract. The init fn's own data rpc
  still shows a "Loading …" placeholder in the content area — that's
  the right surface for "something is happening", and it renders after
  the HTML is already on screen (no blank pause).
- **Stale bundle on mid-session role change is accepted.** Role
  changes require an LCR change + an import run, which imply a reload
  anyway. Not worth a re-bundle endpoint for a sub-weekly event.
- **Dashboard card reorder folded into this chunk.** Dashboard.html
  was already being touched for the init-fn refactor; landing the
  reorder in the same commit avoids a second touch on the same file.
- **No measured-latency target.** Chunk 10.5 set the precedent that
  qualitative feel is an acceptable shipping signal. The before/after
  here is obvious — every nav click becomes instant. The
  `[measure] bootstrap for page=... took Nms` log line is emitted on
  every bootstrap for operators who want numbers.

## Spec / doc edits in this chunk

- `docs/spec.md` — no changes. No user-visible behaviour change beyond
  faster nav; the page map, request lifecycle, and every user-facing
  contract are unchanged.
- `docs/architecture.md` — §8 extended with the pageBundle shape and
  role-gating note; §8.5 rewritten around bundle-at-bootstrap + pure
  client-side navigation.
- `docs/data-model.md` — no changes.
- `docs/open-questions.md` — no new entries; no ambiguities surfaced.
- `docs/build-plan.md` — Chunk 10.6 marked `[DONE — see …]` and the
  sub-task checkboxes flipped.

## Deferred

Respected the Chunk-10.6 "Do NOT drift into" list:

- Cloudflare Worker → Chunk 11.
- Prefetch on hover / predictive loading → not planned.
- Service Worker / offline capability → not planned.
- Route-level code splitting → not planned (pages are small).
- Animated transitions between pages → not planned.
- Server-side changes beyond `Router_buildPageBundle` + the
  `pageBundle` field on bootstrap → none made.

## Files created / modified

**New:**
- `docs/changelog/chunk-10.6-client-nav.md`

**Modified:**
- `src/core/Router.gs` — added `Router_buildPageBundle`.
- `src/api/ApiShared.gs` — `ApiShared_bootstrap` returns `pageBundle`;
  `ApiShared_renderPage` removed.
- `src/ui/Layout.html` — shell state (`pageBundle`, `currentPrincipal`,
  etc.), delegated click handler, synchronous `navigateTo`,
  `popstate` handler, init-fn invocation.
- `src/ui/Nav.html` — click-handler fallback removed (delegated
  interceptor handles it); docstring updated.
- `src/ui/Styles.html` — `.nav-loading-bar` CSS removed.
- `src/ui/*.html`, `src/ui/manager/*.html`, `src/ui/bishopric/*.html`,
  `src/ui/stake/*.html` — every page template refactored to export
  `window.page_<pageId>_init(pageModel, queryParams)`. See the table
  above.
- `src/ui/manager/Dashboard.html` — card order tweak.
- `src/ui/manager/Dashboard.html`, `src/ui/manager/Import.html` —
  `data-page` attributes added to in-content deep-link anchors.
- `docs/architecture.md`, `docs/build-plan.md` — as above.

## Next

Chunk 11 (Cloudflare Worker + custom domain) is the final chunk. Its
concerns are orthogonal to 10.6:

- The Worker proxies `kindoo.csnorth.org/*` to the `/exec` URL. The
  `pageBundle` ships inside the same `ApiShared_bootstrap` response
  regardless of whether the request came from `kindoo.csnorth.org`
  (via Worker) or directly from `/exec` — the Worker doesn't touch
  payload shape.
- The iframe-vs-top-frame boundary that 10.6 documents (History API
  happens in the iframe; top-frame URL stays on `/exec`) is unchanged
  by the custom domain. A shared URL looks like
  `kindoo.csnorth.org/?p=mgr/seats&ward=CO` instead of
  `.../macros/s/<id>/exec?p=...`, but the recipient's direct-load
  still flows through `Main.doGet` → `ApiShared_bootstrap` → initial
  render + bundle.
- The OAuth Client ID allowlist concern in Chunk 11 is orthogonal
  to the shell — auth is a top-frame `window.top.location.replace`
  out to the Identity deployment and back, and never touches the rpc
  path that ships the bundle.

Nothing in 10.6 blocks Chunk 11.
