# Tasks

Deferred work items surfaced in session but not yet scheduled into a chunk. These are NOT a chunk backlog (see `build-plan.md` for numbered chunks); they're smaller follow-ups and design questions the user has flagged. Check this file at the start of a session along with the other "start each session by reading" docs so ongoing work isn't dropped.

Format per task: a short imperative title, then **Why / what**, **Decisions to make before coding**, and **Files likely touched**. Mark completed tasks with `[DONE <date>]` and leave them in place for a while as trail, or prune once they're in a commit that's clearly shipped.

---

## 1. Preserve manually-inserted Access rows through imports [DONE 2026-04-23]

**Why / what.** The importer currently owns the entire `Access` tab — any row not produced by the current import run gets deleted (see `spec.md` §3.2 "Not manually edited" and §8 step 5). We want to support manual Access entries that survive imports, so a Kindoo Manager can grant app access to someone whose calling doesn't appear in the templates (or who doesn't hold a calling at all).

**What shipped.** Added `source` as a fourth column to the `Access` tab with values `'importer' | 'manual'`. The importer stamps every insert as `source='importer'` and scopes its delete-not-seen step to `source='importer'` rows only; `source='manual'` rows are invisible to the importer. The insert dedup check still considers ALL rows (regardless of source) so the importer will never create a duplicate composite-key row alongside an existing manual row — the B1 decision. Role resolution (`Auth_resolveRoles` → `Access_getByEmail`) is untouched: a manual row grants the same roles as an importer row.

The manager Access page grew write affordances: source badge column, Delete button on manual rows (rejected server-side for importer rows as defense in depth), and an "Add manual access" form at the bottom with email / scope dropdown / reason free-text. For manual rows the `calling` column holds a free-text reason (A1) rather than a literal calling name — same column, same composite PK, UI labels it "Reason".

Two new endpoints: `ApiManager_accessInsertManual(token, row)` and `ApiManager_accessDeleteManual(token, email, scope, calling)`. Both take `Lock_withLock`, write one AuditLog row with `actor_email = principal.email` (not `'Importer'`), and enforce their invariants: insert rejects composite-key collisions against any existing row; delete rejects non-manual rows with a clean error. Scope is validated against `Wards_getAll()` + `'stake'` on insert so a typo can't create an unreachable role grant.

**Migration.** Zero data-migration. The header bump to 4 columns causes a loud `Access header drift at column 4: expected "source", got "…"` error on first read after deploy. Operator adds `source` as column D header by hand. Existing rows' empty `source` cells map to `'importer'` via `Access_normaliseSource_` at the read boundary. Fresh installs (via `setupSheet`) get the 4-col header seeded directly.

**Decisions locked in.** A1 (free-text reason in the shared `calling` column), B1 (importer no-ops on PK collision with any existing row, preserving manual provenance), C1 (UI allows deleting manual rows only).

**Files touched.** `src/repos/AccessRepo.gs`, `src/services/Importer.gs`, `src/api/ApiManager.gs`, `src/ui/manager/Access.html`, `src/ui/Styles.html`, `src/services/Setup.gs`, `docs/spec.md` (§3.1 Access entry + §8 step 5), `docs/data-model.md` Tab 7, `docs/sheet-setup.md` Tab 7.

---

## 2. Convert wide tables to card layout [DONE 2026-04-23]

**Why / what.** The shared `renderRosterTable` helper in `src/ui/ClientUtils.html` renders narrow columns that wrap text across many lines on realistic data (long names, multiple buildings, long calling names, long audit diffs). Rework five pages to use a card-per-row layout similar to the manager Requests Queue.

**What shipped.** Added a sibling `renderRosterCards(rows, opts)` + `rosterCardHtml(row, opts)` to `src/ui/ClientUtils.html` with the same `opts` shape (`showScope` / `emptyMsg` / `rowActions` / `preview`) so page migrations were a one-line swap. Cards use a compact flex-row layout — badges + member + labeled chips + action strip sit inline on wide viewports, wrap onto a continuation line on narrow ones. The stack has NO gap between cards (shared bottom border, tight vertical padding) so the visual density matches a table row, per the "still look like table rows" constraint the user added mid-implementation.

Migrated four roster pages: `bishopric/Roster.html`, `stake/Roster.html`, `stake/WardRosters.html`, `manager/AllSeats.html`. Each was a one-line swap from `renderRosterTable` → `renderRosterCards` + drop the now-irrelevant `actionsHeader` opt.

Migrated `manager/AuditLog.html` inline: replaced its custom `<tr>`-based `rowHtml` with a `.audit-card` compact flex-row renderer. Kept the `<details>` expansion — it sits inside the card body as a full-width flex child (`flex: 0 0 100%`) so it wraps onto its own line when opened, matching the roster pattern.

**Kept `renderRosterTable` alive.** The five inline preview / duplicate-warning call sites on `manager/RequestsQueue.html` (4) and `NewRequest.html` (1) still use the table renderer. A compact table is less noisy than a nested card-inside-a-card when previewing a single row or a small duplicate-warning list inside an existing card. So `renderRosterTable` + `rosterRowHtml` + `.roster-table` CSS all remain in the codebase — the five primary pages just don't call them anymore.

**CSS cleanup.** Removed `.audit-row-diff`, `.audit-row-summary-inline`, `.audit-row-note` (superseded by `.audit-card-*` family) and dropped `.audit-log-table` / `.roster-table` from the mobile-breakpoint horizontal-scroll rule (cards flex-wrap natively).

**Decisions locked in.**
- Sibling helper (safer than replacing in-place); migrate page-by-page.
- Shared `rowActions` fn matches `renderRosterTable`'s API so callers swapping helpers don't reshape their per-row action wiring.
- AuditLog `<details>` survives inside the card — clicking "details" still reveals the before/after diff inline.
- Row-feel visual density (no gap, shared border, tight padding) per mid-implementation user clarification.

**Files touched.** `src/ui/ClientUtils.html` (new helper), `src/ui/Styles.html` (card CSS + cleanup), `src/ui/manager/AllSeats.html`, `src/ui/manager/AuditLog.html`, `src/ui/stake/Roster.html`, `src/ui/bishopric/Roster.html`, `src/ui/stake/WardRosters.html`.

---

## 3. Drop `ward_code` from All Seats summary cards [DONE 2026-04-23]

**Why / what.** The per-scope summary cards on the manager All Seats page currently display the `ward_code` alongside the ward name. The ward name alone is enough; the code is noise.

**What shipped.** The `scope-sub` line (rendering "ward_code: XX" for wards, "Stake" for the stake pool) is gone from `renderSummaries` in `src/ui/manager/AllSeats.html`; ward_name is the only per-scope label. The orphaned `.all-seats-summary-card .scope-sub` CSS rule was deleted from `src/ui/Styles.html` and the `.scope-label` rule's bottom-margin was bumped from 4px → 6px to keep the spacing to the utilization bar consistent. No server-side change — `summaries[].scope` still carries the ward code, just unused in the card.

**Files likely touched.** `src/ui/manager/AllSeats.html` (and check whether the code surfaces through `ApiManager_allSeats` / `services/Rosters.gs` vs. rendered client-side — the fix goes wherever the card template is).

---

## 4. Rename Config UI labels: calling templates → "Auto ... Callings" [DONE 2026-04-23 — UI labels only]

**Why / what.** On the manager Configuration page, the two calling-template section labels should read:
- "Ward Calling Template" → **"Auto Ward Callings"**
- "Stake Calling Template" → **"Auto Stake Callings"**

**What shipped.** UI-label-only rename in `src/ui/manager/Config.html` (not `Configuration.html` — the file is `Config.html`). The two `config-tab-btn` labels now read "Auto Ward Callings" / "Auto Stake Callings". The `label` argument that `renderTemplate` inlined into "No <label> template rows yet" / "Add a <label> calling" was removed (the new labels made those constructions awkward — "No Auto Ward Callings template rows yet"); the surrounding tab already names the template, so the empty-state now reads "No callings yet. Add one below." and the add-form heading reads "Add a calling." Sheet tab names (`WardCallingTemplate` / `StakeCallingTemplate`) and every server-side callsite (`Setup.gs`, `TemplatesRepo.gs`, `Importer.gs`) are untouched. Spec / data-model / sheet-setup docs still reference the existing tab names, which is consistent with a UI-only rename.

**Decisions made.**
- UI label only (the TASKS.md "safer default"). Full sheet-tab rename was not confirmed by the user and would have been a live-Sheet migration.
- If the user later wants the full rename: update `docs/spec.md` §3.1, `docs/data-model.md` section headings, `docs/sheet-setup.md` tab list, plus `src/services/Setup.gs`, `src/repos/TemplatesRepo.gs`, `src/services/Importer.gs` callsites.

**Files touched.** `src/ui/manager/Config.html` only.

---

## 5. Rebuild the Dashboard screen

**Why / what.** The manager Dashboard (the default landing for the `manager` role) needs a redesign. Today it's five cards per `spec.md` §5.3: pending-request counts, recent activity, per-scope utilization, over-cap warnings, and last-operations timestamps, all driven by a single `ApiManager_dashboard` rpc. The user has flagged this as wanting a rebuild; the *what* of the rebuild is still open.

**Decisions to make before coding.**
- Which cards stay, which go, and what replaces them. Is the goal more-dense (more signals per screen), less-dense (a focused "what needs attention right now" landing), or a different shape entirely (e.g., a feed of events rather than counts + bars)?
- New data the server needs to shape. The current dashboard is one round-trip; a rebuild that needs new aggregates (e.g., request-type breakdown over time, per-requester throughput, expiry forecast) might need additions to `ApiManager_dashboard` or a new endpoint.
- Interaction model. Today every tile deep-links into a filtered downstream page. Keep that pattern? Add inline drill-down / expand-in-place?
- Mobile layout. Current grid is `repeat(auto-fit, minmax(300px, 1fr))` and collapses to single-column at ≤ 640px. If the new design changes card size / count, confirm it still reads at ~375px.

**Files likely touched.** `src/ui/manager/Dashboard.html`, `src/api/ApiManager.gs` (`ApiManager_dashboard` aggregate + any new fields), `src/services/Rosters.gs` (if the new utilization view needs a different summary shape), `src/ui/Styles.html` (`.dashboard-*` rules), `docs/spec.md` §5.3, `docs/architecture.md` (the utilization-math section near the `Rosters_buildContext_` reuse note), and a changelog entry if the rebuild is substantial enough to warrant its own chunk.

---

## 6. Use OAuth to try and get rid of the Apps Script warning [DONE 2026-04-25 — addressed by Chunk 11 iframe wrapper]

The "warning" referred to the *"This application was created by a Google Apps Script user"* banner. Chunk 11 removed it via a different mechanism than the task originally framed: a static GitHub-Pages-hosted wrapper page at `https://kindoo.csnorth.org` containing a full-viewport iframe to the Main `/exec` URL, with `setXFrameOptionsMode(ALLOWALL)` on every `doGet` HtmlOutput permitting the embed. The top frame never loads Apps Script's banner-bearing outer wrapper page, so the banner is gone. See `docs/changelog/chunk-11-custom-domain.md`. OAuth verification submission to Google was not needed and remains optional — it could remove the first-time per-user consent prompt on the Identity project, which is a different concern from the banner.

---

## 7. Fix the remove button on Roster screens
