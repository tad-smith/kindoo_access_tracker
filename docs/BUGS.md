# Bugs

Cross-cutting known defects. Active bugs first, resolved-but-recent in place with `[FIXED YYYY-MM-DD]`, prune stale ones in periodic cleanup.

Format per bug: `## [B-NN] <short imperative title>` then `Status:`, `Owner:`, optional `Phase:`, optional `Branch / PR:`, then a body describing symptom / repro / suspected layer / open questions. Numbering is `B-NN` (parallel to `TASKS.md`'s `T-NN`); never renumber, flip status in place when fixed.

---

## [B-12] Manager cannot delete a calling template — "missing or insufficient permissions"
Status: closed (fixed in PR — branch `fix/b-12-calling-template-delete-rule`)
Owner: @backend-engineer
Phase: post Phase 11
Severity: low-medium

Manager-Configuration "Auto Callings" tab — clicking Delete on a `wardCallingTemplates` or `stakeCallingTemplates` row throws `"missing or insufficient permissions"` from Firestore. Editing and adding rows work; only delete fails.

**Symptom:** SPA's `useDeleteWardCallingTemplateWithResequenceMutation` / `useDeleteStakeCallingTemplateWithResequenceMutation` issues a `writeBatch` that deletes the doc and resequences survivors. The delete leg is rejected with `FirebaseError: Missing or insufficient permissions`.

**Repro:** sign in as a Kindoo Manager; Configuration → Auto Callings (ward or stake) → Delete any row; observe the permission error and the row remains.

**Root cause:** `firestore.rules` had a combined `allow write: if isManager(stakeId) && lastActorMatchesAuth(request.resource.data);` predicate for both calling-template collections. For a delete, `request.resource.data` is null (no after-state), so `lastActorMatchesAuth` evaluates against an absent value and the predicate fails. Wards / buildings / kindooManagers already split into `allow create, update` + `allow delete` for exactly this reason; calling templates were the odd ones out.

**Fix:** split the combined `write` into `allow create, update: if isManager(stakeId) && lastActorMatchesAuth(request.resource.data);` + `allow delete: if isManager(stakeId);` on both `wardCallingTemplates` and `stakeCallingTemplates`. Same authority that can edit can also delete; no widening beyond that. No SPA change needed — the audit trigger already reads `lastActor` from the BEFORE snapshot on deletes, so the pre-delete stamp from the last upsert/reorder surfaces in the audit row. Both calling-template collections are in the audited list (`auditWardCallingTemplateWrites` + `auditStakeCallingTemplateWrites` in `functions/src/triggers/auditTrigger.ts`).

**Branch / PR:** `fix/b-12-calling-template-delete-rule`.

---

## [B-7] syncApplyFix doesn't populate sort_order or write access docs for auto seats
Status: closed (fixed in PR — branch `fix/b-7-sync-fix-importer-parity`)
Owner: @backend-engineer
Phase: post Phase 11
Severity: medium

`functions/src/callable/syncApplyFix.ts` (the Sync Phase 2 per-row fix endpoint) is an incomplete clone of the LCR Sheet importer's seat-create / seat-mutate paths. When a manager uses the extension's Sync Phase 2 fix flow to create or modify an **auto** seat, two fields that the importer always sets get dropped:

1. **`sort_order` on the seat doc.** The importer computes `MIN(sheet_order)` across matched calling templates and stamps it on auto seats (`functions/src/services/Importer.ts:384`; `functions/src/lib/diff.ts:61-65`). The roster pages sort auto seats by this field (`apps/web/src/lib/sort/seats.ts:44-51`); missing values fall to `Number.POSITIVE_INFINITY`, so sync-created auto seats sink to the bottom of the auto band.
2. **`access` doc creation.** For each matched calling template where `give_app_access === true`, the importer writes a corresponding `access` row that grants the user SBA app login + role (`Importer.ts:328, 344`). The extension's fix path didn't touch `access` at all, so sync-created auto seats never gained app access.

Both fields apply only to auto seats. Manual / temp seats don't have `sort_order` and don't drive `access`-doc creation in the importer — `syncApplyFix` mirrors that.

**Symptom:** a manager clicks Apply on a Sync Phase 2 drift fix that creates or makes-auto a seat. The seat appears on the roster but sorts after every importer-stamped auto seat (no sort_order), and the user doesn't appear in the access roster / can't sign in to the SBA app even when their calling template has `give_app_access=true`.

**Repro:**
1. Have a Kindoo seat the LCR sheet doesn't yet reflect (or whose type SBA records as non-auto).
2. Open the extension's Sync tab; pick the corresponding `kindoo-only` / `extra-kindoo-calling` / `type-mismatch (→auto)` drift row.
3. Click Apply.
4. SBA roster: seat appears at the bottom of the auto band (no `sort_order`); access roster: user absent even when the calling has `give_app_access=true`.

**Root cause:** the Sync Phase 2 callable was a partial clone of the importer's write logic — it preserved seat shape but lost the template-driven `sort_order` derivation and the parallel `access`-doc fan-out. Behavioural drift between two code paths that touch the same data; invisible to type-check.

**Fix (this PR):**
- `applyKindooOnly` (auto path): inside the transaction, load calling templates for the seat's scope, compute `sort_order = MIN(sheet_order)`, write the seat with `sort_order` stamped, and write an `access` doc with `importer_callings[scope] = [give_app_access=true callings]`. Manual / temp paths unchanged.
- `applyExtraKindooCalling` (auto seat): recompute `sort_order` over the full post-append calling set; write/merge `access` doc for any newly-appended `give_app_access=true` callings.
- `applyTypeMismatch`:
  - `manual/temp → auto`: stamp `sort_order` from existing callings; write `access` doc for `give_app_access=true` matches.
  - `auto → manual/temp`: clear `sort_order` (via `FieldValue.delete()`); drop `importer_callings[scope]` on the access doc. If the post-drop importer_callings is empty AND no `manual_grants` remain, delete the access doc (mirrors the importer's `planDiff` `accessDeletes` predicate); otherwise update it.
- Cross-reference comments added at the top of `syncApplyFix.ts` and mirror-image comments at the top of `Importer.ts` + `diff.ts` so the next agent touching either side knows to update its sibling.

`applyScopeMismatch` / `applyBuildingsMismatch` don't touch type or callings, so the parity bookkeeping doesn't apply to them.

**Branch / PR:** `fix/b-7-sync-fix-importer-parity`.

---

## [B-6] auditDiff reports nested-object key reorderings as field changes
Status: closed (fixed in PR #86)
Owner: @backend-engineer
Phase: post Phase 11
Severity: low-medium

The audit trigger's `deepEqual` helper (`functions/src/lib/auditDiff.ts:79-88`) compares values with `JSON.stringify(x) === JSON.stringify(y)`. `JSON.stringify` serialises object keys in insertion order, so two structurally identical objects whose keys happen to be ordered differently compare as not equal. Out-of-band writes (Firebase Console, ad-hoc Admin-SDK scripts) routinely round-trip nested-object fields through paths that don't preserve the original key order — the round-tripped value carries identical data with a different key order, and the diff flags the field as changed.

**Symptom:** the audit row's `changed` list includes a nested-object field whose `before` and `after` snapshots contain the same keys and values in different orders. The field-level diff is correct (the bytes really are not byte-equal under `JSON.stringify`); the trigger's classification of the field as changed is wrong.

**Concrete instance (prod, 2026-05-13):** operator made a Firebase Console edit changing only `stakes/csnorth.stake_name` from `STAGING - Colorado Springs North Stake` to `STAGING -- Colorado Springs North Stake` (added one dash). The audit row correctly captured the `stake_name` diff and correctly attributed the actor as `OutOfBand` (B-5 fix landed). It also reported `kindoo_config` as changed, with:

- before: `configured_at=2026-05-13 3:24 am, site_id=27994, configured_by=tad.e.smith@gmail.com, site_name=Colorado Springs North Stake`
- after: `site_name=Colorado Springs North Stake, configured_by=tad.e.smith@gmail.com, configured_at=2026-05-13 3:24 am, site_id=27994`

Identical data, different key order. The Manager Audit Log page displays nested-object keys in insertion order, so the rearrangement surfaces to the reader as a "change."

**Repro:**
1. Have a doc with a nested-object field (e.g. `stakes/csnorth.kindoo_config`).
2. Make any out-of-band write (Console, Admin SDK) that mutates a different field on the same doc.
3. Observe the audit row reports the nested-object field as changed when only key order differs.

**Severity:** low-medium. No data-integrity impact. Generates spurious audit noise — any out-of-band write that touches a doc with nested-object fields will surface false changes on the untouched nested objects. Reduces trust in audit traceability: an operator scanning audit history can't tell at a glance which "changes" reflect real edits and which are key-order artefacts.

**Root cause:** `functions/src/lib/auditDiff.ts:79-88`'s `deepEqual` uses `JSON.stringify(x) === JSON.stringify(y)`. `JSON.stringify` is order-sensitive for object keys. Firestore's normal SDK writes preserve insertion order, so this worked for in-app writes; Console and Admin-SDK writes can serialise keys differently. The file's leading comment (lines 26-31) already calls out this trade-off as acceptable on the basis that "a key-reordering write is rare" — the first prod out-of-band write demonstrated it isn't.

**Proposed fix:** replace the `JSON.stringify`-based `deepEqual` with a proper recursive deep-equal helper that compares object key-sets and recurses on values, treating object property order as irrelevant. Arrays remain compared positionally. Primitives, `null`, and Firestore Timestamps (`{seconds, nanoseconds}` plain objects on the trigger side) continue to compare correctly because their structure is fixed. A ~25-line pure function; no new dependency. Update the file's leading comment to drop the stale "key-reordering write is rare" caveat. Add unit tests covering the key-order-irrelevance behaviour for at least nested objects, arrays-of-objects, and the Timestamp-shaped plain object.

**Won't fix in:** any in-flight PR — file as a standalone bug, fix in its own PR.

**Fix:** PR #86 replaces the `JSON.stringify`-based `deepEqual` in `functions/src/lib/auditDiff.ts` with a recursive deep-equal helper that compares objects by key set (not key order), recurses on values, and continues to compare arrays positionally; new unit tests in `functions/src/lib/auditDiff.test.ts` cover the key-order-irrelevance behaviour including the prod `kindoo_config` regression case.

**Branch / PR:** PR #86 (`docs/b-6-audit-diff-key-order-false-positive`) — docs entry + fix.

---

## [B-11] New Request screen — when `scope === 'stake'`, all buildings should be checked by default
Status: closed (fixed in PR #93)
Owner: @web-engineer
Phase: post Phase 11
Severity: low-medium

On the New Request page, picking `scope === 'stake'` leaves every building checkbox unchecked. The manager has to manually tick every building to grant the requested user stake-wide access — for a stake with N buildings, N manual clicks per request, with the failure mode being a quietly-forgotten building rather than a visible error. The expected default is "all buildings checked" because stake-scope means "everywhere"; unchecking specific buildings to exclude is the rare case. Ward-scope requests are unaffected — the building is inherited from the ward and no checkbox UI renders on that path, so this is strictly a stake-scope UX defect.

**Symptom:** on `/new`, choose any member, set scope to `stake`, observe every building checkbox starts unchecked. Submitting without re-checking grants access to zero buildings (or however many the manager manually clicked).

**Repro:**
1. Open the SBA web app, navigate to `/new` ("New Request").
2. Pick any member; set scope to `stake`.
3. Observe: building checkboxes all start unchecked.
4. Expected: every building checked; manager unchecks specific ones to exclude.

**Severity:** low-medium. No data corruption, no security impact. Pure UX papercut that scales with stake size — every stake-scope request costs N clicks where N is the building count, and a forgotten building silently narrows the grant the manager intended to make stake-wide.

**Suspected layer:** the request form's default-state setter (likely `apps/web/src/features/requests/` form component). The `building_names` field initialises to `[]` regardless of scope; the scope-change handler doesn't repopulate the field when scope flips to `stake`.

**Proposed fix:** in the form's scope-change handler (or the `useFormDefaults` / `react-hook-form` `reset` path), when `scope === 'stake'`, set `building_names` to the stake's full building list (e.g. `stake.buildings.map(b => b.building_name)`). When scope changes to a ward, fall back to whatever the ward path uses today (the ward-scope branch doesn't render the checkbox UI, so the field value there is consumed elsewhere or ignored — confirm during implementation). Coordinate with `react-hook-form` reset semantics so the change re-renders the checkbox row.

**Won't fix in:** any in-flight PR — this is a standalone SPA UX bug, unrelated to the Chrome extension v2.2 work on PR #88. File and fix in its own PR.

**Fix:** PR #93 extends `defaultBuildingsForScope` in `apps/web/src/features/requests/schemas.ts` to accept the buildings catalogue and return every `building_name` for stake scope (ward scope unchanged). `NewRequestForm` threads its `buildings` prop into the initial-default `useMemo`, the scope-change effect, and the post-submit reset, so a stake-scope form mounts with every checkbox pre-ticked and a multi-role principal flipping ward → stake auto-populates the full list. Existing tests asserting "no defaults checked" for stake scope were updated; two new tests lock the B-11 behaviour (mount-in-stake-scope and ward→stake toggle).

**Branch / PR:** PR #93 (`fix/b-11-stake-scope-default-all-buildings`).

---

## [B-1] iPhone PWA notification tap doesn't navigate to the deep-link target
Status: open
Owner: @web-engineer
Phase: post Phase 10.5

When a manager taps a Phase 10.5 push notification on the iPhone PWA (installed via Safari, iOS 16.4+), the PWA comes to the foreground showing whatever screen was last visible — it does NOT navigate to `/manager/queue?focus=<requestId>` as expected. Push delivery itself works (notification arrives, body and title are correct); the deep-link path is what's broken.

The chain that should fire on tap:
1. SW's `notificationclick` handler reads `event.notification.data.deepLink`.
2. If a window client exists: SW posts `{ type: 'kindoo:notification-click', target }` and focuses the client. (`apps/web/public/firebase-messaging-sw.template.js:70-92`)
3. SPA's `serviceWorkerMessenger` listener receives the message and calls `router.history.push(target)`. (`apps/web/src/features/notifications/serviceWorkerMessenger.ts`)
4. TanStack Router resolves `/manager/queue?focus=<rid>`; QueuePage scrolls to + flash-highlights the matching card.

Somewhere in 1–4 the chain breaks on iOS specifically. Verified: latest staging build deployed; iPhone PWA running latest assets (operator confirmed). Desktop testing of the same path was NOT verified to work as the deep-link target — needs to be checked too.

**Investigation path:**
- Get iPhone-side logs via Safari Remote Inspector (iPhone Settings → Safari → Advanced → Web Inspector ON; macOS Safari Develop menu → iPhone → PWA window).
- OR add diagnostic `console.log` to: SW's `notificationclick` handler entry, SW's postMessage call, SPA's listener (every received message + type-guard pass/fail), `router.history.push` call.
- Check if `clients.matchAll` returns the existing PWA window when the PWA is in iOS background. If empty, the SW falls to the `clients.openWindow(target)` cold-launch path; iOS may handle `openWindow` differently for already-running PWAs.

**Suspected:**
- iOS doesn't fire SW `notificationclick` reliably when the PWA is suspended in the background; the OS notification tap may just bring the app to foreground without going through the SW handler.
- OR `clients.matchAll` returns the existing client but the postMessage doesn't get delivered before the focus completes.
- OR the SPA listener is registered but iOS PWA's foregrounding doesn't deliver SW messages buffered during suspension.

**Reproduction:**
- Device: iPhone (specific iOS version TBD by reporter), PWA installed via Safari, push notifications enabled.
- Submit a request from a different account → notification arrives on iPhone → tap.
- Expected: PWA opens at `/manager/queue?focus=<rid>` with the matching request scroll-into-view + flash-highlighted.
- Actual: PWA foregrounds at the last visible screen.

**Workaround:** none currently. User must manually navigate to the queue.

**Out of scope here:** the same path on desktop Chrome was not separately verified — could be the bug isn't iOS-specific. First step of investigation should be reproducing on macOS Chrome (which has full DevTools access).

**Branch / PR:** none — investigation hasn't started.

---

## [B-5] auditTrigger misattributes out-of-band writes to the doc's prior `lastActor`
Status: closed (fixed in PR #85)
Owner: @backend-engineer
Phase: post Phase 11
Branch / PR: `fix/b-5-audit-out-of-band-attribution` (PR #85)

`auditTrigger` resolves the actor of an entity write by reading the `lastActor` ActorRef on the after-snapshot of the modified doc. Client paths and Cloud Functions that mutate entities always stamp a fresh `lastActor` alongside the rest of the write, so the field on the after-snapshot reflects who actually made the change and the audit attribution is correct. Out-of-band writes that don't go through those paths — Firestore Console edits, ad-hoc `gcloud firestore` CLI tweaks, scripted Admin-SDK writes that forget to set `lastActor` — leave the field untouched. The audit trigger then reads whatever `lastActor` was already on the doc (typically the most recent scheduled function or trigger that wrote it) and records that prior actor as the author of the new change.

**Symptom:** the audit row's `actor`, field-level `before` / `after` diff, and `op` are all populated, but `actor` names a function or user who did not in fact make the change being recorded. The diff itself is correct — only the attribution is wrong.

**Concrete instance (prod, 2026-05-13):** operator manually edited `stakes/csnorth.kindoo_expected_site_name` in the Firebase Console to drop the `STAGING - ` prefix. The most recent prior write to that doc was from the `runExpiry` scheduled function, which had stamped `lastActor: ExpiryTrigger`. The audit row recording the Console edit reads:

- `actor: ExpiryTrigger`
- `op: update_stake`
- `changed: kindoo_expected_site_name`
- `before: STAGING - Colorado Springs North Stake`
- `after: Colorado Springs North Stake`

**Repro:** any Firestore Console edit (or other out-of-band write that doesn't stamp `lastActor`) to a doc that has a non-empty `lastActor` from a prior write. Confirm by inspecting the resulting audit row — it will name the previous writer, not the actor who just made the change.

**Severity:** low. No data-integrity impact (the field-level diff is correct); no security impact (Console / CLI writes bypass rules by definition and are gated at the IAM layer, not by audit attribution). The gap is purely in traceability — a row that says "this function changed this field" when the function did nothing of the kind.

**Root cause:** `functions/src/triggers/auditTrigger.ts` trusts `after.lastActor` as the source of attribution unconditionally. There is no check that the current write actually changed `lastActor`, so writes that leave the field stale silently inherit the prior actor.

**Proposed fix (post-v2.1):** compare `before.lastActor` and `after.lastActor`. When the two are equal AND the write mutated other fields, the trigger has no way to know who the real actor was — record a sentinel ActorRef like `{ email: 'out-of-band', canonical: 'out-of-band', source: 'console' }` (exact shape TBD; the field set should signal "attribution unknown, write did not come through a `lastActor`-stamping path"). The Admin Audit page in `apps/web` renders this distinctly from real actors so an operator scanning audit history can immediately tell a Console / CLI edit from an in-app action.

**Won't fix in v2.1 (PR #83).** The extension v2.1 PR is scoped narrowly; this gap predates it and isn't on its critical path. File and defer to a separate backend-engineer task after v2.1 lands.

**Fix shipped on `fix/b-5-audit-out-of-band-attribution`:** `auditTrigger.resolveActor` now compares `before.lastActor` and `after.lastActor` on updates. When they're structurally equal (both present and identical, or both absent), the writer didn't touch the field — the `isNoOpUpdate` gate already rejected pure-bookkeeping writes, so an equal `lastActor` on an update implies a tracked field changed without the canonical write path's actor stamp. The trigger records the sentinel `ActorRef { email: 'OutOfBand', canonical: 'OutOfBand' }` (see `functions/src/lib/systemActors.ts:OUT_OF_BAND_ACTOR`) instead of the stale prior actor. The before/after diff and the action enum are unchanged — only attribution. The Manager Audit Log page recognises `OutOfBand` as a synthetic actor via the shared `isAutomatedActor` helper (`packages/shared/src/systemActors.ts`) and renders it with the same `actor-automated` chip styling as `Importer` / `ExpiryTrigger`, so a Console / CLI edit reads as visually distinct from a real-user action. Creates and deletes are excluded from the detection (no meaningful before/after pair to compare) and fall through to the existing actor resolution. Past audit rows are not backfilled — only future writes get the sentinel treatment.

---

## [B-2] setupGate bootstrap-admin fallback uses `??` where `||` is needed
Status: closed (fixed in PR #81)
Owner: @web-engineer
Phase: post Phase 11 (deferred — non-blocking until next fresh-project bootstrap)
Branch / PR: `fix/b-2-setupgate-empty-canonical-fallback` (PR #81)

On a fresh Firebase project, the bootstrap admin signs in matching the seed doc's `bootstrap_admin_email` and lands on `SetupInProgress` instead of the bootstrap wizard. The gate's `adminCanonical === meCanonical` equality check fails because `meCanonical` is the empty string at that moment, so the wizard route is never selected even though the seed doc and the typed email agree.

`apps/web/src/lib/setupGate.ts:181` reads `const meCanonical = principal.canonical ?? canonicalEmailFn(principal.email ?? '');`. The principal shape (`apps/web/src/lib/principal.ts` / `principal-derive.ts`) sets `principal.canonical` from the `canonical` custom claim; for a user whose claims have not been minted yet (the bootstrap admin before `onAuthUserCreate` runs to completion), the field is the empty string `''`, not `null` / `undefined`. JavaScript's `??` only falls back on `null` / `undefined` and treats `''` as a present value, so the typed-email canonicalization branch never executes and `meCanonical` stays empty. The subsequent `adminCanonical && meCanonical && adminCanonical === meCanonical` short-circuits on the empty `meCanonical`, the gate returns `setup-in-progress`, and the wizard is never rendered.

**Repro:** fresh Firebase project; seed doc populated with `bootstrap_admin_email` matching a real account; sign in as that account before claims have been minted (i.e., the very first sign-in, before `onAuthUserCreate` finishes its `setCustomUserClaims` write); observe the gate routes to `SetupInProgress` instead of the bootstrap wizard.

**Workaround applied during prod bring-up (2026-05-03):** wait for `onAuthUserCreate` to deploy, delete the existing Auth user record, then sign back in so the trigger fires fresh and mints the canonical claim. After the canonical claim landed, the gate's equality check passed and the wizard rendered correctly.

**Fix shape:** swap `??` for `||` on line 181 so the empty string falls through to the `canonicalEmailFn(principal.email ?? '')` branch. Add a unit test covering the `principal.canonical === ''` case (no claims yet, empty-string canonical) — assert the gate evaluates to `wizard` when `bootstrap_admin_email` matches the typed email.

**Fix shipped in PR #81 (2026-05-03):** `apps/web/src/lib/setupGate.ts` swaps `??` for `||` on the `meCanonical` fallback. The two other `??` operators in the same file (`data.bootstrap_admin_email ?? ''` and `principal.email ?? ''`) were reviewed and left as-is — both pass through `canonicalEmailFn`, which collapses empty input to `''`, and the downstream `adminCanonical && meCanonical && ...` guard already short-circuits on the resulting empty string. `apps/web/src/lib/setupGate.test.ts` adds two regression cases: empty-canonical with matching typed email routes to `wizard`; empty-canonical AND empty-email still routes to `setup-in-progress`.

---

## [B-4] First-login users with pre-existing access docs land on NotAuthorized
Status: closed (fixed in PR #60)
Owner: @web-engineer
Phase: post Phase 11
Branch / PR: `fix/b-4-first-login-claims-race` (PR #60)

A first-time signer-in whose `access/{canonical}` doc predates their sign-in lands on NotAuthorized for up to ~1h, even though their role data is in place and the canonical-email mapping is correct. Reported in production for `zach.q.mortensen@gmail.com` with a pre-existing `access/zachqmortensen@gmail.com` doc (gmail dot-strip rule applied — mapping is correct).

**Symptom:** first sign-in by a user who has a pre-existing access / kindooManagers doc lands on NotAuthorized. Reloading the page once fixes it; the user then sees the correct role-gated UI.

**Repro:** any user whose `access/{canonical}` (or `kindooManagers/{canonical}`) row predates their first sign-in. Hits more often when the `onAuthUserCreate` trigger's read+seed work takes more than a few hundred ms (cold start, slow network, contention).

**Mechanism:** after `signInWithPopup` resolves, the client immediately calls `getIdToken(true)` (`apps/web/src/features/auth/signIn.ts`). Server-side, the v1 `auth.user().onCreate` trigger (`functions/src/triggers/onAuthUserCreate.ts`) runs in parallel with the client refresh — it writes `userIndex/{canonical}`, computes claims via `seedClaimsFromRoleData`, then calls `setCustomUserClaims` + `revokeRefreshTokens`. If the client refresh lands at the Auth backend before the trigger finishes `setCustomUserClaims`, the refreshed token has no role claims. `revokeRefreshTokens` invalidates future refreshes, but the just-minted token is cached on the client and used until the SDK's natural ~1h rotation OR a hard page reload (which re-fetches via `onAuthStateChanged`).

**Workaround for affected users:** reload the page once after sign-in.

**Fix shipped in this PR:** bounded poll-and-refresh after the initial `getIdToken(true)`. Probe `getIdTokenResult` for `claims.canonical` (the field the trigger always sets on success); if missing, sleep 500ms, force-refresh, retry. 10 iterations cap the wait at 5s. If claims never arrive, `signIn` still resolves and the gate handles "no claims → NotAuthorized" the same as today. Trigger model is unchanged (v1 async stays — the migration plan picked async over blocking deliberately).

**Status:** open — flip to `closed (fixed in PR #X)` once landed.

---

## [B-3] New Request scope dropdown is not filtered by the user's role union [FIXED 2026-05-03]
Status: closed (fixed in PR #52)
Owner: @web-engineer
Phase: post Phase 11

The scope dropdown on the New Request page surfaced `stake` plus every configured ward regardless of which roles the signed-in user actually held. A bishopric user with no stake claim could pick wards they had no access to; the rules-side `create` predicate then rejected the submit, leaving the user with a confusing post-submit error rather than a filtered dropdown that would have prevented the mistake at the point of selection.

**Symptom:** signed in as a single-ward bishopric member (no stake claim), the New Request scope dropdown showed `Stake` plus every ward configured for the stake. Selecting any other ward and submitting yielded a permission-denied error from Firestore.

**Repro:** sign in as a user whose claims hold only `bishopricWards: { csnorth: ['CO'] }` (no `stake: true`, no `manager: true`), navigate to `/new`, observe the dropdown contents.

**Suspected layer:** SPA filter on the scope dropdown — the `NewRequestPage` derived its scope list from a code path that treated Kindoo Manager / platform-superadmin status as "show every ward" rather than restricting the dropdown to the role union the user actually holds.

**Fix (this entry):** the scope-derivation logic moved into a pure helper `apps/web/src/features/requests/scopeOptions.ts` that consults only `principal.stakeMemberStakes` + `principal.bishopricWards[stakeId]`. Manager / superadmin status no longer adds scope options on its own — a manager who is also a stake member or a bishopric member inherits those scopes through the same paths every other user does. Unit tests cover every row in the spec table; component tests verify the page wires the helper correctly; an E2E spec proves the filter holds against the live emulator stack.

**Defense-in-depth:** `firestore.rules` already requires the requester hold the role for the scope being created (the `match /requests/{requestId}` create predicate at lines 470–474 evaluates `isManager(stakeId) || (scope == 'stake' && isStakeMember(stakeId)) || (scope in bishopricWardOf(stakeId))`). The current rule lets a Kindoo Manager create in any scope; per the operator-stated spec for this fix, manager status alone should not grant ward-scope creation either. T-36 tracks the rule-side hardening as separate backend-engineer work.

**Branch / PR:** `fix/b-3-new-request-scope-filter`.
