# Chunk 7 — Removals

**Shipped:** 2026-04-21
**Commits:** _(see git log; commit messages reference "Chunk 7")_

## What shipped

The third request type, `remove`, is now end-to-end. A bishopric or
stake principal clicks the X/trashcan in the rightmost column of any
manual/temp row on their Roster, fills in a "Reason for removal" in
the modal that opens, and submits a `remove` Request via the same
shared `ApiRequests_submit` endpoint Chunk 6 used for adds. Active
Kindoo Managers get the existing manager-notification email (body
copy is type-aware now). The Manager Requests Queue renders the
pending remove with the live `current_seat` styled "will be deleted
on Complete"; clicking Mark Complete opens the same confirmation
dialog as for adds (with the Buildings selector hidden for removes,
since no seat is being created), and clicking Confirm deletes the
matching `Seats` row inside one lock.

The "removal pending" badge appears on the requesting roster
immediately on refresh; the X for that row is replaced by a disabled
glyph so the requester can't double-submit, and the server refuses
the duplicate at submit time as a defence-in-depth check.

The R-1 race ("seat already gone at completion time") is handled
cleanly: complete still fires, the request flips to `complete` with
a stamped `completion_note`, only one AuditLog row is written
(`complete_request` on the Request — no Seat audit because no Seat
was deleted), and the requester's completion email body surfaces
the note so they're not confused that nothing visibly changed.

Implemented:

- **`repos/SeatsRepo.gs`** — added `Seats_deleteById(seat_id)`. Pure
  single-row delete by PK with header-drift check; returns the
  deleted row or null. The null-return is load-bearing — it's how
  `RequestsService_completeRemove_` detects the R-1 race and falls
  through to the no-op path.
- **`repos/RequestsRepo.gs`** —
  - Added the `completion_note` column to `REQUESTS_HEADERS_`,
    `REQUESTS_MUTABLE_FIELDS_`, `Requests_insert`'s appendRow,
    `Requests_update`'s setValues, `Requests_rowToObject_`, and
    `Requests_normaliseInput_`. Distinct from `rejection_reason`
    so the audit trail can tell a no-op apart from a rejection.
  - Added `Requests_getPendingRemoveByScopeAndEmail(scope, email)`
    used by both the submit-time duplicate guard and (via the
    pre-bucketed map in `Rosters_buildContext_`) the roster
    "removal pending" badge.
- **`services/RequestsService.gs`** —
  - `RequestsService_submit` accepts `type='remove'` and validates
    it: target must have an active manual/temp seat in the scope
    (open-questions.md R-3 — auto seats are LCR-managed; rejected
    with a spec-aligned error if every match is type=auto); no
    other pending remove for the same `(scope, target_email)` may
    exist.
  - `RequestsService_complete` dispatches by `req.type`. The new
    private `RequestsService_completeRemove_` looks up the matching
    seat (skipping auto rows defensively), deletes it via
    `Seats_deleteById`, and emits two audit rows
    (`complete_request` + `delete`). On the R-1 race
    (`Seats_deleteById` returns null OR the lookup found only auto
    rows), it stamps `completion_note` and emits ONE audit row
    instead.
- **`services/Rosters.gs`** — `Rosters_buildContext_` now reads
  pending requests once and pre-buckets remove targets by scope
  (`pendingRemovesByScope`). `Rosters_buildResponseFromSeats_`
  consults that bucket to set `row.removal_pending` per row;
  `Rosters_mapRow_` defaults the field to false so direct callers
  (duplicate-check previews, queue current-seat previews) get a
  consistent shape.
- **`api/ApiManager.gs`** — `ApiManager_listRequests` attaches a
  per-request `current_seat` field on pending `remove` rows
  (mapped via `Rosters_mapRow_`, or `null` if the seat is already
  gone) so the queue can render the seat-to-be-deleted preview
  inline. `duplicate_existing` stays empty for removes — the
  analogous "what's relevant about the target" signal for removes
  is `current_seat`. Wire shape from `ApiManager_shapeRequestForClient_`
  also gains `completion_note`.
- **`api/ApiRequests.gs`** — `ApiRequests_shapeForClient_` (used by
  MyRequests) gains `completion_note` so the requester's listing
  can surface the R-1 no-op note as a clickable hint.
- **`services/EmailService.gs`** — every notification body is now
  type-aware. The completion email's lead verb reads "processed
  your removal request for" for removes and "marked your
  manual-add request for ... as complete" for adds; subject lines
  read "Your removal request for X has been processed" vs "Your
  request for X has been completed". `notifyRequesterCompleted`
  surfaces `completion_note` on the R-1 path with a `Note:` line.
  No new templates; the four Chunk-6 wrappers were extended in
  place.
- **`services/Setup.gs`** — `SETUP_TAB_DEFS_` Requests headers
  list gains `completion_note` so fresh installs seed the new
  column. Existing installs trigger `setupSheet`'s loud HEADER
  DRIFT report at column 16 — operator must add the column by
  hand. The conservative behaviour is intentional (open-questions.md
  SD-2 — `setupSheet` doesn't auto-extend tabs because data loss
  on header rename would be catastrophic).
- **`ui/ClientUtils.html`** — `rosterRowHtml` extended:
  - `row.removal_pending=true` appends a `badge-removal-pending`
    "removal pending" badge in the Type column (alongside the
    expired / expires-today badges).
  - `opts.preview = 'remove'` adds a `preview-remove` row class
    that strikes through every cell (except the type badge — the
    badge is metadata, not data being deleted).
- **`ui/bishopric/Roster.html`** + **`ui/stake/Roster.html`** —
  rewritten to use `rowActions` / `actionsHeader='Remove'`. The
  rowActions function returns an empty cell for auto rows, a
  disabled `⌫` glyph for `removal_pending` rows, and a
  `<button class="btn btn-icon btn-remove">⌫</button>` otherwise.
  Both pages embed a shared-shape Remove modal: read-only seat
  summary at top, required reason textarea, Submit (red) /
  Cancel (secondary) actions. Submit calls `ApiRequests_submit`
  with `type='remove'` and the row's `person_email` /
  `person_name`; on success the page refreshes (which surfaces
  the new badge + disabled X).
- **`ui/MyRequests.html`** — added a `typeLabel(type)` helper so
  the Type column reads "Add (manual)" / "Add (temp)" /
  "Remove" instead of the raw enum. Completed rows with a
  `completion_note` get a "note" hint chip in the actions column;
  click reveals the note in an alert (same affordance as
  rejection-reason).
- **`ui/manager/RequestsQueue.html`** — type filter dropdown
  gains a `remove` option. Pending cards render the
  `current_seat` preview with `preview: 'remove'` styling, or an
  inline "Seat already removed" panel when `current_seat` is
  null. Terminal cards surface `completion_note` (when present)
  via a new `Note:` field. The Complete-confirmation modal hides
  the Buildings checkbox group for remove requests (no seat is
  being created), shows the seat-to-be-deleted preview in the
  summary, and the confirm button text reads "Confirm and
  delete seat" instead of "Confirm and complete". The actual
  rpc call sends `null` overrides for removes (no
  `building_names` to override).
- **`ui/Styles.html`** — Chunk-7 CSS: `badge-removal-pending`
  (red), `btn-icon` / `btn-remove` (small white-bg X), `remove-disabled`
  (greyed-out X glyph), `remove-modal` / `remove-modal-inner`
  (mirrors the seat-edit modal but red title + red submit
  button), `roster-table tr.preview-remove td` (line-through +
  faded text), `noop-warning` (orange dashed panel),
  `completion-note-hint` (clickable amber chip).

## Deviations from the pre-chunk spec

- **Added a new `completion_note` column to the Requests tab**
  rather than overloading `rejection_reason` for the R-1 no-op
  note. The pre-chunk plan considered both options and leaned
  toward the new column; this chunk made the call. Reasoning:
  `rejection_reason` is documented (data-model.md) as scoped to
  the rejection action — overloading it would muddle filtering
  on the future Audit Log page and leak rejection-shaped UI
  affordances onto completed requests. The added column has
  zero cost at our scale (16th column on a tab with a couple of
  rows per week). Spec: `data-model.md` Tab 9 gains
  `completion_note`; the existing `rejection_reason` row notes
  that it's "Scoped to the rejection action only"; the example
  rows table grows a column and a new `r5…` example shows the
  no-op note populated. `services/Setup.gs` and
  `repos/RequestsRepo.gs` updated in lock-step.
- **Disabled X (option a) when `removal_pending=true`**, not
  "X opens a 'Removal already requested' toast" (option b). The
  pre-chunk discussion leaned toward (a) for clearer UX — the
  disabled glyph is unambiguous about why clicking does nothing,
  and the badge in the same row says exactly which request is
  pending. Server still defends with the duplicate-pending guard
  in `RequestsService_submit`. Spec: `spec.md §5.1` rewritten to
  describe the X / badge / submit-guard combination.

## Decisions made during the chunk

- **R-1 storage column choice (resolved).** `completion_note` (new
  column) wins over repurposing `rejection_reason`. Recorded in
  `open-questions.md R-1` as RESOLVED, and in `data-model.md` Tab
  9 with the column added and the `rejection_reason` description
  amended to call out its scope.
- **Duplicate-remove guard is server-side, not just UI.** The
  disabled-X UX (above) prevents most of these, but the roster
  page can be stale when a different requester just submitted a
  remove for the same person. `RequestsService_submit` calls
  `Requests_getPendingRemoveByScopeAndEmail` and refuses with a
  clear error including the existing request_id. No client-side
  pre-check on submit — the disabled X is the primary preventive
  surface; the server check is the safety net.
- **Auto-row protection on remove submit.** Open-questions.md R-3
  specified that auto seats can't be removed via the request
  flow. The submit guard surfaces this with a body-of-the-message
  hint pointing at LCR ("Update the calling in LCR; the next
  import will remove the seat.") rather than a generic Forbidden
  — managers and bishoprics shouldn't have to context-switch to
  figure out why their click didn't work.
- **`Rosters_buildContext_` reads Requests once per request.**
  Earlier shape considered a per-row Requests lookup (cleaner code
  but N+1 reads on a table with 20 rows). Pre-bucketing into
  `pendingRemovesByScope` once at the top of the request keeps
  the read pattern constant-time at the scale we operate at and
  symmetric with how Wards / stake_seat_cap are loaded into ctx
  (architecture.md §9 "no N+1 reads"). Recorded as an inline
  comment on `Rosters_buildContext_`.
- **`Rosters_mapRow_` defaults `removal_pending: false`** so direct
  callers (`ApiRequests_checkDuplicate`'s preview rows,
  `ApiManager_listRequests`'s `duplicate_existing` and `current_seat`
  shapes) get a consistent field set. The pending-remove
  annotation only kicks in via `Rosters_buildResponseFromSeats_`
  for actual roster pages — duplicate-warning previews aren't part
  of a remove flow and shouldn't carry the badge.
- **R-1 fallback path is symmetric on a `Seats_deleteById` null
  return.** Two places trigger the no-op branch:
  (a) `Seats_getActiveByScopeAndEmail` returns no removable rows
  (typical race), and (b) `Seats_deleteById` returns null after a
  positive lookup (shouldn't happen inside a held lock but is
  belt-and-braces). Both paths emit the same `completion_note`
  and the same single audit row, so a manager debugging a no-op
  outcome doesn't have to figure out which sub-case fired.
- **Type-aware email body copy is single-template.** Considered
  splitting into separate `notifyRequesterCompletedRemoval` etc.
  wrappers; rejected because the differences are 2-3 string
  substitutions and one extra `Note:` line — splitting would
  duplicate the recipient lookup, scope-label render, and link
  builder for no real isolation gain. Each existing wrapper now
  branches on `request.type === 'remove'`. Subject-line
  convention unchanged (`[Kindoo Access] <verb> <target> (<scope>)`),
  matching the inbox-filterability decision in Chunk 6.
- **Queue type-filter dropdown shows `remove` as a literal value**
  matching the existing `add_manual` / `add_temp` entries. A
  human-readable label like "Remove" was considered but rejected
  for consistency with the other two — managers triaging the
  queue will see all three filter values together and the raw
  enum is the clearest mapping to what they'll see in the type
  column on each card.

## Spec / doc edits in this chunk

- `docs/spec.md` — §5.1 Roster description rewritten to describe
  the X / removal-pending badge / submit-guard combination and to
  call out auto rows as not removable here. §6 Request lifecycle
  gained a "Two extra rules apply only to remove" block covering
  the R-1 auto-complete behaviour (with the literal note text and
  the audit-row shape) and the submit-time guards (R-3 auto-only
  rejection + duplicate-pending rejection). §9 Email notifications
  intro rewritten to confirm the four Chunk-6 templates cover all
  three request types — `add_manual`, `add_temp`, AND `remove` —
  with body copy that's type-aware, and notes the completion
  email surfaces `completion_note` on the R-1 path.
- `docs/architecture.md` — §12 quick-reference rows for
  `services/Rosters.gs` and `services/RequestsService.gs` extended
  with the new responsibilities (the `removal_pending` annotation
  and the R-1 race auto-complete branch).
- `docs/data-model.md` — Tab 9 Requests gains the `completion_note`
  column; `rejection_reason` description amended to clarify it's
  scoped to the rejection action only; example rows table extended
  by a column and a new `r5…` example demonstrates the R-1 no-op
  note.
- `docs/open-questions.md` — R-1 marked RESOLVED with the
  resolution prose (auto-complete + completion_note + single
  audit row, with the four sources of the race enumerated).
- `docs/build-plan.md` — Chunk 7 marked
  `[DONE — see docs/changelog/chunk-7-removals.md]`; sub-tasks
  rewritten to match shipped surface; acceptance criteria
  expanded to cover the R-1 race, the duplicate-pending guard,
  the auto-row submit guard, and the email body copy verification.
- `docs/changelog/chunk-7-removals.md` — this file.

## Post-implementation review fixes (2026-04-21)

Five issues surfaced during code review and were addressed before commit:

- **Rosters_buildContext_ catch was too broad.** The original `try/catch`
  around `Requests_getPending()` swallowed every error, including the
  header-drift signal an existing install would throw before the
  `completion_note` migration. That would have produced a confusing
  inconsistency where roster pages render silently (no badges) while
  every submit / queue / cancel path threw. Fix: narrow the catch to
  the literal `"Requests tab missing"` thrown by `Requests_sheet_()`;
  rethrow everything else. Aligns with open-questions.md SD-2 (header
  drift is a fix-by-hand signal, never a quietly-degrade signal).
- **Queue "already removed" wording was inaccurate when only auto seats
  remained.** If the matching person held only auto seats at completion
  time (possible when a calling change between submit and complete left
  only the LCR-managed row), the queue card said "Seat already removed"
  while the roster across the nav showed an auto seat. Fix:
  `ApiManager_listRequests` now sets `current_seat_status` to one of
  `'removable'` / `'auto_only'` / `'none'`, and the queue card +
  Complete-modal summary render distinct copy for each. The R-1 complete
  path was already correct (the auto-only case routes through the
  no-op branch); only the manager-facing preview wording needed
  fixing.
- **Multi-seat remove was silently single-target.** If a person held
  >1 manual/temp seat in the same scope, the request shape couldn't
  say which one to remove (no `seat_id` on the wire — the request's
  natural key is `(scope, target_email)`), and `RequestsService_completeRemove_`
  picked the first non-auto match in repo order. Fix: `RequestsService_submit`
  now refuses the submit when `removable.length > 1` with a clear
  error directing the user to ask a Kindoo Manager to resolve the
  duplicates first. At target scale this should never fire; if it
  does, we'll know about it and can extend the request shape with a
  seat_id picker then.
- **Duplicated R-1 no-op branches.** Both no-op fallbacks (empty
  matches and `Seats_deleteById` returning null) had ~14 lines of
  identical Requests_update + AuditRepo_write + return. Extracted to
  `RequestsService_completeRemoveNoop_(req, managerEmail)` so a
  future change (e.g. Chunk 10 audit-log filtering on
  `completion_note`) lands in one place.
- **Unnecessary Requests-tab read in `ApiManager_listRequests`.** The
  endpoint built a full `Rosters_buildContext_` (which now reads
  Wards + Requests-getPending) just to consume `ctx.today`. Replaced
  with `Utils_todayIso()`. Saves one Requests + one Wards read per
  queue load.

## New open questions

None blocking. Two minor items worth flagging for future polish:

- **Q-7.1 (P2) — Audit-log filtering for `completion_note`-stamped
  rows.** Chunk 10's Audit Log page should let managers filter to
  "complete_request rows with a non-empty completion_note" — i.e.
  "show me every R-1 no-op". Currently the data is there but no
  surface filters on it. Trivial to add when Chunk 10 lands.
- **Q-7.2 (P2) — Surface the requester-side cancel of a stale
  remove.** When a requester sees their request flip to "complete"
  with a no-op note, an obvious next thought is "did I want to
  re-submit because the request still applies?" The note text
  could include a "submit a new removal request" link in the
  email. Holding off because it's a pure polish ask and the user
  can click the existing My Requests link to re-submit.

Neither rises to `open-questions.md` — both are UI-polish calls
that don't affect data invariants or the lifecycle.

## Files created / modified

**Created**

- `docs/changelog/chunk-7-removals.md` — this file.

**Modified**

- `src/repos/RequestsRepo.gs` — `completion_note` column;
  `Requests_getPendingRemoveByScopeAndEmail`; updated insert /
  update / row mappers / mutable-fields list.
- `src/repos/SeatsRepo.gs` — added `Seats_deleteById(seat_id)`.
- `src/services/RequestsService.gs` — submit accepts and validates
  `type='remove'` (active-seat + duplicate-pending guards);
  complete dispatches to a new `RequestsService_completeRemove_`
  helper that handles the happy path and the R-1 no-op path.
- `src/services/Rosters.gs` — `Rosters_buildContext_` pre-buckets
  pending removes per scope; `Rosters_buildResponseFromSeats_`
  annotates each row's `removal_pending`; `Rosters_mapRow_`
  defaults the field to false.
- `src/services/EmailService.gs` — every notification body is
  type-aware; completion email surfaces `completion_note` for
  the R-1 path.
- `src/services/Setup.gs` — `SETUP_TAB_DEFS_` Requests headers
  list extended with `completion_note`.
- `src/api/ApiManager.gs` — `ApiManager_listRequests` attaches
  `current_seat` to pending removes; `duplicate_existing` stays
  empty on remove rows; wire shape gains `completion_note`.
- `src/api/ApiRequests.gs` — wire shape gains `completion_note`
  for the MyRequests page.
- `src/ui/bishopric/Roster.html` — X / disabled-X / removal
  modal flow; submits via `ApiRequests_submit('remove', …)`
  with the principal's verified scope.
- `src/ui/stake/Roster.html` — same as above, scoped to `stake`.
- `src/ui/MyRequests.html` — friendly type labels; clickable
  completion-note hint on completed remove rows.
- `src/ui/manager/RequestsQueue.html` — type filter gains
  `remove`; pending cards render `current_seat` preview (or
  no-op panel); Complete modal hides Buildings for removes;
  confirm button text + success toast wording adapt; terminal
  cards surface `completion_note` when present.
- `src/ui/ClientUtils.html` — `rosterRowHtml` accepts
  `opts.preview = 'remove'` and renders `row.removal_pending` as
  a Type-cell badge; row class gains `preview-remove` /
  `has-removal-pending` markers.
- `src/ui/Styles.html` — Chunk-7 CSS (badge, X button, disabled
  X, remove-modal, preview-remove strikethrough, noop-warning,
  completion-note-hint).
- `docs/spec.md`, `docs/architecture.md`, `docs/data-model.md`,
  `docs/open-questions.md`, `docs/build-plan.md` — see "Spec /
  doc edits in this chunk" above.

**Untouched (still 1-line stubs, deferred per build-plan later chunks)**

- `src/services/Expiry.gs` — Chunk 8.
- `src/services/TriggersService.gs` — Chunks 8 / 9.
- `src/ui/manager/Dashboard.html`, `src/ui/manager/AuditLog.html` —
  Chunk 10.

## Confirmation that the Chunk 7 deferrals list was respected

Per `build-plan.md` Chunk 7 → "Out of scope":

- ✅ **Removals for auto-seats** — not built, and explicitly
  rejected at the submit boundary with a spec-aligned error
  pointing the user at LCR. UI also never renders the X for
  auto rows.
- ✅ **No new email types** — confirmed. The four existing
  Chunk-6 wrappers (`notifyManagersNewRequest`,
  `notifyRequesterCompleted`, `notifyRequesterRejected`,
  `notifyManagersCancelled`) cover all three request types.
  Body copy was extended in place; subject line convention
  unchanged.
- ✅ **No expiry trigger work** — `services/Expiry.gs` and
  `services/TriggersService.gs` untouched. Chunk 8.
- ✅ **No weekly import trigger** — same.
- ✅ **No Dashboard / Audit Log work** — both stubs untouched;
  Chunk 10.
- ✅ **No Cloudflare Worker** — Chunk 11.
- ✅ **No refactoring of Chunk 5 / 6 code beyond the listed
  touch-points** — `Rosters_buildContext_` / `Rosters_mapRow_`
  /  `Rosters_buildResponseFromSeats_` extended only to support
  the new `removal_pending` annotation; the existing read-side
  shape for adds is unchanged. `RequestsService_submit` /
  `_complete` extended only with remove branches; the add
  branches are byte-identical to Chunk 6's behaviour.

## Migration note for existing installs

The Requests tab schema gained a 16th column (`completion_note`).
Fresh installs get it via `setupSheet`. Existing installs (the
chunk-1-6 dev sheet) need a manual one-time edit:

1. Open the bound Sheet.
2. Add the cell `completion_note` to the Requests tab's row 1, column 16.
3. Re-run `Kindoo Admin → Setup sheet…` to confirm headers report `OK`.

`setupSheet` deliberately refuses to auto-extend tabs (open-questions.md
SD-2 stance: header drift surfaces loudly so the operator knows; the
risk of an auto-rename damaging existing data outweighs the
convenience).

## Next

Chunk 8 (Expiry trigger) lands the daily job that deletes temp seats
where `end_date < today (local tz)`. Touch points the next chunk
should pre-load:

- **`services/Expiry.gs`** — currently a 1-line stub. Implements
  `Expiry_runExpiry()`: scans `Seats` for `type=temp AND end_date
  < today`, deletes inside one `Lock_withLock` (matching the
  Importer's wide-lock pattern), writes per-row `AuditLog` entries
  with `actor_email='ExpiryTrigger'` and `action='auto_expire'`
  carrying `before_json` of the deleted row.
- **`services/TriggersService.gs`** — currently a no-op stub from
  Chunk 4. Extend with the daily-trigger install (`ScriptApp.newTrigger
  ('Expiry_runExpiry').timeBased().atHour(Config.expiry_hour).everyDays(1)`).
  The bootstrap wizard's Complete-Setup step calls this; Chunk 8
  makes it real.
- **R-1 race interaction.** Chunk 7's R-1 path was written with
  Chunk 8 in mind: when the expiry trigger deletes a temp seat
  between the requester submitting `remove` and the manager
  clicking Complete, the existing no-op-with-completion_note
  branch handles it cleanly. No additional code on the Chunk 8
  side is required for the interaction.
- **Utilization math** — Chunk 5's roster summaries count every
  row regardless of type, including past-end-date temps. Chunk 8
  deletes those, so the count drops naturally. The "expired" /
  "expires today" badge on the row stops appearing once the row
  is gone. No code changes; just verify the badges disappear in
  the manual test walkthrough.
- **Email semantics.** Spec says no email on auto-expire. Don't
  add one — the `auto_expire` audit row is the trail.

The convention to carry over: every write path uses the
`Lock_withLock(repo write + AuditRepo_write)` shape; the trigger
runs as the deployer (Apps Script time-based triggers run under
the script owner), and `actor_email` is the literal string
`"ExpiryTrigger"` per data-model.md §10 — never
`Session.getEffectiveUser()`.
