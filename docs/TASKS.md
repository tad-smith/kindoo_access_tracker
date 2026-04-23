# Tasks

Deferred work items surfaced in session but not yet scheduled into a chunk. These are NOT a chunk backlog (see `build-plan.md` for numbered chunks); they're smaller follow-ups and design questions the user has flagged. Check this file at the start of a session along with the other "start each session by reading" docs so ongoing work isn't dropped.

Format per task: a short imperative title, then **Why / what**, **Decisions to make before coding**, and **Files likely touched**. Mark completed tasks with `[DONE <date>]` and leave them in place for a while as trail, or prune once they're in a commit that's clearly shipped.

---

## 1. Preserve manually-inserted Access rows through imports

**Why / what.** The importer currently owns the entire `Access` tab — any row not produced by the current import run gets deleted (see `spec.md` §3.2 "Not manually edited" and §8 step 5). We want to support manual Access entries that survive imports, so a Kindoo Manager can grant app access to someone whose calling doesn't appear in the templates (or who doesn't hold a calling at all).

**Decisions to make before coding.**
- How do we distinguish manual from importer-inserted rows? Candidates:
  - New `source` column (`'importer' | 'manual'`). Cleanest. Requires a schema migration on the live Sheet (add column to `Access` tab; update `ACCESS_HEADERS_` in `AccessRepo.gs`).
  - Sentinel empty `calling` value for manual rows. No schema change, but collides with the existing repo contract and breaks the `(email, scope, calling)` diff key.
  - Maintain a parallel `ManualAccess` tab. Adds a tab but keeps `Access` as-is.
- Does the spec flip from "importer-owned" to "jointly owned"? (§3.2 needs a full rewrite either way.)
- UI surface: the manager Access page is read-only today. We'd need inline add / remove affordances and a server endpoint.
- Audit trail: manual inserts should carry `actor_email = <manager>`, not `'Importer'`.

**Files likely touched.** `src/repos/AccessRepo.gs`, `src/services/Importer.gs` (diff logic needs to skip manual rows on the delete-not-seen step), `src/api/ApiManager.gs`, `src/ui/manager/Access.html` (currently read-only), `src/services/Setup.gs` (header row), `docs/spec.md` §3.2 + §8, `docs/data-model.md` Access tab, `docs/sheet-setup.md` (if adding a column).

---

## 2. Convert wide tables to card layout

**Why / what.** The shared `renderRosterTable` helper in `src/ui/ClientUtils.html` renders narrow columns that wrap text across many lines on realistic data (long names, multiple buildings, long calling names, long audit diffs). Rework five pages to use a card-per-row layout similar to the manager Requests Queue (see `src/ui/manager/RequestsQueue.html` for the reference look — metadata header, body block, action strip).

**Pages affected.** `src/ui/manager/AllSeats.html`, `src/ui/manager/AuditLog.html`, `src/ui/stake/Roster.html`, `src/ui/bishopric/Roster.html`, `src/ui/stake/WardRosters.html`.

**Decisions to make before coding.**
- Replace `renderRosterTable` entirely, or ship a sibling `renderRosterCards` and migrate page-by-page? (Safer: sibling — lets each page be reviewed independently.)
- Card layout needs to carry per-row action affordances (remove X on rosters, Edit button on AllSeats). Factor a shared `renderRosterCard` that accepts an `opts.rowActions` fn, matching the current table's API.
- `AuditLog` rows currently have a `<details>` expansion block for the full before/after diff — the card design has to keep that working (probably by rendering the details inside the card body).
- Mobile responsiveness: `RequestsQueue` cards already stack; reuse the same CSS scaffolding.

**Files likely touched.** `src/ui/ClientUtils.html` (new card renderer + possibly retiring `renderRosterTable`), all five pages above, `src/ui/Styles.html` (card styles — possibly just promote the existing `.queue-card*` selectors to a shared class).

---

## 3. Drop `ward_code` from All Seats summary cards

**Why / what.** The per-scope summary cards on the manager All Seats page currently display the `ward_code` alongside the ward name. The ward name alone is enough; the code is noise.

**Files likely touched.** `src/ui/manager/AllSeats.html` (and check whether the code surfaces through `ApiManager_allSeats` / `services/Rosters.gs` vs. rendered client-side — the fix goes wherever the card template is).

---

## 4. Rename Config UI labels: calling templates → "Auto ... Callings"

**Why / what.** On the manager Configuration page, the two calling-template section labels should read:
- "Ward Calling Template" → **"Auto Ward Callings"**
- "Stake Calling Template" → **"Auto Stake Callings"**

**Decisions to make before coding.**
- UI label only, or also rename the underlying sheet tab names (`WardCallingTemplate` / `StakeCallingTemplate`)?
- Safer default: UI label only. The tab-name rename would be a live-Sheet migration + `TABS_` in `Setup.gs` + every `Templates_getAll('ward'|'stake')` callsite that maps `'ward'/'stake'` to the old tab names. Confirm with user before escalating.
- If the user wants the full rename, update `docs/spec.md` §3.1, `docs/data-model.md` section headings, and `docs/sheet-setup.md` tab list.

**Files likely touched.** `src/ui/manager/Configuration.html` (UI labels). If full rename: `src/services/Setup.gs`, `src/repos/TemplatesRepo.gs`, `src/services/Importer.gs` (callsites), docs as above.
