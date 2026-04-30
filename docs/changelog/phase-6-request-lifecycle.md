# Phase 6 — Write-side pages, request lifecycle

**Shipped:** 2026-04-30
**Commits:** see PR [#29](https://github.com/tad-smith/kindoo_access_tracker/pull/29) (10 commits squashed onto `main` as the Phase 6 close commit); predecessor on `main` was PR [#28](https://github.com/tad-smith/kindoo_access_tracker/pull/28) (`e9791eb`, the `deploy-staging.sh --from-pr <number>` flag). One unrelated infra PR — [#30](https://github.com/tad-smith/kindoo_access_tracker/pull/30) `--web-only` flag — merged onto `main` while Phase 6 was in flight; not Phase 6 work.

## What shipped

The full request lifecycle now runs end-to-end on Firebase. Submit → Manager Queue → Mark Complete / Reject. Cancel from MyRequests. Removal flow with the R-1 race handled. Every transaction is atomic; every write conforms to the Phase 3 rules. Acceptance criteria from `firebase-migration.md` line 875 onward — full happy paths for `add_manual` / `add_temp` / `remove`, reject + cancel paths, duplicate warning, audit rows via the Phase 8 trigger (already shipped in PR [#21](https://github.com/tad-smith/kindoo_access_tracker/pull/21)), self-approval policy preserved, auto-seat removal blocked at the rule level, R-1 race preserved — all met. Tests: 364 web-side passing (was ~333 pre-Phase-6); 39 e2e specs (was 33, including 5 new lifecycle specs); 191 firestore-tests (one new pure-manager submit shape regression + one access shape regression added); 38 functions integration (unchanged).

The phase shipped over 10 commits, with three milestone commits up front and seven follow-up commits driven by operator staging tests. Two of those follow-ups (the AccessPage scope-dropdown fix and the four-commit issue-16 investigation) ate substantially more time than the milestones; both went deeper into rule-driven query design and stale-token windows than Phase 6's planning anticipated.

The ten commits group naturally into:

### Milestone 1 — routes, scaffolding, forms (`1485d69`)

Eight new routes and the core surface area:

- **`features/requests/components/NewRequestForm.tsx`** — shared `add_manual` / `add_temp` form; scope dropdown for multi-role principals; building checkboxes for stake scope; live duplicate-warning via `useFirestoreDoc(seatRef(member_canonical))`; `react-hook-form` + zod via the Phase 5 `schemas.ts` pattern. Member-name required client- and server-side. Per-role wrapper pages at `/bishopric/new` and `/stake/new` source their scope set from the principal and feed the shared form.
- **`features/manager/queue/QueuePage.tsx`** (413 LoC) — live FIFO list filtered to `status == 'pending'`. Per-row Mark Complete dialog (CompleteAdd is a `runTransaction` writing the seat doc + flipping the request atomically; CompleteRemove flips the request and lets Phase 8's `removeSeatOnRequestComplete` Admin-SDK trigger handle the seat delete). Reject dialog with required reason field. Duplicate-existing-seat chip on add-type cards.
- **`features/myRequests/`** — cancel mutation already shipped in Phase 5; Phase 6 hardened the e2e path. Inline rejection-reason rendered on rejected rows (replacing Phase 5's "Show Rejection Reason" expand button).
- **`features/requests/components/RemovalAffordance.tsx` + `RemovalDialog.tsx`** — X icon on manual + temp roster rows across bishopric Roster, stake Roster, and manager All Seats. Auto rows render no affordance. Required-reason modal. Once submitted, the row shows a "removal pending" badge driven by `usePendingRemoveRequests`.
- **R-1 race handling** — the CompleteRemove client transaction reads the seat doc inside the tx; if absent (the seat was already removed out-of-band before the manager clicked Mark Complete), the request flips with `completion_note` and only one audit row lands (because no seat write happened). Per `firebase-migration.md` Phase 6 line 832.
- **Atomic complete-add transaction** — seat write + request flip in one `runTransaction`. The transaction body reads the request doc inside the tx to validate `status == 'pending'`, then writes both docs. Concurrent double-completes hit the Firestore optimistic-concurrency check and the second loses cleanly with a 409-equivalent error toast.
- **Default-landing flips** — Phase 5 had `defaultLandingFor()` returning `/stake/roster` for stake and `/bishopric/roster` for bishopric as a placeholder. Phase 6 flipped these back to `/stake/new` and `/bishopric/new` per `spec.md`'s "leftmost nav tab" rule. Manager stays at `/manager/dashboard`. New Request is now leftmost in stake + bishopric nav blocks; the Queue link sits second-to-leftmost in the manager nav block (after Dashboard, before All Seats).
- **Deep-links** — `?p=stake/new`, `?p=bish/new`, `?p=mgr/queue`, plus the bare `?p=new` shortcut that resolves to whichever role's New Request page applies for the principal.

### Milestone 2 — web unit tests + cleanup (`b995abf`)

`NewRequestForm` validation tests (member name + reason required; `add_temp` date validity; stake-scope buildings gating; duplicate-warning surface). All four request schemas covered in `schemas.test.ts`. `QueuePage` tests for empty / populated states, dialog gating, reject-with-empty-reason, duplicate chip. Updated existing All Seats / Bishopric / Stake roster test mocks for the new `RemovalAffordance` dependency. Format pass.

### Milestone 3 — e2e specs + rule-driven query fixes (`fe5cdc0`)

Two query-shape fixes surfaced when wiring the e2e specs against real Firestore:

- **Submit pre-allocates the request doc id** via `doc(col)` + `setDoc` so the `request_id` field is set on the create payload itself. The original `addDoc` plan would have needed a follow-up update, which would have collided with the rules' status-transition predicate (`hasOnly(['status', ...])` on update). Pre-allocation also unblocks the queue card's `data-testid` lookup path which keys on `request.request_id`.
- **`usePendingRemoveRequests` filters by scope as well as member.** The requests-list rule predicate keys reads off `scope` for bishopric users (so they only see their own ward's requests), so a member-only query was rejected by Firestore for bishopric viewers. The query now passes both `where('member_canonical', '==', ...)` and `where('scope', '==', principal.ward)` (or `'stake'` for stake-scope viewers). New composite index `requests / (scope, type, status, member_canonical)` added in `firestore/firestore.indexes.json`.

Plus 5 new e2e lifecycle specs in `e2e/tests/requests/lifecycle.spec.ts`: `add_manual` happy path, `add_temp` two-buildings, cancel, reject, remove with badge. Updated `seats/role-landing.spec.ts` for the new default landings.

### 13-issue staging-test follow-up (`cc5447f`)

Operator surfaced 13 issues during manual staging of milestones 1–3. Fixed in one commit:

- **Combobox white background** (#1) — Tailwind's `cn()` was collapsing `bg-white` and `bg-[image:url(...)]` into the same `bg-` slot, dropping the white. Switched to `bg-[image:url(...)]` so the colour and the chevron image coexist on the same shorthand. (This was a partial fix; round-2 below revisits.)
- **Checkbox alignment** (#2, #7) — `:has(> input[type=checkbox])` selector on `.kd-wizard-form` plus a new `.kd-buildings-fieldset` + `.kd-checkbox-list` style pair so the Buildings group lays out as a row of (checkbox + label) instead of column-stacked label with floated checkboxes.
- **Inline rejection reason** (#3) — replaced the "Show Rejection Reason" expand button on MyRequests rejected rows with the reason rendered inline.
- **Access page scope dropdown claim-driven** (#4) — initial fix made the dropdown reflect the principal's claims (manager: all wards + stake; stake-only: stake; bishopric: their wards). Round-2 below replaced this with a fully data-driven version sourced from the `wards` collection.
- **`void invalidateQueries`** (#5) — surfaced T-24. The DIY hooks' never-resolving placeholder `queryFn` (per architecture D11) means a bare `qc.invalidateQueries()` in `onSuccess` returns a Promise that never resolves; mutations using `mutateAsync` hang forever. Fix: `onSuccess: () => { void qc.invalidateQueries(); }` — fire-and-forget. Applied selectively to mutations in Configuration / Access / All Seats / Bootstrap. T-24 (audit + fix everywhere) opened in `TASKS.md` as cross-cutting follow-up.
- **KindooManager pre-check** (#6) — Configuration manager-add now calls `getDoc` first; if the canonical already exists, throws "Already a manager." rather than silently merging via `setDoc`.
- **AuditLog reject_request → red** (#8) — recategorised to system / red so destructive rejections stand out from the green submit / complete / cancel lifecycle.
- **Stake-timezone date format** (#9) — new `formatDateTimeInStakeTz` helper (`YYYY-MM-DD h:mm am/pm`) driven by `stake.timezone`. Used for the audit row timestamp column + threaded into `formatDiffValue` so embedded timestamps in diff cells localise correctly.
- **`manual_grants` flatten** (#10) — per-scope rows in the diff table (`manual_grants[CO]`, `manual_grants[stake]`) instead of dumping the whole map as a JSON cell.
- **Hide canonical email** (#11) — strip `*_canonical` fields from inline summary + diff table; prefer typed `member_email` for canonical-keyed `entity_id` display.
- **AuditLog filter UX** (#12) — typed inputs canonicalise on Apply: typed email → `canonicalEmail()` for actor / member / email-shaped `entity_id`; literal `Importer` / `ExpiryTrigger` actor strings pass through unchanged. Placeholders updated.
- **Summary alignment** (#13) — `.kd-filter-summary` class replacing inline `alignSelf: center`, aligns to the bottom of the select control on All Seats + Access.

### 3-issue follow-up round 2 (`34dc591`)

Three issues that didn't fully resolve in round 1:

- **`create_access` JSON dump → readable per-scope rows** (#1) — `formatDiffValue` now recognises `ManualGrant[]` arrays and renders one readable line per grant (`reason · by typed-email · at YYYY-MM-DD h:mm am/pm`). Strips the canonical half of `granted_by`; renders the `granted_at` envelope shape (`{type: firestore/timestamp/1.0, seconds, nanoseconds}`) that audit-trigger payloads carry. ActorRef-shaped objects (`{email, canonical}`) collapse to the typed email in nested-map cells. Map cells render as `key=value, key=value` instead of raw JSON.
- **Combobox grey via `tailwind-merge` slot collision** (#2) — round-1's `bg-[image:url(...)]` fix was collapsed by `tailwind-merge` (which `cn()` uses) into a single `bg-` slot. Page chrome's transparent-`select` reset then bled through, inheriting grey. Final fix: own the chrome via the `.kd-select` CSS class with class-membership specificity (0,1,0) winning over the element-selector reset (0,0,1). Tailwind utility classes for the chrome are gone from `Select.tsx`. Class-membership regression test in `Select.test.tsx`.
- **Dates UTC default → America/Denver** (#3) — `formatDateTimeInStakeTz` / `formatDateInStakeTz` now default to `America/Denver` when no timezone is supplied (was UTC). The stake doc loads asynchronously via `useStakeDoc`, so several audit rows would render under the UTC fallback before the doc resolved. Defaulting to the v1-deploy stake's tz fixes the render-on-load case; the field-driven tz still wins once the doc resolves. Removed the duplicate `formatTimestampInTz` helper in `summarise.ts` (consolidated onto the shared helper).

### Issue 4 — Access page scope dropdown data-driven (`702e1e3`)

The original "scopes the user has access to" intent meant configured wards in this stake, not the principal's claim set. A manager (the typical user of this page) holds stake-wide authority, so the round-1 claim-filter returned every ward + stake — no visible difference, but architecturally wrong. Decoupled `AddManualGrantForm`'s scope dropdown from the page-level claim-filtered scopes: the form now reads `useStakeWards()` directly and renders `'stake'` plus one option per configured ward (sorted alphabetical). Loading-state disables the select + submit. Zero-wards case shows only `'stake'` and a helper line points at Configuration. The page-level filter dropdown (which controls which existing access docs render) keeps its claim-driven shape — different concern, different behaviour. Three regression tests in `AccessPage.test.tsx`.

### Issue 16 — multi-round investigation (4 commits, `982be4e` through `f06ec5a`)

Operator hit "Missing or insufficient permissions" repeatedly during staging. Four rounds, each fixing a real but distinct bug:

**Round 1 — rules role-clause widening (`982be4e`).** A pure manager (manager:true, stake:false, wards:[]) submitting any-scope request was denied because the requests-create rule's role-clause required `(scope == 'stake' && isStakeMember(stakeId)) || (scope in bishopricWardOf(stakeId))`. Per spec §6 + invariant 7, managers can submit any-scope, but the rule didn't honour that. The existing self-approval test paved over the gap by stacking both manager:true and stake:true on the same persona; pure-manager submission was never exercised. Fix: OR-in `isManager(stakeId)` at the head of the role-clause. Three new pure-manager submit assertions in `firestore/tests/requests.test.ts` (stake-scope add_manual, ward-scope add_temp, remove). Self-approval test rewritten to use a real pure-manager context. Hook-level test in `useSubmitRequest.test.tsx` asserting the mutation hands `setDoc` a payload matching the rule predicate.

**Round 2 — page scope-set + token refresh (`6fd4d93`).** Fix #1 didn't unblock the operator. Two more compounding causes: (a) `NewRequestPage` gated `/stake/new` on the stake claim specifically, returning `scopes:[]` for pure managers — they hit "no role" before submit; (b) the submit hook read claims via `user.getIdTokenResult()` which returns the cached token, so a user freshly added to `kindooManagers` could have a token predating the `syncManagersClaims` write. Fixes: NewRequestPage now resolves scopes via `[{stake}]` when isManager OR stake-claim; `/bishopric/new` uses all configured wards when isManager (data-driven from `useFirestoreCollection(wardsCol)`). The submit hook now calls `getIdTokenResult(true)` to force-refresh on every submit. Diagnostic logging on success + failure paths gated on `NODE_ENV !== 'test'`. New requests-rules test exercising the full form payload (capitalised `member_email`, pre-canonicalised `member_canonical`, `lastActor` matching the manager) → ok; catches shape regressions the slim fixtures don't.

**Round 3 — Access page hooks (`11e19bf`).** Operator's "Stake Access request" turned out to mean adding a stake-scope manual ACCESS GRANT via the Access page's `AddManualGrantForm`, not submitting a request via `NewRequestForm`. The two previous rounds had been chasing the wrong page. Mirror-fix: `useAddManualGrantMutation` + `useDeleteManualGrantMutation` now call `getIdTokenResult(true)` inside the mutation body, building the actor record from the freshly-refreshed token. `actorOf(principal)` retired; mutations use the new `readRefreshedActor()` helper returning `{email, canonical, claims}`. Diagnostic logging tagged `[add-manual-grant]`. Six new hook tests in `useAddManualGrantMutation.test.tsx` covering force-refresh, create + update payload shapes, rule-shape conformance, throw-on-no-auth, canonical fallback, and the composite-key duplicate (scope, reason) pre-check. New rules test for the form-shaped pure-manager create payload.

**Round 4 — affectedKeys allowlist (`f06ec5a`).** Operator's diagnostic trace from round 3 surfaced the actual denial: the add-manual-grant mutation's UPDATE path was including `member_email` + `member_name` in the update payload. The access rule's update predicate requires `diff.affectedKeys().hasOnly(['manual_grants', 'last_modified_by', 'last_modified_at', 'lastActor'])`. `member_email` + `member_name` aren't on that list → `hasOnly` fails → permission-denied. Both fields are set-once on CREATE and immutable on UPDATE (renaming a member's display fields is a separate flow that doesn't exist yet — tracked by spec §3.1 split-ownership). Fix: drop `member_email` + `member_name` from the UPDATE payload; CREATE-path unchanged. Hook test now asserts the EXACT key set in the update payload (replacing the prior `toMatchObject` subset assertion that silently passed). Regression rules test reproducing the operator's exact trace shape, plus a paired `assertSucceeds` for the same payload with those fields stripped.

## Deviations from the pre-phase spec

Three architectural calls the web-engineer made that diverge from the migration plan's letter, plus the two rules-side calls.

- **Per-role NewRequest routes** (`/stake/new`, `/bishopric/new`) instead of one shared scope-derived form. The migration-plan sub-task list reads as one form; the web-engineer split per-role to mirror Phase 5's per-role roster pattern (`/stake/roster`, `/bishopric/roster`). Multi-role users see both nav links; the shared form component still handles multi-ward bishoprics via the scope dropdown. Spec wording diverged but the per-role pattern matches Phase 5's already-shipped form factor and was the lowest-friction path.
- **Pre-allocated request_id (ref + setDoc) instead of `addDoc`.** Needed because the queue card's `data-testid` and lookup path read `request.request_id`, and a follow-up update on a created doc would collide with the rules' status-transition `hasOnly` predicate on update. Pre-allocation moves the id assignment client-side and writes the field on the original create.
- **`removeSeatOnRequestComplete` Cloud Function deferred to Phase 8.** Phase 6 wires the request-flip side; the Admin-SDK seat delete on `remove`-completion is Phase 8's lane (because rules' `seats.delete` can't see the linked request, per `firebase-schema.md`). The R-1 no-op path (seat already gone before manager clicks Mark Complete) is handled fully client-side in the CompleteRemove transaction.
- **Rules role-clause widening for managers** (`firestore.rules`). Pure-manager submit was a real gap, not a deviation per se — spec §6 + invariant 7 already required it — but the rule didn't enforce it pre-Phase-6. Added `isManager(stakeId)` to the requests-create role-clause. New composite index `requests / (scope, type, status, member_canonical)` added for the per-row removal-pending lookup.
- **Force-refresh ID token on every write.** Mutations with rule-side claim dependencies (request submit, manual grant add/delete) now call `getIdTokenResult(true)` inside the mutation body. Costs one extra round-trip per click — negligible for interactive forms — and unconditional so the staging staleness window cannot recur. Recorded as the load-bearing pattern for any future write whose rule predicate reads `request.auth.token.canonical` or `request.auth.token.stakes[sid].*`.

## Decisions made during the phase

The load-bearing one is the **access UPDATE allowlist semantic**: the rule's `affectedKeys().hasOnly([...])` is the canonical contract; `member_email` and `member_name` are set-once on CREATE only and any update payload that carries them is denied. Mutation hooks must conform — strip the create-only fields before calling `updateDoc`. The hook test now asserts the EXACT key set rather than `toMatchObject`-subset, so a future engineer can't reintroduce the regression silently.

The **force-refresh ID token** pattern is the second load-bearing call. Any write whose rule predicate reads from `request.auth.token` claims (canonical, stakes, etc.) needs to call `getIdTokenResult(true)` inside the mutation body before constructing the actor record or invoking the SDK write. The cached-token staleness window between a `kindooManagers`/`access` doc write and the next-natural-refresh of the in-browser ID token is wider than 0 seconds, so without this any user freshly granted a role hits permission-denied on their first interaction. Diagnostic logging (`[submit-request]`, `[add-manual-grant]`) is in place to surface any further denial via console paste.

The Issue 16 trail also surfaced **T-24** (audit-and-fix unscoped `qc.invalidateQueries()` calls) — the DIY hooks' never-resolving placeholder `queryFn` per architecture D11 means a bare `invalidateQueries()` in `onSuccess` returns a Promise that never resolves and `mutateAsync` hangs forever. PR #29 applied `void invalidateQueries` selectively to mutations in Configuration / Access / All Seats / Bootstrap; the rest of the codebase remains potentially affected.

No new architecture D-numbers earned. The rules role-clause widening, the affectedKeys allowlist, and the force-refresh pattern are all enforcement of existing invariants (spec §6 + invariant 7; `firebase-schema.md` §6 update predicates; D11's never-resolving placeholder side-effects) rather than new design.

## Spec / doc edits in this phase

`docs/spec.md` is **not** touched. Phase 6 is a behaviour-port; `spec.md` describes Apps Script reality until Phase 11 cutover.

- `docs/architecture.md` — unchanged.
- `docs/firebase-migration.md` — unchanged. Phase 6 section already accurate; the `removeSeatOnRequestComplete` deferral was already documented in the Phase 6 "Note" block at line 832.
- `docs/firebase-schema.md` — unchanged. The new composite index added to `firestore/firestore.indexes.json` is data-only; rule shapes are unchanged from Phase 3 close apart from the role-clause widening, which is recorded here.
- `docs/changelog/phase-6-request-lifecycle.md` — this entry.
- `docs/TASKS.md` — T-24 opened during this phase; T-22 (bootstrap-wizard rules escape hatch) added during parallel Phase 7 wizard work.

## Deferred / follow-ups

- **T-24 — audit-and-fix unscoped `qc.invalidateQueries()` calls.** Cross-cutting; PR #29 applied `void invalidateQueries` selectively, but every future engineer who writes `onSuccess: () => qc.invalidateQueries()` in expression-arrow form reproduces the hang. Repo-wide audit (lint rule? grep + manual review?) plus the option-(2) refactor (replace the placeholder `queryFn` with one that resolves immediately) both still open.
- **Diagnostic logging.** `[submit-request]` and `[add-manual-grant]` console prefixes are gated on `NODE_ENV !== 'test'`. Could be removed when production-confidence builds, or kept as ongoing operator-debug aid. Open question; nothing scheduled.
- **Bootstrap-admin stake-doc seed runbook re-walk.** The Issue 16 / Phase 7 wizard iteration cycles caught real gaps in the operator runbook. Re-walk `infra/runbooks/provision-firebase-projects.md` §4.4 at Phase 11 cutover to ensure the runbook captures everything learned. No new task entry; tracked as Phase 11 prep.
- **"Folder-tab" nav restyling** still deferred from PR [#14](https://github.com/tad-smith/kindoo_access_tracker/pull/14). User-facing visual polish; not blocking Phase 6.
- **`removeSeatOnRequestComplete` Cloud Function** → Phase 8.
- **Rename-member display-fields flow.** The access UPDATE allowlist excludes `member_email` + `member_name` because they're set-once on CREATE; renaming a member's display fields needs a separate flow. Spec §3.1 split-ownership flags it; no scheduled phase.

## Next

Phase 8 — the rest of the backend lane. Importer + expiry trigger + email + `removeSeatOnRequestComplete` Cloud Function. Backend-engineer's lane. The audit trigger already shipped in PR #21; Phase 6 confirmed it lands audit rows within ~1s on every write path. Phase 6's force-refresh-ID-token pattern, the rules-driven query shape (filter-by-scope-as-well-as-member for bishopric viewers), and the affectedKeys allowlist for split-ownership update payloads are all available for Phase 7 / 8 to reuse.
