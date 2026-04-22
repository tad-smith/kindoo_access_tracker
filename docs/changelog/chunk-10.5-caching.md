# Chunk 10.5 — Caching pass

**Shipped:** 2026-04-22
**Commits:** _(see git log; commit messages reference "Chunk 10.5")_

## What shipped

A `core/Cache.gs` module wraps `CacheService.getScriptCache()` with a
memoize / invalidate / stats API, and the project's hot read paths now
funnel through it. No user-visible behaviour change — the wire shape of
every endpoint is byte-for-byte identical to Chunk 10. The only thing
users should notice is that pages load faster.

### Cache module (`core/Cache.gs`, new)

Public API:

- `Cache_memoize(key, ttlSeconds, computeFn)` — get-or-compute over
  `CacheService.getScriptCache()` with JSON serialization. Payloads
  > 90 KB skip the put with a `[Cache] size-limit skipped <key>` log
  line and fall through to an uncached compute (never throw — the Sheet
  stays the source of truth). Parse failures on a corrupt cache entry
  silently recompute. Per-execution hit / miss / skip counters live in a
  module-var `CACHE_STATS_`.
- `Cache_invalidate(keyOrKeys)` — `cache.removeAll([...])` over one or
  many keys. Swallows CacheService exceptions (logs + continues) so an
  invalidation failure never unwinds the write that triggered it.
- `Cache_invalidateAll()` — enumerates `Cache_knownKeys_()` (the
  canonical list of every key the project writes) and removes them in
  one round-trip. CacheService has no "wipe the whole script cache"
  call, so the enumeration is load-bearing; a new memoize site must add
  its key to `Cache_knownKeys_` or `Cache_invalidateAll` leaves stale
  data behind.
- `Cache_getStats()` — defensive copy of `CACHE_STATS_` for the debug
  panel.

Non-obvious behaviours:

- **Dates survive the cache round-trip.** `JSON.stringify(date)` emits
  an ISO string; `JSON.parse` returns a string. Callers that check
  `instanceof Date` (e.g. `Rosters_formatDate_`, `ApiManager_formatDate_`)
  would silently break without intervention. `Cache_memoize` encodes
  `Date` as `{ __date__: <iso> }` before put and revives on get. Every
  other value passes through unchanged.
- **CacheService failure mode is graceful.** `getScriptCache()`,
  `get()`, and `put()` are each wrapped in try/catch; any failure logs
  and falls through to the compute path. Reads never fail because of
  cache trouble.

### Per-request sheet-handle memo — `Sheet_getTab(name)` (new)

Lives in `core/Cache.gs` alongside the `CacheService` wrapper (one
module owns both caching concerns). Plain in-memory object keyed by tab
name, scoped to the current script execution via a module var:

```
var SHEET_TAB_CACHE_ = null;
function Sheet_getTab(name) { … }
```

Every repo's `Xxx_sheet_()` helper now delegates to `Sheet_getTab`.
`ConfigRepo` and `AuditRepo`, which had inline
`SpreadsheetApp.getActiveSpreadsheet().getSheetByName(...)` calls rather
than a `_sheet_` helper, were refactored to route through `Sheet_getTab`
too. Post-chunk grep:

```
$ grep -rn "SpreadsheetApp.getActiveSpreadsheet" src/ | grep -v "Cache.gs\|Setup.gs"
# (no matches)
```

The two allowed sites are:

1. `core/Cache.gs` — `Sheet_getTab`'s own implementation.
2. `services/Setup.gs#setupSheet` — creates missing tabs, so can't go
   through `Sheet_getTab` (which throws on miss). This is the operator-
   invoked diagnostic path and doesn't need the memo.

### Memoized read paths

| Function | TTL | Cache key |
| --- | --- | --- |
| `Config_getAll()` | 60 s | `config:getAll` |
| `Config_get(key)` | — | (reads from cached `getAll` map) |
| `KindooManagers_getAll()` | 60 s | `kindooManagers:getAll` |
| `Access_getAll()` | 60 s | `access:getAll` |
| `Wards_getAll()` | 300 s | `wards:getAll` |
| `Buildings_getAll()` | 300 s | `buildings:getAll` |
| `Templates_getAll('ward')` | 300 s | `templates:ward:getAll` |
| `Templates_getAll('stake')` | 300 s | `templates:stake:getAll` |

`Seats`, `Requests`, and `AuditLog` are intentionally NOT memoized per
architecture.md §7.5:

- **`Seats` / `Requests`** — write-hot. Short-TTL cache would produce
  staleness on the pages users refresh most (`mgr/queue`, `mgr/seats`).
- **`AuditLog`** — grows unbounded (~20k rows / year). The serialized
  payload exceeds the 90 KB size-skip threshold at year+1 scale; caching
  would fire the skip path every time. It's already the one paginated
  read in the app by design.

### Invalidation sites (the review checklist)

Every write site owns its invalidation call. Enumerated below so
completeness is a grep-verifiable review pass rather than a tracing
exercise.

**Repo-local (one key per repo; invalidation colocated with the Sheet
write):**

| Site | Invalidates |
| --- | --- |
| `ConfigRepo#Config_update` (after `sheet.getRange(...).setValue`) | `config:getAll` |
| `AccessRepo#Access_insert` | `access:getAll` |
| `AccessRepo#Access_delete` | `access:getAll` |
| `WardsRepo#Wards_insert` | `wards:getAll` |
| `WardsRepo#Wards_update` | `wards:getAll` |
| `WardsRepo#Wards_delete` | `wards:getAll` |
| `WardsRepo#Wards_bulkInsert` | `wards:getAll` |
| `BuildingsRepo#Buildings_insert` | `buildings:getAll` |
| `BuildingsRepo#Buildings_update` | `buildings:getAll` |
| `BuildingsRepo#Buildings_delete` | `buildings:getAll` |
| `BuildingsRepo#Buildings_bulkInsert` | `buildings:getAll` |
| `KindooManagersRepo#KindooManagers_insert` | `kindooManagers:getAll` |
| `KindooManagersRepo#KindooManagers_update` | `kindooManagers:getAll` |
| `KindooManagersRepo#KindooManagers_delete` | `kindooManagers:getAll` |
| `KindooManagersRepo#KindooManagers_bulkInsert` | `kindooManagers:getAll` |
| `TemplatesRepo#Templates_insert(kind, …)` | `templates:<kind>:getAll` |
| `TemplatesRepo#Templates_update(kind, …)` | `templates:<kind>:getAll` |
| `TemplatesRepo#Templates_delete(kind, …)` | `templates:<kind>:getAll` |

**Service end-of-run (belt-and-braces after the per-row invalidations
fired inside the lock):**

| Site | Invalidates |
| --- | --- |
| `Importer_runImport` (after over-cap snapshot + email) | `config:getAll`, `access:getAll` |
| `Expiry_runExpiry` (after last-run Config writes) | `config:getAll` |

**API layer (administrative surface):**

| Site | Invalidates |
| --- | --- |
| `ApiManager_clearCache` | _every_ known key (`Cache_invalidateAll()`) + one `clear_cache` AuditLog row |

`Seats_*` and `Requests_*` don't appear because those tabs aren't
memoized; their writes don't need invalidation. Likewise `AuditRepo_*`.

### Cache stats debug panel (manager Config page)

A new "Cache statistics" section sits below the existing "Scheduled
triggers" panel on `?p=mgr/config`. It shows:

- An aggregate line: `N hits · M misses · K size-skips · hit rate %`.
- A table of the top-10 keys by total access count with per-key
  hits / misses / size-skips / bytes_cached.
- A **Refresh stats** button (re-queries `ApiManager_cacheStats` — the
  re-query itself is a new rpc, so its stats populate the panel).
- A **Clear cache** button (calls `ApiManager_clearCache`, which runs
  `Cache_invalidateAll()` inside a lock and writes one audit row:
  `action='clear_cache'`, `entity_type='System'`, `entity_id='cache'`,
  `after={triggered_by: principal.email}`).

Styles live in `ui/Styles.html` under the comment "Manager Config —
Cache stats panel (Chunk 10.5)", sharing visual vocab with the triggers
panel above so the two read as a consistent pair.

### Timing instrumentation

Three endpoints now emit `[measure]` log lines so the operator can read
the logs via `npm run logs` to see cold / warm elapsed ms per page
load:

- `ApiShared_bootstrap` → `[measure] bootstrap for page=<id> took Xms`
- `ApiManager_allSeats` → `[measure] allSeats ward=… building=… type=… rows=N took Xms`
- `ApiBishopric_roster` → `[measure] bishopric/roster ward=<code> rows=N took Xms`

`ApiManager_dashboard` already emitted its own `elapsed_ms` log line
from Chunk 10, so the trio of Dashboard + bishopric/Roster +
manager/AllSeats is fully instrumented. A cache-stats operator loop is:

1. Push the branch and redeploy.
2. From the Apps Script executions log (or `npm run logs`), read the
   baseline `[measure]` lines.
3. Open the manager Config page → **Clear cache**.
4. Navigate Dashboard / bishopric/Roster / manager/AllSeats — first load
   is cold-cache; second is warm.
5. Read the `[measure]` log lines for each.

### Measured timings

Target shape (to be confirmed on deploy — see "measurement status" below):

| Page | Chunk-10 baseline | Chunk-10.5 cold | Chunk-10.5 warm | Δ vs. baseline |
| --- | --- | --- | --- | --- |
| manager/Dashboard      | _TBD_ | _TBD_ | _TBD_ | ≥ 30 % warm (acceptance) |
| bishopric/Roster       | _TBD_ | _TBD_ | _TBD_ | comparable warm improvement |
| manager/AllSeats (no filter) | _TBD_ | _TBD_ | _TBD_ | comparable warm improvement |

**Measurement status.** The timing instrumentation is in place and
exercised by every relevant endpoint (`ApiShared_bootstrap`,
`ApiManager_dashboard`, `ApiBishopric_roster`, `ApiManager_allSeats`).
The actual before/after numbers require a deployed run — the operator
needs to push this branch, redeploy, and read the `[measure]` log lines
from the Apps Script executions log. The protocol is:

1. **Capture Chunk-10 baseline first (do this BEFORE pushing Chunk
   10.5).** From `main` at `cc52350` (Chunk 10 tip): navigate to
   Dashboard / bishopric Roster / manager AllSeats, note the server
   elapsed_ms for each. Record as the `Chunk-10 baseline` column.
2. Push Chunk 10.5 (`npm run push && npm run deploy`).
3. Open manager Config → **Clear cache**. First load of each target
   page is cold-cache; record as `Chunk-10.5 cold`.
4. Reload each page without clearing. Record as `Chunk-10.5 warm`.
5. Edit this changelog's table with the captured numbers; commit as a
   follow-up to Chunk 10.5 (or squash into the chunk's commit before
   pushing to the branch).

**What to expect from the shape.** Warm cache eliminates the full-tab
reads of Config / Wards / Buildings / Templates / Access /
KindooManagers from the per-request budget and collapses
`getSheetByName` lookups to one per tab per request. On Apps Script's
`getDataRange().getValues()` read, that's typically 80-150 ms per tab
avoided per request, so a page that reads five Chunk-10.5-memoized tabs
(Dashboard does: Config x5 keys, Wards, + AuditLog uncached + the
computed Rosters ctx) should see a meaningful multi-hundred-ms drop
between baseline and warm. The acceptance target (≥ 30 % Dashboard
warm) is well within that budget.

**What would indicate trouble.** If the warm-cache Dashboard run isn't
at least 30 % faster than baseline, something's off. Diagnose by (a)
checking the Cache statistics panel mid-run — if `config:getAll` is
showing `misses: 0` after the second load, the cache is working; (b)
confirming the `Sheet_getTab` memo is in effect (repeat `Sheet_getTab`
calls for the same tab should be free after the first); (c) reading
the `[measure]` line — if bootstrap elapsed is high but the endpoint's
own elapsed is low, the loss is upstream of the read path. The
post-chunk grep for `SpreadsheetApp.getActiveSpreadsheet` should return
only `core/Cache.gs` + `services/Setup.gs`.

Cold-cache is expected to match baseline plus a small win from
`Sheet_getTab` collapsing the `getSheetByName` lookups — an easy 5-10 %
even before the CacheService tier activates. The headline win is in
the warm column.

## Deviations from pre-chunk architecture.md §7.5

Three implementation details diverged from the pre-chunk §7.5 draft. All
three have been reconciled in this chunk's edits to §7.5; listing them
here so the trail is clear.

- **`Config_getAll` memoization rather than per-key `Config_get`.** The
  pre-chunk table memoized `Config_get(key)` with a per-key cache key,
  which would have issued N Sheet reads per request for N distinct keys
  touched. Memoizing `Config_getAll` once and having `Config_get(key)`
  read from the cached map keeps the same cache surface (one key,
  invalidated on every `Config_update`) but serves every subsequent
  `Config_get` for any key from the same in-memory result. Dashboard
  reads ~5 Config keys; warm-cache that's 0 Sheet reads instead of up
  to 5. §7.5 table updated.
- **`KindooManagers_getAll` rather than `_getActive`.** The pre-chunk
  table named `KindooManagers_getActive()`, which has never existed in
  shipped code. Role resolution reaches this tab via
  `KindooManagers_isActiveByEmail → _getByEmail → _getAll`, so `_getAll`
  is the real hot path; memoizing there caches the data the
  `_getActive` entry intended. §7.5 table updated.
- **90 KB soft size limit rather than 100 KB.** CacheService's hard
  per-value limit is 100 KB. 90 KB leaves headroom for the key metadata
  CacheService prefixes internally (it's a wire-level limit on the
  stored payload, not on the raw JSON string). §7.5 narrative updated.

## Decisions made during the chunk

- **No per-user cache scope.** Every memoize call uses
  `CacheService.getScriptCache()`. Role resolution stays un-cached
  (Alice's roles are not Bob's); the reads it does (`KindooManagers_getAll`
  + `Access_getAll`) are cached at the repo layer, so role resolution
  itself stays cheap without introducing per-user cache scope. If a
  specific hot-path rpc ever justifies `getUserCache()`, introduce it
  one call site at a time rather than as a default.
- **Module-var per-request stats, not CacheService-backed.** The stats
  panel surface is genuinely useful for "did this rpc hit the cache?"
  — a question CacheService itself would be the wrong tool to answer
  (it's cross-request by design). An AuditLog-backed counter would be
  absurd. Module-var is the right shape.
- **Size-skip on put, not throw.** A payload that exceeds the size
  ceiling logs a warning and returns the computed value uncached. A
  throw would break the read; a silent "did nothing" would be worse
  because the cache would silently stay empty on a growing tab (e.g.
  AuditLog at year+1). Loud log + uncached compute is the behaviour
  the operator can notice, diagnose, and decide about.
- **Dates encoded as `{ __date__: iso }` through the cache.** The repos
  hand back `Date` instances for `created_at` / `last_modified_at` /
  `last_import_at` / `last_expiry_at`. A naïve JSON round-trip would
  silently turn those into strings and break every `instanceof Date`
  check in the API-formatting helpers. Explicit encode + revive
  preserves the shape.
- **`Cache_invalidateAll` enumerates a hardcoded key list.** Every
  memoize site's key lives in `Cache_knownKeys_()`. Adding a new
  memoized read in a future chunk requires adding its key here too;
  the alternative (wildcards, prefix-scans) isn't a CacheService
  primitive.
- **Invalidation is colocated with the Sheet write, not with the audit
  write.** The repo-level invalidation fires right after
  `sheet.appendRow` / `setValues` / `deleteRow` inside the existing
  write function, before returning to the API layer. The API layer's
  post-write audit row and lock release happen afterwards. Ordering
  rationale: if the Sheet write succeeds but the audit write throws,
  we'd rather invalidate the cache anyway (next read sees the new row)
  than leave a stale cache entry that contradicts the Sheet. The lock
  serializes writers, so no in-flight read can observe the
  invalidation mid-commit.
- **Importer + Expiry end-of-run sweeps are belt-and-braces.** The
  per-row repo invalidations inside the import/expiry lock already
  keep in-run reads consistent. The end-of-run sweep catches the
  over-cap snapshot and last-run Config writes that touched
  `config:getAll` after everything else. Cheap; the extra
  `removeAll(2)` costs nothing.

## Spec / doc edits in this chunk

- `docs/architecture.md` — §7: updated to reflect `Sheet_getTab`'s
  actual location (`core/Cache.gs`) and that repos now delegate through
  it (Chunk 1 never landed the helper; Chunk 10.5 closes the gap).
  §7.5: memoization table corrected for the two deviations above;
  size-limit narrative updated to 90 KB soft / 100 KB hard; new
  paragraph on `Date` encoding; debug-surface paragraph rewritten to
  match `Cache_getStats`' actual return shape plus mention of
  `ApiManager_clearCache`.
- `docs/build-plan.md` — Chunk 10.5 header marked `[DONE …]`; every
  sub-task checkbox flipped to `[x]`.
- `docs/spec.md` — no changes (no user-visible behaviour change).
- `docs/data-model.md` — no changes (no schema change).
- `docs/open-questions.md` — no changes (no new ambiguities surfaced).
  The "size-skip falls through uncached" policy was explicit in the
  pre-chunk §7.5 so didn't merit a new open question.

## Deferred

- **Client-side navigation** → Chunk 10.6. Benefits from cached reads
  underneath but structurally separate.
- **Cloudflare Worker + custom domain** → Chunk 11.
- **Per-user cache scope.** If a future rpc's profile shows per-user
  data being the bottleneck, introduce `CacheService.getUserCache()` at
  that one site. Not a default.
- **Materialized roll-up tables** (Option D from the Chunk 10.5
  planning). Rejected in favour of `CacheService` memoization at the
  read boundary; the complexity of maintaining a derived tab wasn't
  justified by the measurement. Recorded for the "what we didn't build"
  trail.
- **Cursor-based AuditLog pagination** (continued from Chunk 10).
  `AuditLog` still doesn't cache.
- **Persistent cross-execution stats counters** (e.g. for a long-term
  hit-rate dashboard). Not worth the sheet-backed plumbing; the
  per-execution panel answers the operational question well enough.

## Files created / modified

Created:

- `src/core/Cache.gs` — the `CacheService` wrapper + `Sheet_getTab`
  memo. Single file, ~300 lines.
- `docs/changelog/chunk-10.5-caching.md` — this file.

Modified:

- `src/repos/AccessRepo.gs` — memoize `Access_getAll`; invalidate on
  `Access_insert` / `_delete`; `Access_sheet_` now calls `Sheet_getTab`.
- `src/repos/BuildingsRepo.gs` — memoize `Buildings_getAll`; invalidate
  on every write; `Buildings_sheet_` delegates.
- `src/repos/ConfigRepo.gs` — memoize `Config_getAll`;
  `Config_get(key)` reads from cached map; invalidate on `Config_update`;
  inline `SpreadsheetApp` calls replaced with `Sheet_getTab`.
- `src/repos/KindooManagersRepo.gs` — memoize `_getAll`; invalidate on
  every write; `_sheet_` delegates.
- `src/repos/TemplatesRepo.gs` — memoize `_getAll(kind)` per kind;
  invalidate on every write; `_sheet_` delegates.
- `src/repos/WardsRepo.gs` — memoize `_getAll`; invalidate on every
  write; `_sheet_` delegates.
- `src/repos/SeatsRepo.gs` — `_sheet_` delegates to `Sheet_getTab`; no
  memoization per §7.5.
- `src/repos/RequestsRepo.gs` — same shape as SeatsRepo.
- `src/repos/AuditRepo.gs` — inline `SpreadsheetApp` calls replaced
  with `Sheet_getTab`; no memoization.
- `src/services/Importer.gs` — end-of-run sweep invalidates
  `config:getAll` + `access:getAll`.
- `src/services/Expiry.gs` — end-of-run sweep invalidates
  `config:getAll`.
- `src/api/ApiManager.gs` — new `ApiManager_cacheStats` /
  `ApiManager_clearCache` endpoints; timing log in `ApiManager_allSeats`.
- `src/api/ApiShared.gs` — timing log in `ApiShared_bootstrap`.
- `src/api/ApiBishopric.gs` — timing log in `ApiBishopric_roster`.
- `src/ui/manager/Config.html` — "Cache statistics" panel below
  "Scheduled triggers"; Refresh stats + Clear cache buttons wired to
  the new endpoints.
- `src/ui/Styles.html` — `.cache-panel` / `.cache-actions` /
  `.cache-aggregate` / `.cache-keys` styles, matching the Triggers
  panel's vocab.
- `docs/architecture.md` — §7 + §7.5 edits described above.
- `docs/build-plan.md` — Chunk 10.5 header + sub-task checkboxes.

## Deferrals respected

The Chunk 10.5 "Out of scope" list:

- Materialized roll-ups / `DashboardCache` tab — not built.
- Client-side caching (sessionStorage / IndexedDB) — deferred to
  Chunk 10.6.
- Per-user cache scope — not built as a default; explicitly noted as a
  per-call-site future option.
- Refactoring the Importer / Expiry diff logic — not touched; only
  invalidation calls were added.

## Next

Chunk 10.6 (client-side navigation) doesn't depend structurally on this
chunk, but the cache wins stack cleanly. Its `ApiShared_renderPage`
endpoint should benefit for free because every `Config_get` / roster
read that runs during the swap is already memoized.

Watch for: if a future chunk adds a new memoized read, remember to add
its key to `Cache_knownKeys_()` in `core/Cache.gs`, or
`Cache_invalidateAll()` (and the Clear cache button) won't touch it. A
grep for `Cache_memoize(` against the key list is a sufficient audit.
