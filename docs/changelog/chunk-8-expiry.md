# Chunk 8 — Expiry trigger

**Shipped:** 2026-04-21
**Commits:** _(see git log; commit messages reference "Chunk 8")_

## What shipped

The daily temp-seat expiry job is live. A time-based trigger fires
`Expiry_runExpiry` once a day at `Config.expiry_hour` (default `3`,
i.e. 03:00 in the script timezone — `America/Denver`). The job scans
`Seats` for rows with `type=temp` and `end_date < today` (computed
from `Utils_todayIso()`), deletes every matching row inside one
`Lock_withLock(30 s)`, and flushes one `auto_expire` AuditLog entry
per deleted row via `AuditRepo_writeMany` at end of run. Logs a
`[Expiry] completed in Xms — N rows expired` summary at the end. No
email is sent — spec §9 doesn't list auto-expire as an email trigger.

The Chunk-4 `TriggersService_install` stub becomes real. The install
is idempotent: it scans existing project triggers, removes any whose
handlerFunction matches a planned handler (today: just
`Expiry_runExpiry`; Chunk 9 will add `Importer_runImport`), and
creates fresh ones from the current Config. Triggers for unknown
handlers are left alone so an ad-hoc operator-installed trigger
doesn't get clobbered.

The bootstrap wizard's Complete-Setup step already called the stub
(Chunk 4). It now calls the real implementation — same interface
(`TriggersService_install()` returns a `{installed, removed, message}`
shape), so no Bootstrap.gs change was required. The `setup_complete`
audit row's `after_json.triggers_install` field now carries the real
install summary (e.g. `"[TriggersService] installed 1 trigger(s):
Expiry_runExpiry @ 3:00 daily"`) instead of the Chunk-4 stub's log
line.

A manager self-heal surface lives on the Configuration page's
key-value Config tab:

- A **"Reinstall triggers"** button next to a live list of currently-
  installed triggers. Clicking it calls `ApiManager_reinstallTriggers`
  (same code path as the bootstrap wizard's install), which wraps
  `TriggersService_install` in `Lock_withLock` and writes one
  `AuditLog` row with `action='reinstall_triggers'`,
  `entity_type='Config'`, `entity_id='triggers'`, and before/after
  payloads carrying the full trigger list so an operator can see what
  was removed and what was installed.
- A hint on the `expiry_hour` row explaining that saving the new
  value alone does NOT reschedule the existing trigger — the operator
  must click "Reinstall triggers" for the new hour to take effect.
  Saving `expiry_hour` also fires a warn-level toast reminding them
  of this.

`Kindoo Admin → Install/reinstall triggers` and `Kindoo Admin → Run
expiry now` menu items were added to `onOpen` so an operator can
self-heal triggers or kick the expiry job straight from the bound
Sheet, without loading the web app.

Implemented:

- **`services/Expiry.gs#Expiry_runExpiry()`** — replaces the
  Chunk-1 one-line stub. Wraps the full run in one `Lock_withLock`
  with `timeoutMs: 30000` (matching the Importer, per architecture.md
  §6). Inside the lock: `Seats_getAll()` once, filter to
  `type=temp && end_date && end_date < today`, iterate and call
  `Seats_deleteById` per match collecting the `before` row,
  `AuditRepo_writeMany` at end of run. Returns
  `{ expired, ids, elapsed_ms }`. Logs a `[Expiry] completed …`
  summary.
- **`services/TriggersService.gs`** — replaces the Chunk-4 no-op
  stub. `Triggers_plan_()` returns a descriptor list of planned
  handlers; today just `Expiry_runExpiry` with a closure that reads
  `Config.expiry_hour` at install time. `TriggersService_install()`
  idempotently removes every existing trigger whose handlerFunction
  is in the plan, then installs the plan. Returns
  `{installed, removed, message}`. Sibling `TriggersService_list()`
  returns the current trigger set in a shape safe to send over
  `google.script.run` (handler name, event type, unique id).
- **`api/ApiManager.gs`** — added `ApiManager_listTriggers` (read-
  only) and `ApiManager_reinstallTriggers` (wrapped in
  `Lock_withLock`, writes one `reinstall_triggers` audit row with
  before/after trigger lists).
- **`services/Setup.gs`** — `onOpen` menu gained
  "Install/reinstall triggers" (→ `TriggersService_install`) and
  "Run expiry now" (→ `Expiry_runExpiry`). `Config.expiry_hour`
  was already seeded by `SETUP_CONFIG_SEED_` from Chunk 1 with
  default `3`; no schema change this chunk.
- **`ui/manager/Config.html`** — key-value Config tab gained a
  "Scheduled triggers" panel at the bottom: a "Reinstall triggers"
  button with a small inline status line ("Installed N trigger(s)
  at HH:MM:SS"), and a live list of currently-installed triggers
  (rendered from `ApiManager_listTriggers`, refreshed inline after
  each reinstall without another round-trip because the endpoint
  already returns the post-install list). The `expiry_hour` row
  gains a small hint explaining the reinstall round-trip; saving
  the key fires a warn toast reminding the operator to click
  Reinstall.
- **`ui/Styles.html`** — added `.config-key-hint` (small grey inline
  hint under a key name) and `.triggers-panel` / `.triggers-actions`
  / `.triggers-status` / `.triggers-list-ul` / `.triggers-meta`
  styles for the new panel.

No existing repo or service needed a schema change; `Seats_deleteById`
(Chunk 7) and `AuditRepo_writeMany` (Chunk 3) already existed in the
shape Expiry needs. `Utils_todayIso()` (Chunk 1) already returns
today in the script timezone. `Config.expiry_hour` (Chunk 1 seed,
Chunk 2 CRUD) was already editable from the manager surface — only
the reinstall-triggers round-trip UX needed spelling out.

## Deviations from the pre-chunk spec

- **`TriggersService_install` uses an "always remove + recreate"
  idempotency strategy**, not an "inspect existing, diff, selectively
  mutate" one. The pre-chunk prompt suggested the latter ("read the
  existing trigger's hour via getHourOfDay if accessible, or simpler:
  always delete existing + recreate"). Went with the simpler path:
  `Trigger` objects don't expose `getAtHour()` (it's a build-side
  method on `TriggerBuilder`), so detecting "the existing trigger
  already matches" would require storing a parallel "what we
  installed last time" Config key — more state, more places to
  disagree. At 1–2 installs over the lifetime of the deployment,
  the recreate-on-every-call cost is negligible. Documented in
  `architecture.md §9.3`.
- **Triggers for unknown handlerFunctions are left alone.** The
  install loop only removes triggers whose handlerFunction matches a
  planned handler (`Expiry_runExpiry` today, `Importer_runImport`
  next chunk). An operator who installed an ad-hoc trigger via the
  Apps Script editor (an onOpen, a debug timer, whatever) won't
  lose it when a manager clicks Reinstall. This was not spelled out
  in the pre-chunk prompt; explicit choice rather than a side-effect
  of convenient code.
- **Audit `action='reinstall_triggers'`** is a new entry in the
  action vocabulary (`data-model.md` §10). Pre-chunk had no audit
  verb for this; chose a dedicated action over overloading `update`
  because the before/after payload shape is distinct (it carries
  trigger descriptors, not a Config key's value).

## Decisions made during the chunk

- **Seats with empty `end_date` on type=temp are skipped (logged,
  not thrown).** The schema allows `end_date=''` on manual rows
  (Seats_update silently ignores date patches for non-temp rows),
  but `type=temp` with empty `end_date` is a malformed row that
  shouldn't exist under normal operation. A manual Sheet edit could
  produce one. Rather than throw (which would abort the whole
  expiry run and leave every other expiring row un-deleted), the
  run logs the anomaly and moves on. No audit row — `auto_expire`
  requires a `before` row, and the skip-path has nothing to record.
- **String comparison for `end_date < today`.** Both values are
  `YYYY-MM-DD` ISO date strings which sort chronologically under
  lexical comparison, so `String(s.end_date) < today` is both
  cheap and correct. No `new Date()` parsing, which would re-open
  the timezone question.
- **Bulk-audit via `AuditRepo_writeMany`, not N per-row
  `AuditRepo_write` calls.** Chunk 3's pattern carries over: one
  `setValues` instead of N `appendRow` calls. Volume is smaller
  here (maybe 1–5 rows/week vs. the importer's first-run ~250),
  but the shape stays consistent so future reviewers don't have
  to distinguish "small batch write, do it per row" from "big
  batch write, collect and flush".
- **30 s `timeoutMs` on the Expiry lock.** Same as the Importer
  (architecture.md §6). The actual work here is much shorter — a
  handful of `deleteRow` calls plus one audit `setValues` — so the
  wait-budget almost never matters in practice. Stayed at 30 s
  for consistency with the other long-form writer, which also
  gives headroom if scale grows or if the trigger happens to fire
  during a concurrent manual import.
- **Manager "Reinstall triggers" wraps in `Lock_withLock`.**
  Trigger install doesn't touch the Sheet tabs directly, but the
  audit row write does, and the pattern is "every write is
  serialised" (architecture.md §6). Keeping the lock makes the
  endpoint symmetric with every other `ApiManager_*` write and
  lets the audit row land inside the same acquisition as the
  trigger mutation.
- **`ApiManager_reinstallTriggers` returns the post-install
  triggers list so the UI can render without a second rpc.**
  Same pattern as `ApiManager_kindooManagersDelete` returning the
  new counts in-band. Keeps the click → render cycle to one
  round-trip.
- **`onOpen` menu gains both install AND run-now entries.** Two
  separate operator needs: (a) "I just changed `expiry_hour` in
  the Sheet directly and want to re-schedule the trigger" — use
  Install/reinstall triggers; (b) "I added a temp seat for
  testing with a past end_date and want to watch it disappear
  right now" — use Run expiry now. Both surface the summary in
  the execution log.
- **`expiry_hour` save-toast warns the operator to reinstall.**
  The alternative would have been to reinstall triggers
  automatically on every `expiry_hour` save. Rejected: a config
  save and a trigger reinstall are different operations with
  different audit entries, and bundling them would make the
  "Reinstall triggers" button feel like a no-op (the save already
  did it). Keeping them separate mirrors the pattern we use
  everywhere else (saving a Ward's seat_cap doesn't retroactively
  update over-cap warnings; saving a template doesn't re-run the
  importer).

## Post-implementation fix: date-column render drift (2026-04-22)

Surfaced during UI review: temp-seat `start_date` / `end_date` values
were rendering in the bishopric roster, stake roster, MyRequests, and
the manager Requests Queue with a full JavaScript Date string — e.g.
`Wed Apr 20 2026 00:00:00 GMT-0600 (Mountain Daylight Time)` — instead
of the declared `YYYY-MM-DD`.

**Root cause.** Google Sheets auto-coerces typed `YYYY-MM-DD` values
into `Date` cell objects on entry. `getValues()` then hands the repo
a `Date`, and the repo row-mappers did `String(row[n])` which on a
`Date` yields the long locale-formatted string. Data-model.md
declared these fields as text but the backing Sheet silently promoted
them.

**Load-bearing for this chunk.** `Expiry_runExpiry` compares
`String(s.end_date) < today` where `today = Utils_todayIso()` is
`YYYY-MM-DD`. If `end_date` arrived as a `Date` object, the compare
would be against `"Wed Apr 20 …"` which sorts AFTER `"2026-…"`
lexically — the expiry would never fire on real data. The fix is a
prerequisite for Chunk 8's acceptance criteria, not just a cosmetic
UI nit.

**Fix.** New `Utils_formatIsoDate(value)` helper in `core/Utils.gs`:
`null`/`''` → `''`; `Date` → `yyyy-MM-dd` in the script timezone
(matches `Utils_todayIso` so both sides of the compare live in the
same tz); plain string → trimmed as-is.

Applied at every `start_date` / `end_date` boundary:

- `Seats_rowToObject_` (read), `Seats_insert` (write), `Seats_update`'s
  temp-only date patch branch.
- `Requests_rowToObject_` (read), `Requests_normaliseInput_` (write).

Timestamps (`created_at`, `requested_at`, `completed_at`, etc.) are
untouched — those are declared as `Date` in data-model.md and the API
layer formats them for display via `Utilities.formatDate`.

## Spec / doc edits in this chunk

- `docs/spec.md` — §7 rewritten: names the `Expiry_runExpiry` entry,
  the `Utils_todayIso` timezone semantics (with the `2026-04-21` /
  `2026-04-22` worked example), the 30 s lock, the
  `AuditRepo_writeMany` batching, the no-email rule, and the
  `TriggersService_install` reinstall-on-hour-change contract.
- `docs/architecture.md` — §9.2 ("Expiry") rewritten to reflect the
  shipped implementation (public entry name, `Utils_todayIso` rule,
  30 s lock, batched audit flush, `ExpiryTrigger` actor literal, no
  email, R-1 interaction). §9.3 ("Trigger management") rewritten
  end-to-end for the real install: idempotency strategy, return
  shape, invocation sites (wizard / manager UI / sheet menu), and
  the UX contract around `Config.expiry_hour`.
- `docs/data-model.md` — §10 action vocabulary gains
  `reinstall_triggers`. `Config.expiry_hour` was already documented
  in Chunk 1; no change there.
- `docs/build-plan.md` — Chunk 8 marked
  `[DONE — see docs/changelog/chunk-8-expiry.md]`; sub-tasks rewritten
  to match what shipped; acceptance criteria expanded to cover the
  idempotency contract, the manager self-heal surface, the bootstrap
  audit-row integration, the timezone edge cases, the non-temp /
  same-day / future-day no-delete cases, and the R-1 race
  integration with Chunk 7.
- `docs/changelog/chunk-8-expiry.md` — this file.

## New open questions

None blocking. One minor item worth flagging for polish later:

- **Q-8.1 (P2) — Surface "last expiry run" timestamp + summary on
  the manager Dashboard (Chunk 10).** Today the only way to see
  when the daily expiry last ran and how many rows it removed is
  either the AuditLog tab (raw) or the Apps Script execution log
  (transient). Chunk 10's Dashboard should add a small
  "last expiry: 2026-04-22 03:00, 2 rows" card alongside the
  existing "last import" card. Not building now — it's a pure
  readability polish and the data's all there.

## Files created / modified

**Created**

- `docs/changelog/chunk-8-expiry.md` — this file.

**Implemented (replaced 1-line / stub code with real code)**

- `src/services/Expiry.gs` — real `Expiry_runExpiry` (replaces the
  Chunk-1 one-line stub).
- `src/services/TriggersService.gs` — real `TriggersService_install`
  + new `TriggersService_list` (replaces the Chunk-4 no-op stub).

**Modified**

- `src/api/ApiManager.gs` — added `ApiManager_listTriggers` +
  `ApiManager_reinstallTriggers`.
- `src/services/Bootstrap.gs` — extracts `.message` from the new
  `TriggersService_install` return shape so the `setup_complete`
  audit row's `after_json.triggers_install` stays a human-readable
  string.
- `src/services/Setup.gs` — `onOpen` menu gains
  "Install/reinstall triggers" and "Run expiry now".
- `src/core/Utils.gs` — added `Utils_formatIsoDate(value)` (see
  "Post-implementation fix" above).
- `src/repos/SeatsRepo.gs` — `start_date` / `end_date` routed through
  `Utils_formatIsoDate` on read (`Seats_rowToObject_`), insert
  (`Seats_insert`), and temp-only update patches (`Seats_update`).
- `src/repos/RequestsRepo.gs` — same treatment for the Request-side
  date columns (`Requests_rowToObject_`, `Requests_normaliseInput_`).
- `src/ui/manager/Config.html` — key-value Config tab gains the
  "Scheduled triggers" panel (reinstall button, live triggers
  list). `expiry_hour` row gains a hint + save-toast reminder.
- `src/ui/Styles.html` — added `.config-key-hint` and `.triggers-*`
  styles.
- `docs/spec.md`, `docs/architecture.md`, `docs/data-model.md`,
  `docs/build-plan.md` — per "Spec / doc edits in this chunk"
  above.

**Untouched (still 1-line stubs, deferred per build-plan later chunks)**

- `src/ui/manager/Dashboard.html`, `src/ui/manager/AuditLog.html` —
  Chunk 10.

## Confirmation that the Chunk 8 deferrals list was respected

Per `build-plan.md` Chunk 8 → "Out of scope":

- ✅ **Notifying users when their temp seat expires** — not built.
  `services/EmailService.gs` untouched; no new notification
  wrapper; `Expiry_runExpiry` sends no mail.
- ✅ **Weekly import trigger** — not installed. `Triggers_plan_()`
  has a single entry (`Expiry_runExpiry`); Chunk 9 adds the weekly
  importer entry without changing the install/uninstall loop.
- ✅ **Over-cap warning emails** — no cap math in Expiry. Chunk 9.
- ✅ **Dashboard / Audit Log page** — both stubs untouched;
  Chunk 10.
- ✅ **Cloudflare Worker** — Chunk 11.
- ✅ **No refactoring of Chunk 5/6/7 code beyond adding the
  triggers panel to the existing Config page** — Rosters,
  RequestsService, EmailService, SeatsRepo, RequestsRepo all
  untouched. Utilization math was confirmed (Chunk 5) to count
  every row regardless of `end_date`, so expiry naturally drops
  the count and clears the "expired" badge once the row is gone
  — no code change.

## Manual test walk-through

Mirrors the "demonstrate" list in the chunk-8 prompt.

1. **Past-date temp seat expires on manual run.** Insert a temp
   seat with `end_date=2026-04-20` (yesterday in `America/Denver`).
   Run `Expiry_runExpiry` from the Apps Script editor (or
   `Kindoo Admin → Run expiry now`). The row is deleted; AuditLog
   gets one row with `actor_email='ExpiryTrigger'`,
   `action='auto_expire'`, `entity_type='Seat'`,
   `entity_id=<seat_id>`, `before_json` carrying the full deleted
   row, `after_json` empty. The seat disappears from every roster
   page immediately; the "expired" badge it was carrying goes
   with it.
2. **Today-dated temp seat does NOT expire.** Insert a temp seat
   with `end_date=2026-04-21` (today). Run the expiry job. Seat
   stays; no audit row. The lexical compare `'2026-04-21' <
   '2026-04-21'` is false.
3. **Future-dated temp seat does NOT expire.** Insert a temp seat
   with `end_date=2026-04-22` (tomorrow). Run the expiry job.
   Seat stays; no audit row.
4. **Auto and manual seats are NOT deleted regardless of dates.**
   Insert a manual seat (no `end_date`) and an auto seat (via
   Import Now). Run expiry. Neither row moves; no audit row. The
   `type !== 'temp'` guard at the top of the scan keeps them out.
5. **Idempotent second run.** Immediately after a run that
   deleted rows, re-run `Expiry_runExpiry`. Summary is
   `{expired: 0, ids: [], elapsed_ms: …}`. AuditLog gains zero
   new rows (the service doesn't write a start/end bracket on an
   empty run — unlike the Importer, there's nothing to bracket
   if no rows expired).
6. **`TriggersService_install` on a fresh project.**
   `ScriptApp.getProjectTriggers()` returns `[]`. Run
   `TriggersService_install()`. Return shape is
   `{installed: ['Expiry_runExpiry'], removed: [],
   message: '[TriggersService] installed 1 trigger(s):
   Expiry_runExpiry @ 3:00 daily'}`. `getProjectTriggers()` now
   returns one daily trigger for `Expiry_runExpiry` at hour 3.
7. **Re-running `TriggersService_install`** removes the existing
   trigger and installs a fresh one:
   `{installed: ['Expiry_runExpiry'], removed: ['Expiry_runExpiry'],
   message: '… (removed 1 prior)'}`. The unique_id changes; the
   schedule doesn't.
8. **Bootstrap Complete-Setup with the real install.** On a
   fresh wizard run, clicking Complete Setup now produces an
   AuditLog row with `action='setup_complete'` whose `after_json`
   carries a real `triggers_install` string like `"[TriggersService]
   installed 1 trigger(s): Expiry_runExpiry @ 3:00 daily"` (not
   the Chunk-4 stub's `"is a no-op until Chunks 8 …"` message).
9. **Manager "Reinstall triggers" button.** On
   `?p=mgr/config` → Config (key/value) tab, the bottom-of-page
   "Scheduled triggers" panel lists the current trigger
   (`Expiry_runExpiry (CLOCK)` or similar). Clicking Reinstall:
   status line flips to "Reinstalling…", then to
   "Installed 1 trigger(s) (removed 1 prior) at HH:MM:SS".
   Success toast fires. AuditLog gains one row with
   `action='reinstall_triggers'`, `entity_type='Config'`,
   `entity_id='triggers'`, before/after carrying the trigger
   lists.
10. **`expiry_hour` edit UX.** Change `expiry_hour` from `3` to
    `5` inline, click Save. Toast reads *"Saved. Click 'Reinstall
    triggers' to apply the new hour."* (warn-level). Clicking
    Reinstall immediately after: Apps Script editor's Triggers
    list now shows the daily trigger at hour 5.
11. **R-1 race integration with Chunk 7.** Seed a temp seat with
    `end_date=2026-04-20` (yesterday) and submit a `remove`
    request for it via the bishopric Roster. Run
    `Expiry_runExpiry`: the seat is deleted; AuditLog has
    `auto_expire`. The Request is still pending. Now as a
    manager, click Complete on the pending remove in the queue.
    The Chunk-7 R-1 path fires: the Request flips to `complete`
    with `completion_note='Seat already removed at completion
    time (no-op).'`, ONE audit row written
    (`complete_request` — no Seat audit because there was no
    Seat to delete). Two audit rows total across the two
    operations (auto_expire from Expiry, complete_request from
    Complete), clean trail.
12. **Utilization transition.** Cap a ward at 20; seat 19
    manual + 1 temp with `end_date=yesterday`. Before expiry:
    roster shows "20/20 · 1 expired" badge. After
    `Expiry_runExpiry`: "19/20", badge gone, no other changes.
    No code change needed — Chunk 5's math counts every row;
    expiry's delete naturally reduces the count.

## Next

Chunk 9 (Weekly import trigger + over-cap warnings) extends
`TriggersService.gs` with a second planned handler for
`Importer_runImport`. The install/uninstall loop already handles
more than one handler (`Triggers_plan_()` returns an array);
adding the importer entry and its `kind: 'weekly'` spec-builder
keeps the diff narrow. The over-cap email (Chunk 9) is a new
`EmailService_notifyManagersOverCap` wrapper + a Dashboard
warnings surface; its trigger-side change is just the planned-
handler addition.

Bringing the `last_expiry_at` / `last_expiry_summary` Config
keys in would make `Expiry_runExpiry` symmetric with the
Importer (architecture.md §9.1 "Config.last_import_at"). Not
needed for the acceptance criteria, and deliberately deferred so
Chunk 10's Dashboard can land both (import + expiry) on a single
commit when it adds the "last run" card.

The `Triggers_plan_` closure reads `Config.expiry_hour` at
install time. Chunk 9 will add an equivalent `Config.import_day`
/ `Config.import_hour` pair (or a single cron-ish descriptor),
seeded in `Setup.gs`'s `SETUP_CONFIG_SEED_`. The UX contract
from this chunk (edit hour → loud reminder to Reinstall)
carries over directly to the importer's equivalent.
