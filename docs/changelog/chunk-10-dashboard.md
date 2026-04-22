# Chunk 10 — Audit Log page + polish

**Shipped:** 2026-04-22
**Commits:** _(see git log; commit messages reference "Chunk 10")_

## What shipped

The manager Dashboard and Audit Log pages are live, the manager default
landing flipped from `mgr/seats` to `mgr/dashboard`, and a polish pass
across every existing page brought loading states, empty states, and
responsive layout in line.

Dashboard (`ui/manager/Dashboard.html`):

- **Five cards**, all rendered from a single `ApiManager_dashboard`
  rpc so the landing is one round-trip:
    1. **Pending Requests** — total + per-type counts (add_manual /
       add_temp / remove). Each type deep-links to
       `?p=mgr/queue&state=pending&type=<type>` so the manager lands in
       the queue pre-filtered.
    2. **Recent Activity** — last 10 AuditLog rows, formatted as
       `<actor-badge> <action> · <entity_type> <entity_id>` with a
       timestamp line underneath. Clicking a row opens the Audit Log
       filtered by `entity_id` so the full trail for that record is
       one click away.
    3. **Utilization** — one bar per scope (stake first, then every
       configured ward alphabetical), colour-coded `ok` / `warn` at
       ≥ 90 % / `over` at > 100 %. Pre-computed server-side so the UI
       doesn't re-do the threshold math. Each bar's label links to
       `?p=mgr/seats&ward=<code>` (`ward=stake` for the stake pool).
    4. **Warnings** — reads `Config.last_over_caps_json` (the Chunk-9
       snapshot) and renders the same shape as the Import page banner,
       with a `view →` per-pool deep-link. Empty snapshot renders a dim
       "No warnings." line so the card never looks broken.
    5. **Last Operations** — timestamps + summary for `last_import_at`,
       the new `last_expiry_at` (Q-8.1), and `last_triggers_installed_at`
       (derived from the most-recent `reinstall_triggers` or
       `setup_complete` audit row — no new Config key needed).

- The endpoint logs `elapsed_ms` at completion for future-scale
  monitoring; if it ever exceeds ~2 s the path to a fix is per-card
  splits + `CacheService`.

Audit Log (`ui/manager/AuditLog.html`):

- **Server-side pagination** — the ONE page in the app that paginates.
  `ApiManager_auditLog(token, filters)` returns
  `{rows, total, offset, limit, has_more, applied_filters,
  used_default_range}`; offset / limit clamped to 100 rows per page.
  Architecture.md §1 gained an explicit "one exception" note
  documenting why the rule doesn't apply to this one tab.
- **Filter set (AND-combined):** `actor_email` (canonical-email compare
  for real users, literal match for `"Importer"` / `"ExpiryTrigger"`),
  `action` (dropdown over the data-model.md §10 vocabulary),
  `entity_type` (dropdown enum — validated server-side so a typo
  doesn't silently match nothing), `entity_id` (exact, case-sensitive),
  `date_from` / `date_to` (ISO dates, inclusive on both ends in the
  script timezone).
- **Default window** is the last 7 days when neither date is supplied,
  so the first page load isn't a full-history scan. The server
  surfaces `used_default_range: true` back to the UI so the counter
  hint reads `"… (default last 7 days)"` — the default is visible, not
  silent.
- **Deep links** — every filter key flows through `QUERY_PARAMS` so
  `?p=mgr/audit&action=over_cap_warning&date_from=2026-04-01` lands
  with the filter pre-applied. Dashboard → Audit Log links carry
  `entity_id` through.
- **Per-row rendering** — a coloured action badge, a collapsed one-line
  summary (custom for `over_cap_warning`, `import_end`, `auto_expire`,
  `reinstall_triggers`; generic top-keys preview for everything else),
  and a `<details>` block that expands to a three-column diff table
  (`field | before | after`) for updates. Insert rows render only
  after; delete rows render only before. Unchanged fields are
  summarised as "N unchanged fields not shown" so the reader knows the
  row wasn't truncated.
- **Q-7.1 resolution** — `complete_request` rows with a non-empty
  `after.completion_note` surface the note in the collapsed view
  (styled as an amber note under the row summary), so the Chunk-7 R-1
  no-op path is visible at a glance.

Polish (across existing pages):

- Every bare `'Loading…'` innerHTML placeholder became a styled
  `<div class="empty-state">Loading …</div>` so the initial fetch
  doesn't render as bare text.
- Responsive pass — every primary page renders without horizontal
  scroll at 375 px viewport (iPhone SE width). Tables (roster,
  audit-log, config, my-requests) scroll horizontally within their
  container rather than overflowing the page; filter rows stack; the
  Dashboard grid collapses to one column.
- Empty states standardised on `.empty-state` across the app (Access,
  AllSeats, RequestsQueue, MyRequests, Audit Log, Dashboard cards).

Infrastructure:

- **New Config keys** — `last_expiry_at` (timestamp) and
  `last_expiry_summary` (string), seeded empty by
  `SETUP_CONFIG_SEED_`. `Expiry_runExpiry` writes both at the end of
  every run (including runs that expire zero rows, so the timestamp
  always reflects when the trigger last fired).
- **`CONFIG_IMPORTER_KEYS_` → `CONFIG_SYSTEM_KEYS_`** rename in
  `ConfigRepo`. Covers importer-owned AND expiry-owned keys.
  `Config_isImporterKey` kept as a backward-compat alias so the
  Chunk-2 `ApiManager_configUpdate` guard didn't need a touch-up;
  `Config_isSystemKey` is the new accurate name. The manager Config
  UI renders the read-only keys under a `system-managed` badge
  (replacing the old `importer-owned`).
- **`AuditRepo_getAll()`** — new read-side entry for the Audit Log
  page and the Dashboard's Recent Activity card. Caches nothing;
  every query re-reads the full tab (architecture.md §1 + `N+1-read
  concern` note in the endpoint).
- **Router changes** — `Router_defaultPageFor_` returns
  `'mgr/dashboard'` for the manager role (was `'mgr/seats'`);
  `ROUTER_PAGES_` entries for `mgr/dashboard` and `mgr/audit` point
  at the real templates. `Nav.html` unhides both manager links.

## Deviations from the pre-chunk spec

- **Offset / limit pagination on the Audit Log page** — architecture.md
  §1 pre-chunk said "no server-side pagination for v1". Chunk 10
  added an explicit "one exception" carve-out for this page, because
  the `AuditLog` tab grows unbounded (~300-500 rows/week at target
  scale, ~20k rows/year) and rendering it in one table isn't
  feasible. Every other page still follows the no-pagination stance.
  Offset / limit chosen over cursor-based because we already read the
  full tab to filter; cursor would be a substitution away if the
  endpoint's cost stops being tolerable.
- **Default 7-day window on the Audit Log page** — not specified
  pre-chunk. Without a default the first page load would read the
  full tab (and filter for "last 7 days" is by far the dominant use
  case). The server surfaces `used_default_range: true` so the UI can
  render "default last 7 days" next to the counter — the default is
  visible, not hidden.
- **`last_triggers_installed_at` is DERIVED, not a Config key.**
  Pre-chunk prompt listed it alongside `last_import_at` /
  `last_expiry_at` in the Dashboard shape. Derived from the most-
  recent `reinstall_triggers` or `setup_complete` audit row instead:
  the audit trail is already the source of truth for that
  timestamp, and a parallel Config key would be another thing to
  keep in sync. Zero code cost, zero new state.
- **`last_expiry_at` / `last_expiry_summary` live in a renamed
  `CONFIG_SYSTEM_KEYS_` group, not a sibling `CONFIG_EXPIRY_KEYS_`.**
  Pre-chunk prompt offered two options. Renaming was simpler than
  branching the Config UI on two different read-only lists —
  "system-managed" reads correctly on both the importer-owned keys
  AND the new expiry-owned keys, without needing a per-owner badge
  taxonomy.

## Decisions made during the chunk

- **Single `ApiManager_dashboard` rpc rather than per-card rpcs.**
  Per-card (five calls on page load) would have five round-trips +
  five lock-free reads; single-rpc is one. The endpoint is read-heavy
  (`Requests`, `Seats`, `Wards`, `Config`, `AuditLog`, trigger list)
  but at target scale each read is well under 100 ms; total measured
  rendering is below 500 ms on a full install. `elapsed_ms` is logged
  at completion for monitoring. Revisit if the target scale shifts.
- **Utilization card reuses `Rosters_buildSummary_` directly** instead
  of re-implementing cap / count math. Chunk 5's Rosters service
  already owns the shape, including the stake-pool case, and the
  endpoint builds a one-per-scope summary list that the card renders
  one-to-one. Keeping the math in one place means the Dashboard
  utilization always matches the All Seats page's summary cards
  regardless of future refactors.
- **Dashboard `utilization[].state` is pre-computed server-side.**
  Client could do the threshold math, but precomputing keeps the
  "what does ≥ 90 % mean" policy in one place — if the threshold
  changes, it's one file, not one per-template colour check.
- **`over_cap_warning` summary in Recent Activity mentions the pool
  count inline.** All other actions get the generic
  `<action> · <entity_type> <entity_id>` summary. Parsing
  `after_json.pools.length` for `over_cap_warning` surfaces "2 pools
  over" without expanding the row — a signal-over-noise choice,
  since the generic preview ("action · System over_cap") is
  uninformative on its own.
- **Audit Log inline completion_note is styled as an amber note.**
  Putting it inside the `<details>` block would have hidden the
  Chunk-7 R-1 trail from anyone scanning the list. Surfacing it
  inline (even when collapsed) makes the no-op completions visible
  without clicking; the note is the distinctive thing about those
  rows.
- **Default last-7-days window reflected back to the UI inputs.**
  If the server applied the default, the UI refreshes its date-from /
  date-to inputs with the server's chosen boundaries. Otherwise the
  user sees blank inputs alongside the counter saying "last 7 days",
  which suggested (wrongly) "no filter applied."
- **Polish pass did NOT normalise the Config page's tab-panel
  Loading text.** Those placeholders live inside inactive
  (display:none) panels, never visible to the user before being
  replaced by the real render. Normalising them would have been
  change for its own sake.

## Spec / doc edits in this chunk

- `docs/spec.md` — §5.3 Dashboard description rewritten to match what
  shipped; §5.3 Audit Log description expanded with filter set,
  pagination, and diff rendering details.
- `docs/architecture.md` — §1 gained the "one exception to the
  no-pagination rule" note for the Audit Log page; §8 Page ID map
  shed the "Chunk 10 placeholder" annotations; §10.5 added
  documenting the Dashboard aggregation shape, the Audit Log
  pagination contract, the `last_expiry` Config keys, and the
  `CONFIG_IMPORTER_KEYS_` → `CONFIG_SYSTEM_KEYS_` rename.
- `docs/data-model.md` — Config tab gains `last_expiry_at` /
  `last_expiry_summary` with descriptions; example rows table
  includes them.
- `docs/build-plan.md` — Chunk 10 marked
  `[DONE — see docs/changelog/chunk-10-dashboard.md]`; sub-tasks
  rewritten to match what shipped; acceptance criteria expanded to
  cover default landing, colour-coding thresholds, and the polish
  pass.
- `docs/open-questions.md` — Q-7.1 (audit-log completion_note),
  Q-8.1 (Dashboard last-expiry card), Q-9.1 (Dashboard Warnings card
  + last-import monitoring signal) marked RESOLVED with rationale.
- `docs/changelog/chunk-10-dashboard.md` — this file.

## Polish fixes discovered during the pass

A deliberately short list — the discipline was "don't spiral into new
features." The items below were genuine consistency bugs.

1. **Bare `'Loading…'` innerHTML** across seven pages (AllSeats,
   RequestsQueue, bishopric/Roster, stake/Roster, stake/WardRosters,
   Access, MyRequests) replaced with `<div class="empty-state">Loading
   …</div>` so the first-paint state matches the "no results" state's
   styling. Previously rendered as left-justified body text, visually
   different from every subsequent state on the same page.
2. **`mgr/queue` + `mgr/seats` submitted-timestamp alignment on
   mobile.** The queue card header's `margin-left: auto` shoved the
   "Submitted …" stamp off the right edge at 375 px width. Added
   `margin-left: 0` in the mobile media query.
3. **Form-row `temp-only` at narrow viewports** — the two-column
   `start_date` / `end_date` layout in `NewRequest` and the seat-edit
   modal overflowed the container. Mobile query flips to column
   stacking.

## New open questions

None blocking. Two worth flagging for later polish:

- **Q-10.1 (P2) — Audit Log full-text search.** The pre-chunk prompt
  listed "free-text search in before_json + after_json" as "optional,
  low priority." Not built this chunk. If it becomes a real need the
  fix is to add a `text` filter to `ApiManager_auditLog` that does a
  case-insensitive substring match against the concatenated
  `before_json + after_json`. The full-scan read already happens;
  adding one more per-row predicate is trivial.
- **Q-10.2 (P2) — Audit Log cursor-based pagination.** Offset/limit
  re-reads the full tab on every page turn. At 20k rows that's one
  sheet read of ~1 s per "Next" click. Tolerable at target scale;
  the fix when it becomes intolerable is either a `CacheService`-
  memoised per-request array or a reverse-chronological short-
  circuit that stops iterating once the `date_from` cut-off is
  passed. Recorded in `ApiManager_auditLog`'s comment block.

## Files created / modified

**Created**

- `docs/changelog/chunk-10-dashboard.md` — this file.

**Implemented (replaced 1-line stubs with real code)**

- `src/ui/manager/Dashboard.html` — five-card manager landing.
- `src/ui/manager/AuditLog.html` — filter + paginate + diff.

**Modified**

- `src/api/ApiManager.gs` — added `ApiManager_auditLog`,
  `ApiManager_dashboard`, their helpers, and constants
  (`AUDIT_LOG_MAX_LIMIT_`, `AUDIT_LOG_DEFAULT_DAYS_`,
  `AUDIT_LOG_VALID_ENTITY_TYPES_`). `ApiManager_configList` wire
  shape now returns both `system` (accurate) and `importer` (legacy
  alias) for forward-compatibility. `ApiManager_configUpdate` error
  message updated for the renamed guard.
- `src/repos/AuditRepo.gs` — added `AuditRepo_getAll()` read path.
- `src/repos/ConfigRepo.gs` — renamed
  `CONFIG_IMPORTER_KEYS_` → `CONFIG_SYSTEM_KEYS_`; added
  `last_expiry_at` / `last_expiry_summary` to the list; added
  `Config_isSystemKey` alongside the legacy `Config_isImporterKey`
  wrapper.
- `src/core/Router.gs` — `Router_defaultPageFor_` returns
  `mgr/dashboard`; `ROUTER_PAGES_` entries for `mgr/dashboard` and
  `mgr/audit` wired to real templates.
- `src/services/Setup.gs` — `SETUP_CONFIG_SEED_` seeds the two new
  expiry keys empty.
- `src/services/Expiry.gs` — writes `last_expiry_at` /
  `last_expiry_summary` at the end of every run (including zero-
  delete runs); returns a `summary` field alongside the existing
  `{expired, ids, elapsed_ms}` shape.
- `src/ui/Nav.html` — unhides the Dashboard + Audit Log manager
  links.
- `src/ui/Styles.html` — added Dashboard card styles, Audit Log
  table / filter / diff styles, and a `@media (max-width: 640px)`
  polish block.
- `src/ui/manager/Config.html` — reads the new `system` wire key
  (with `importer` fallback); renders the read-only keys under a
  `system-managed` badge instead of `importer-owned`; tab-panel
  Loading text left untouched (inside inactive panels).
- `src/ui/manager/AllSeats.html`, `RequestsQueue.html`,
  `bishopric/Roster.html`, `stake/Roster.html`,
  `stake/WardRosters.html`, `manager/Access.html`, `MyRequests.html`
  — bare `'Loading…'` placeholders promoted to `<div
  class="empty-state">` containers (polish fix #1 above).

**Untouched**

- No services / repos beyond `AuditRepo` (new read path) and
  `ConfigRepo` / `Expiry` (system-keys rename + last-expiry stamps)
  were modified.
- Rosters, RequestsService, EmailService, Importer, Bootstrap, Auth,
  SeatsRepo, RequestsRepo, WardsRepo, BuildingsRepo, KindooManagersRepo,
  TemplatesRepo, AccessRepo — structurally unchanged.

## Confirmation that the Chunk 10 deferrals list was respected

Per `build-plan.md` Chunk 10 → "Out of scope":

- ✅ **Export to CSV** — not built. Audit Log exposes no export path.
- ✅ **Cursor-based pagination** — offset/limit is the v1 shape;
  comment in `ApiManager_auditLog` notes the refactor path for when
  it becomes needed.

Additional deferrals respected (not explicit but implied by the chunk
scope):

- ✅ **Cloudflare Worker** — Chunk 11. `identity-project/` untouched;
  no routing/proxy changes.
- ✅ **No new functional features.** The polish pass fixed loading /
  empty / responsive states and an audit-log note rendering — zero
  net-new affordances were added to existing pages (no new buttons,
  filters, or actions beyond the Dashboard and Audit Log themselves).
- ✅ **No refactoring of Chunks 2–9 code beyond the touch points
  listed above.** Rosters service signature unchanged; import /
  expiry / email / request service logic unchanged; repo APIs stable.
- ✅ **No accessibility audit.** Out of scope for v1.
- ✅ **No dark mode.**

## Next

Chunk 11 (Cloudflare Worker + custom domain) is the final chunk. The
Dashboard + Audit Log landing above is the operational-UX surface
that a v1 deployment needs; the Worker is a deployment / DNS concern
layered on top.

The `last_triggers_installed_at` timestamp the Dashboard surfaces
(derived from the audit trail) is a useful monitoring signal for the
historical-trigger-drift concern flagged in chunk-9-scheduled.md's
"Next" — an operator can see at a glance whether an archived
deployment's trigger is still firing against stale code (the Weekly
trigger run-timestamps won't update if the archived trigger fires
elsewhere). Operational mitigation remains: archive old deployments
deliberately and click "Reinstall triggers" on the new one.
