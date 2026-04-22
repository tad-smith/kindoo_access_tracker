# Chunk 9 — Weekly import trigger + over-cap warnings

**Shipped:** 2026-04-22
**Commits:** _(see git log; commit messages reference "Chunk 9")_

## What shipped

The weekly callings-sheet import now fires automatically on its own
schedule, and every import run — manual or weekly-trigger — ends with a
per-pool over-cap detection pass that surfaces in three places: a
persistent red banner on the manager Import page, a new `over_cap_warning`
AuditLog row, and an email to active Kindoo Managers.

Concretely:

- **Weekly trigger.** `Triggers_plan_()` gains a second entry for
  `Importer_runImport` (`kind: 'weekly'`). The install loop branches on
  `spec.kind`: `daily` paths unchanged; `weekly` paths call
  `ScriptApp.newTrigger(handler).timeBased().onWeekDay(day).atHour(h).create()`.
  Schedule inputs come from two new Config keys: `import_day` (default
  `SUNDAY`) and `import_hour` (default `4`). The uninstall loop still
  removes every planned handler before installing fresh, so re-running
  `TriggersService_install` still leaves unknown-handler triggers alone
  and still reads the latest Config on each call.
- **Importer owns its lock.** Chunk 3's 30-s `Lock_withLock` used to live
  in `ApiManager_importerRun`. The weekly trigger has no token and no
  outer lock, so Chunk 9 moved the acquisition INSIDE
  `Importer_runImport` itself. The endpoint now just verifies the manager
  role and forwards. The `opts` argument is normalised: anything without
  an explicit `triggeredBy` (including an Apps Script trigger event
  object, which has its own shape) defaults to the literal string
  `'weekly-trigger'`. Per-row `actor_email='Importer'` is unchanged.
- **Over-cap detection.** After the main import lock releases,
  `Importer_computeOverCaps_()` runs a read-only scan over
  `Seats` + `Wards` + `Config.stake_seat_cap`. For each ward with a
  configured cap > 0 and for the stake pool when `stake_seat_cap > 0`, it
  counts seats in the scope (every row regardless of `type`, matching
  Chunk 5's utilization math) and emits a `{scope, ward_name, cap, count,
  over_by}` descriptor when the count exceeds the cap. The result is
  persisted to `Config.last_over_caps_json` on **every** run (empty array
  on clean runs), so the Import page's banner clears when a condition
  resolves. If any pools are over, one `over_cap_warning` audit row is
  written in a small follow-up lock, then the email is sent OUTSIDE
  both locks best-effort.
- **Manager Import page** gains a red banner above the existing
  last-run-status panel when `Config.last_over_caps_json` is non-empty.
  One line per pool with counts and a "View seats →" link to the filtered
  `mgr/seats` view (`?p=mgr/seats&ward=<code>` or `&ward=stake`). Page
  loads show the current persisted state without re-running the
  importer, and the banner also renders inline from the
  `Importer_runImport` result immediately after a manual run so the
  manager doesn't wait for a second round-trip.
- **Manager Config page** renders `import_day` as a `<select>` over the
  seven canonical `ScriptApp.WeekDay` names (operator can't typo a
  value); `import_hour` gets the same reinstall-triggers hint
  `expiry_hour` got in Chunk 8. Saving any of the three trigger-schedule
  keys (`expiry_hour`, `import_day`, `import_hour`) fires the warn toast
  *"Saved. Click 'Reinstall triggers' to apply the new schedule."*
  `ConfigRepo` backs the UI with server-side validation: `import_day`
  must be one of the seven names (UPPERCASE, case-insensitive on input);
  `import_hour` and `expiry_hour` must be integers 0–23. Invalid values
  surface as clean error toasts, not stack traces from
  `ScriptApp.WeekDay[undefined]`.
- **`EmailService_notifyManagersOverCap(pools, source)`** is a new
  wrapper in the same shape as the four Chunk-6 request-lifecycle
  templates. Plain-text body lists every over-cap pool with its
  counts/cap/over-by, plus a deep-link back to `mgr/seats`.
  `source='manual-import' | 'weekly-trigger'` toggles the subject line
  so inbox filters can distinguish the two. Respects the
  `Config.notifications_enabled` kill-switch.
- **`Kindoo Admin → Run weekly import now`** menu item added to the
  bound Sheet's `onOpen` menu so an operator can exercise the
  trigger-path code (no token, no outer lock, `triggeredBy='weekly-trigger'`)
  without waiting for Sunday or loading the web app.

Implemented:

- **`src/services/TriggersService.gs`** — `Triggers_plan_()` gains the
  second entry (`Importer_runImport`, kind=`weekly`); `TriggersService_install`
  branches on `spec.kind` to call `onWeekDay(...)` on weekly triggers.
  New `TRIGGERS_VALID_WEEKDAYS_` constant + `Triggers_weekDayLabel_()`
  helper for the install-message string.
- **`src/services/Importer.gs`** — `Importer_runImport(opts)` normalises
  the opts shape, acquires its own `Lock_withLock(fn, {timeoutMs:
  30000})`, runs the diff-and-apply core (pulled out into
  `Importer_runImportCore_` for clarity), then runs
  `Importer_computeOverCaps_()`, persists the snapshot + writes the audit
  row in a small follow-up lock, and sends the over-cap email
  best-effort OUTSIDE both locks. Returns the import result extended
  with an `over_caps` array and an optional `warning` string.
- **`src/services/EmailService.gs`** — `EmailService_notifyManagersOverCap`
  + `EmailService_overCapPoolLine_` + `EmailService_seatsLink_`.
  Respects `notifications_enabled` via the shared `EmailService_send_`
  path.
- **`src/repos/ConfigRepo.gs`** — `CONFIG_TYPED_KEYS_` gains
  `import_hour: 'number'`; new `CONFIG_VALID_IMPORT_DAYS_` constant;
  `Config_update` validates `expiry_hour` / `import_hour` as integer
  0–23 and `import_day` against the seven weekday names (UPPERCASE
  normalisation + rejection of anything else).
  `CONFIG_IMPORTER_KEYS_` gains `last_over_caps_json` so the manager
  Config UI renders it read-only (importer-owned, never operator-edited).
- **`src/services/Setup.gs`** — `SETUP_CONFIG_SEED_` gains three new
  entries: `import_day='SUNDAY'`, `import_hour=4`, `last_over_caps_json=''`.
  `onOpen` menu gains "Run weekly import now".
- **`src/api/ApiManager.gs`** — `ApiManager_importerRun` drops its
  explicit `Lock_withLock` wrap (Importer owns it now); forwards to
  `Importer_runImport({triggeredBy: principal.email})`.
  `ApiManager_importStatus` returns the parsed
  `last_over_caps` array alongside the existing fields so the Import
  page can render the banner on page load without a second rpc.
- **`src/ui/manager/Import.html`** — the red `.over-cap-banner` markup +
  render logic + deep-link builder. Hidden until
  `renderOverCapBanner(pools)` is called with a non-empty array;
  `loadStatus` / post-run refresh both feed it. Intro prose updated to
  mention the new `Config.import_day` / `Config.import_hour` keys.
- **`src/ui/manager/Config.html`** — `import_day` renders as a
  `<select>`; `import_hour` / `import_day` get reinstall hints; save
  toast on any schedule key reminds the operator to reinstall. The
  save-handler reads `[data-field="value"]` generically so it handles
  `<select>` alongside the existing `<input>` shapes. Triggers-panel
  prose updated to describe both schedules.
- **`src/ui/Styles.html`** — new `.over-cap-banner`,
  `.over-cap-heading`, `.over-cap-intro`, `.over-cap-list`,
  `.over-cap-pool-label / -counts / -overby / -link` styles. Red-tinted
  (`#fff1f0` / `#d24a3a`) so it reads as an urgent warning next to the
  neutral import-status panel.

## Deviations from the pre-chunk spec

- **`Importer_runImport` now owns its own `Lock_withLock` acquisition**
  (architecture.md §9.1 updated). The pre-Chunk-9 contract was "caller
  wraps in `Lock_withLock`" — the weekly trigger has no caller to do
  that, so the lock moved inside. `ApiManager_importerRun` drops its
  outer `Lock_withLock` accordingly. `LockService.getScriptLock()` is
  NOT reentrant — nesting the manual endpoint's old outer lock around
  the importer's new inner lock would have deadlocked. Alternative
  considered: keep the lock in the endpoint and add a second "no-token,
  does its own lock" entry point that the trigger calls. Rejected as a
  proliferation of entry points when one normalised signature works.
- **`over_cap_warning` writes one row per import run, not one row per
  over-cap pool.** Pools[] is serialised into `after_json` so a later
  audit query can still filter on "runs that produced an over-cap for
  ward CO" without scanning. Rationale: audit-row cost (one setValues
  round-trip) scales per-run, not per-pool, and a single-row model
  keeps the "did this run trip the threshold?" query one-to-one with
  import runs.
- **`over_cap_warning` uses `entity_type='System'`.** The row
  represents a cross-pool condition, not a single domain entity. The
  alternative (`entity_type='Config'`, `entity_id='over_cap'`) was
  considered but `Config` is reserved for Config-key CRUD audit rows;
  introducing `System` keeps the entity-type enum honest. data-model.md
  §10 updated to document this.
- **Email fires on every over-cap run, not only on state changes.**
  Resolves `open-questions.md` OC-1 in the "per-run" direction. At
  target scale (weekly trigger + rare manual runs) inbox volume is not a
  problem, and the state-delta model would require bookkeeping of prior
  per-pool state. The banner is the persistent surface; the email is
  the new-information signal on each run. Revisitable later without a
  schema change.
- **Deep link uses `?p=mgr/seats&ward=<code>` (or `ward=stake`) rather
  than the pre-chunk prompt's `scope=stake`.** AllSeats.html already
  reads `QUERY_PARAMS.ward` and treats `'stake'` as a first-class
  filter value (added in Chunk 5); using `scope=` would have required
  a second path on the same page.
- **`Config.last_over_caps_json` is persisted on every run (empty
  string / `[]` on clean runs), not only when over-cap is detected.**
  The alternative (only write on non-empty) would leave a stale
  non-empty snapshot after a resolved condition, and the UI would
  need to re-read Seats to detect the stale state. Writing
  unconditionally keeps "what the banner shows" tied 1-to-1 with
  "the last completed import run."

## Decisions made during the chunk

- **Over-cap detection is a separate pass, outside the import lock.**
  The alternative (run inside the import lock) would hold the lock for
  an extra Seats + Wards read pass for no concurrency benefit. The
  import lock is already 30 s; adding any read I/O to it extends every
  other writer's wait for no atomicity guarantee that matters (the
  detection is over already-committed data — a concurrent manager
  edit between release and detection would just be reflected in a
  slightly-fresher count, which is fine).
- **Over-cap persistence uses its own small follow-up
  `Lock_withLock`.** Same rationale as every other write in the
  codebase — a bare `Config_update` + `AuditRepo_write` would race with
  a concurrent manager Config edit. The follow-up lock is short
  (milliseconds) so it doesn't stack meaningfully with the import lock
  window.
- **`import_day` is a dropdown, not a text field.** A free-text input
  would let an operator type `SUNAY` and only find out at install time
  that `ScriptApp.WeekDay['SUNAY']` returns undefined. The dropdown
  removes the footgun; server-side validation in `Config_update` is the
  defence-in-depth against a crafted rpc.
- **Validation lives in `ConfigRepo.Config_update`, not the API
  layer.** The bootstrap wizard and the importer also write these
  keys; centralising validation in the repo means every write path is
  vetted identically without each caller repeating the check.
- **Over-cap email body does NOT list every affected seat — just
  counts + a deep-link.** Embedding the seat list would re-implement
  roster-rendering in plain text for an email reader who's one click
  away from the same data in a better UI. The link IS the answer; the
  email is the attention-grabber.
- **Subject-line discriminator `manual import` vs `weekly import`** —
  lets a manager inbox-filter "weekly-trigger over-caps" separately if
  they want. Cost: one `source` string threaded through the email
  wrapper. Worth the two lines of code.
- **Historical drift is flagged in architecture.md §9.3 but not
  mitigated in code.** Apps Script triggers installed from an archived
  deployment keep firing but may hit stale code. This is a real risk
  with the weekly importer (first trigger that runs without operator
  presence), but the mitigation is operational (archive old
  deployments; Chunk 10 Dashboard can surface "last weekly import"
  as a monitoring signal). No runtime change needed.
- **Manager Config page's save toast uses a single message for all
  three schedule keys.** Previously `expiry_hour` had its own
  hour-specific wording; updating `import_day` to match would have
  needed different wording again ("day" vs "hour"). Collapsed to
  "Saved. Click 'Reinstall triggers' to apply the new schedule." so
  the three keys read consistently.
- **Run-now menu item for the weekly importer exists and points at
  `Importer_runImport` with no args.** Same `triggeredBy='weekly-trigger'`
  default as the actual trigger, so manual-from-menu and
  trigger-fires behave identically. The web-app manager path still
  uses `ApiManager_importerRun` which threads `triggeredBy=<email>`.

## Spec / doc edits in this chunk

- `docs/spec.md` — §8 Weekly import gains the `import_day` /
  `import_hour` paragraph, the "both paths run the same code"
  paragraph, and the rewritten "Cap interaction" paragraph documenting
  the post-lock over-cap pass + Config.last_over_caps_json persistence.
  §9 Email notifications table gains a fifth row (over-cap); intro
  prose updated for "five notifications"; banner paragraph added.
- `docs/architecture.md` — §9.1 Importer rewritten to document the
  moved-inside lock and the over-cap detection pass. §9.3 Trigger
  management rewritten for the two-handler plan with a schedule-inputs
  table; UX contract paragraph expanded to all three schedule keys;
  historical-drift caveat added.
- `docs/data-model.md` — Config tab gains `import_day`, `import_hour`,
  `last_over_caps_json` with full validation descriptions. Example rows
  table gains the three new keys. §10 entity_type enum gains `System`
  with rationale. §10 action vocabulary's `over_cap_warning` entry
  expanded to name the shape (`entity_type='System'`, per-run not
  per-pool, audit payload keys).
- `docs/build-plan.md` — Chunk 9 marked
  `[DONE — see docs/changelog/chunk-9-scheduled.md]`. Sub-tasks
  rewritten to match what shipped; acceptance criteria rewritten to
  reflect the verified behaviour.
- `docs/open-questions.md` — OC-1 marked RESOLVED with the
  per-run-not-state-delta rationale.
- `docs/changelog/chunk-9-scheduled.md` — this file.

## Post-implementation fixes (2026-04-22)

**1. `ApiManager_configList` null response on load.** The manager
Configuration page failed with *"Cannot read properties of null
(reading 'all')"* — the whole rpc response came back as `null`
client-side. Root cause: google.script.run has a documented
serialization edge case (already mitigated in
`ApiManager_importStatus` before this chunk) where a response map
containing Date-valued properties alongside null-valued properties
can be dropped to literal `null` in transit. Chunk 9's new
`Config.last_over_caps_json` key coerces to `null` when empty (an
empty-string cell goes through `Config_coerce_ → null`); combined
with `last_import_at` being a native `Date`, the response crossed
the threshold.

**Fix.** In `ApiManager_configList`, pre-format every `Date` value
in the Config map to an ISO-ish string via `Utilities.formatDate`
before returning — same trick `ApiManager_importStatus` already
uses. Values are consumed read-only by the UI (the Config key/value
tab renders timestamps as display strings; only editable keys
round-trip back to a write), so the Date → string shape change is
safe.

This bug had been latent since the first time `last_import_at`
became a real Date (i.e., since Chunk 3); Chunk 9's new null-valued
Config key just pushed the response over whatever threshold
triggers the serialization drop. Worth noting: any future
additional null-valued Config key could re-tickle it, but the fix
is now general (every Date in the map is stringified).

**2. NewRequest temp-fields `required` attribute persists across
submissions.** Reported by the user mid-review. After submitting
an `add_temp` request, selecting `add_manual` and re-submitting
without a page refresh failed with native HTML validation
*"start date required"*. Root cause (a Chunk-6 bug, surfaced
during Chunk-9 testing): the submit-success reset path called
`form.reset()` (which reverts `#f-type` to its default
`add_manual`) and hid `#temp-fields` visually, but did NOT remove
the `required` attributes that the type-change listener had set
on `#f-start-date` / `#f-end-date` when the user originally
picked `add_temp`. Native form validation then blocked the next
submit because a (hidden) required field had no value.

**Fix.** Extracted the type-dependent UI state into a named
function `syncTempFieldsToType()` (used by both the
`f-type#change` listener and the submit-success reset path). After
`form.reset()` the post-submit code calls it so the `required`
attrs, visibility, and (soon) any future temp-only state stay in
lockstep with the current `f-type` value. No server-side change.

## New open questions

None blocking. Two worth flagging for later polish:

- **Q-9.1 (P2) — Historical drift of installed triggers.** Once a
  trigger is installed, it runs on its own schedule regardless of
  whether its deployment is still the active one. An archived
  deployment whose trigger wasn't torn down first can keep firing
  against stale code. The weekly importer is the first trigger in this
  project that runs without operator presence, so this is named in
  architecture.md §9.3 but not mitigated in code. Chunk 10's Dashboard
  can surface a "last weekly import" timestamp as the monitoring
  signal; operationally, an operator archiving a deployment should
  click "Reinstall triggers" on the new deployment first.
- **Q-9.2 (P2) — Over-cap email de-duplication on repeat runs.**
  Currently we email on every run where any pool is over, even if
  nothing changed from the previous run. At target scale this is fine
  (one weekly email) but if inbox volume becomes a problem the fix is
  to add an `over_cap_changed_since` field to
  `Config.last_over_caps_json` and branch in
  `EmailService_notifyManagersOverCap`. Recorded in
  open-questions.md's OC-1 resolution; not building now.

## Files created / modified

**Created**

- `docs/changelog/chunk-9-scheduled.md` — this file.

**Modified**

- `src/services/TriggersService.gs` — weekly-handler branch + second
  plan entry + weekday-name validator.
- `src/services/Importer.gs` — `Importer_runImport` normalises opts +
  owns its lock; new `Importer_runImportCore_` (the pre-Chunk-9 body);
  new `Importer_computeOverCaps_`; over-cap snapshot + audit row + email
  side-effects.
- `src/services/EmailService.gs` — `notifyManagersOverCap` +
  `overCapPoolLine_` + `seatsLink_`.
- `src/services/Setup.gs` — three new seed keys + run-weekly-import
  menu item.
- `src/repos/ConfigRepo.gs` — `import_hour` typed; `import_day`
  validated in `Config_update`; `last_over_caps_json` marked
  importer-owned.
- `src/api/ApiManager.gs` — `ApiManager_importerRun` drops its
  `Lock_withLock` wrap; `ApiManager_importStatus` returns parsed
  over-caps.
- `src/ui/manager/Import.html` — over-cap banner markup + render +
  deep-link builder.
- `src/ui/manager/Config.html` — `import_day` dropdown; `import_hour`
  hint; generic `[data-field="value"]` save path (handles `<select>`);
  triggers-panel prose updated.
- `src/ui/Styles.html` — `.over-cap-*` classes.
- `src/ui/NewRequest.html` — post-implementation fix: factored the
  type-dependent UI sync into `syncTempFieldsToType()` and call it
  from the submit-success reset path so the `required` attrs on
  date inputs don't stick after a prior add_temp submission. See
  "Post-implementation fixes" above. (Chunk 6 bug, surfaced here.)
- `docs/spec.md`, `docs/architecture.md`, `docs/data-model.md`,
  `docs/build-plan.md`, `docs/open-questions.md` — per "Spec / doc
  edits in this chunk" above.

**Untouched (still stubs, deferred per build-plan later chunks)**

- `src/ui/manager/Dashboard.html`, `src/ui/manager/AuditLog.html` —
  Chunk 10. The Dashboard's Warnings card will surface the same
  `last_over_caps_json` snapshot the Import page banner already uses.

## Confirmation that the Chunk 9 deferrals list was respected

Per `build-plan.md` Chunk 9 → "Out of scope":

- ✅ **Blocking over-cap** — imports still always apply (LCR truth
  wins). The over-cap pass is advisory-only; the importer returns
  success and the audit trail records both the import and the
  over-cap condition.
- ✅ **Dashboard Warnings card** — Dashboard.html is still a stub.
  The banner lives on the Import page only; Chunk 10 will promote it.

Additional deferrals respected (not in the Chunk 9 out-of-scope list
but implied by the build plan):

- ✅ Audit Log page — stub untouched.
- ✅ Cloudflare Worker — Chunk 11.
- ✅ No refactoring of Chunk 5 / 6 / 7 / 8 code beyond the touch
  points listed above. Rosters, RequestsService, EmailService (only
  the new wrapper added), SeatsRepo, RequestsRepo, Expiry, Auth,
  Router, Nav are all structurally unchanged.

## Manual test walk-through

Mirrors the "verification" and "demonstrate" lists in the chunk-9
prompt.

1. **Fresh-install seeding.** Re-run `setupSheet` (or
   `Kindoo Admin → Setup sheet…`) on a pre-Chunk-9 install: three
   new Config rows appear — `import_day=SUNDAY`, `import_hour=4`,
   `last_over_caps_json=` (empty). Running `setupSheet` a second
   time writes no new rows ("Config keys (no seeding needed)").
2. **`TriggersService_install` on a fresh project.** Editor →
   Run `TriggersService_install`. Return shape is
   `{installed: ['Expiry_runExpiry','Importer_runImport'],
   removed: [], message: '[TriggersService] installed 2 trigger(s):
   Expiry_runExpiry @ 3:00 daily; Importer_runImport @ 4:00 every
   Sunday'}`. Editor's Triggers panel shows both: daily-3am for
   Expiry, weekly-Sunday-4am for Importer.
3. **Re-running `TriggersService_install`** removes both and
   installs fresh. Return shape has `removed` populated with both
   handlers; `(removed 2 prior)` appears on the message.
4. **Manual import, no over-cap.** Via the manager `?p=mgr/import`
   page, click Import Now on a sheet that's under every cap.
   Summary populates ("N inserts, M deletes, …"); AuditLog gains
   `import_start` / per-row entries / `import_end`; NO
   `over_cap_warning` row; NO manager email;
   `Config.last_over_caps_json='[]'`; no red banner on the page.
5. **Manual import, over-cap produced.** Lower a Ward.seat_cap (e.g.
   CO 20 → 5) or Config.stake_seat_cap to force an over-cap; click
   Import Now. Summary populates; AuditLog gains an
   `over_cap_warning` row with `actor_email='Importer'`,
   `entity_type='System'`, `entity_id='over_cap'`,
   `after_json={"pools":[...],"source":"manual-import","triggered_by":"<mgr email>"}`.
   Manager email arrives (subject "[Kindoo Access] Over-cap
   warning after manual import") listing every pool with "N / cap
   (over by K)" lines and the `?p=mgr/seats` link; body ends with
   the "reduce manual/temp seats, or raise the cap" resolution
   hint. Page shows the red banner above the status panel; each
   pool has a "View seats →" link that (via top-frame nav) opens
   `?p=mgr/seats&ward=<code>` (or `ward=stake`) with the filter
   pre-populated from `QUERY_PARAMS`.
6. **`notifications_enabled=false` suppresses email only.** In the
   manager Config page's Editable Config table, flip
   `notifications_enabled` to unchecked, Save. Re-run Import Now
   on the over-cap sheet: AuditLog still gains one
   `over_cap_warning` row, `Config.last_over_caps_json` still
   updates, banner still shows — but the execution log records
   `[EmailService] notifications disabled via
   Config.notifications_enabled; would have sent to N recipient(s):
   "[Kindoo Access] Over-cap warning after manual import"`. No
   `MailApp.sendEmail` call.
7. **Weekly-trigger path.** From the Apps Script editor Run
   dropdown, pick `Importer_runImport` (no arguments). Same
   behaviour as manual but `import_start` / `import_end` /
   `over_cap_warning` audit rows carry
   `triggeredBy='weekly-trigger'`; per-row actor stays `'Importer'`.
   Banner + email behave identically to manual. The
   `Kindoo Admin → Run weekly import now` Sheet-menu entry
   exercises the same path.
8. **Editing `import_day` / `import_hour` — warn toast + reinstall
   round-trip.** Manager Config → Config (key/value) tab →
   change `import_hour` from 4 to 5, Save. Toast: *"Saved. Click
   'Reinstall triggers' to apply the new schedule."* (warn-level).
   Change `import_day` from Sunday to Wednesday via the dropdown.
   Same toast. Click "Reinstall triggers" — the editor's Triggers
   panel now shows `Importer_runImport` at Wednesday 05:00.
9. **Invalid `import_day`.** Attempt to set `import_day=FUNDAY` via
   crafted rpc (curl / dev-console). Server rejects with
   *"Config_update: import_day must be one of SUNDAY, MONDAY,
   TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, got 'FUNDAY'"*.
   Rpc toast displays the message verbatim; no stack trace.
10. **Invalid `import_hour` (25 or 4.5).** Same — rejected with
    *"Config_update: import_hour must be an integer 0–23, got 25"*
    (or `"...got 4.5"`).
11. **Resolving an over-cap clears the banner on the next run.**
    From state 5 above, raise the cap back to its original value
    (or delete the offending manual/temp rows), click Import Now.
    New summary, no `over_cap_warning` audit row,
    `Config.last_over_caps_json='[]'`, banner gone.
12. **`ApiManager_importStatus` on page reload.** With a non-empty
    `Config.last_over_caps_json`, reload the Import page (F5 / top
    frame). The banner renders from the persisted snapshot without
    a re-import — demonstrating the read-side contract works.
13. **Manager-UI protection of the importer-owned keys.** Try to
    edit `last_over_caps_json` from the Config page — it appears in
    the Read-only keys table with the `importer-owned` badge; no
    save button. Attempt a direct rpc
    `ApiManager_configUpdate('last_over_caps_json', '[]')` — server
    rejects with *"Config key 'last_over_caps_json' is owned by the
    importer; don't edit it from here."*

## Next

Chunk 10 (Audit Log page + polish) picks up the Dashboard. The
over-cap snapshot in `Config.last_over_caps_json` is already shaped
for a Warnings card: one bullet per pool, counts + deep-link —
same shape the Import page banner already renders. Chunk 10's
`ui/manager/Dashboard.html` can reuse the same renderer;
`ApiManager_dashboard` (new endpoint) would return the snapshot
alongside pending request counts + last import/expiry timestamps so
the manager's default landing page surfaces all three current-state
signals without per-card round-trips.

The Audit Log page's filter set should include the new
`over_cap_warning` action and `entity_type='System'` so "when did
we last trip the cap?" is a one-filter query. The existing
audit-row schema needs no change.

A deferred follow-up worth keeping on the radar is Q-9.2 (email
de-duplication on repeat over-cap runs). At current scale a weekly
reminder email is fine; if it becomes noise, the fix is a
state-delta field in `Config.last_over_caps_json` — recorded in
open-questions.md's OC-1 resolution.
