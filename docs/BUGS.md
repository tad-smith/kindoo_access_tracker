# Bugs

Cross-cutting known defects. Active bugs first, resolved-but-recent in place with `[FIXED YYYY-MM-DD]`, prune stale ones in periodic cleanup.

Format per bug: `## [B-NN] <short imperative title>` then `Status:`, `Owner:`, optional `Phase:`, optional `Branch / PR:`, then a body describing symptom / repro / suspected layer / open questions. Numbering is `B-NN` (parallel to `TASKS.md`'s `T-NN`); never renumber, flip status in place when fixed.

---

## [B-10] Multi-grant partial-remove not supported — every SBA `remove` request triggers a whole-user revoke in Kindoo
Status: open
Owner: @web-engineer (extension portion + SPA roster UI), @backend-engineer (SBA schema + trigger)
Phase: post extension v2.2
Severity: medium

When an SBA user holds multiple grants on a single seat (e.g., a primary grant for the PC ward plus a `duplicate_grant` for the MO ward), there is no way to surgically remove just one of those grants. Operator intent — "remove this user from PC's roster; keep their MO access" — cannot be expressed in the current request schema, and neither the SBA seat trigger nor the v2.2 extension orchestrator honours it. The Remove button on a ward roster page produces a generic `remove` request that both sides interpret as "drop everything."

**Symptom:** clicking Remove on user X from the PC ward's roster page (where X also has an MO `duplicate_grant`) collapses to a whole-user revoke on completion. SBA deletes the entire seat — the MO grant is lost. The Chrome extension v2.2 orchestrator's `provisionRemove` whole-user-revokes from Kindoo (per the option-A simplification adopted on PR #88) — X loses all Kindoo environment access, not just access to the PC ward's buildings. SBA and Kindoo end up consistent (both fully revoked, so the cross-system safety property holds), but operator intent is silently violated.

**Repro:**
1. Submit and complete an SBA `add_manual` request for user X with `scope = PC`, one or more buildings selected. Seat created with primary grant on PC; Kindoo provisioned.
2. Submit and complete a second `add_manual` request for the same user with `scope = MO`. Seat updated — MO joins as a `duplicate_grant`; Kindoo now grants X access to both ward sets.
3. From the PC ward's roster page in SBA, click Remove on user X. A `remove` request is created.
4. Process that request through the Chrome extension v2.2.
5. **Expected (operator intent):** SBA drops the PC primary grant; MO becomes the new primary; Kindoo loses the PC ward's building rules but retains MO's.
6. **Actual:** SBA deletes the seat in full (MO grant gone); Kindoo fully revokes the user from the environment.

**Root cause — two layers:**

- **SBA `removeSeatOnRequestComplete` trigger** treats every `remove` request as a whole-seat delete. The request schema carries no field representing partial-remove intent — the trigger has nothing to branch on.
- **Extension `provisionRemove`** (post-PR-#88) always whole-user revokes. Earlier partial-revoke logic was abandoned because Kindoo's `SaveAccessRule` is a MERGE (additive) endpoint — it cannot remove rules. The correct primitive is `KindooRevokeUserFromAccesSchedule`, which removes a single rule per call (newly captured during v2.2 work). Neither the SBA request model nor the extension currently wires this up.

**Severity rationale:** medium. No silent SBA↔Kindoo drift — both systems end up fully revoked, so the cross-system invariant holds. The damage is to operator-facing semantics: a manager on a 200-user stake who wants to surgically remove just one of a user's grants will hit this every time. The mismatch between button label ("Remove" on PC's roster) and effect (whole-stake revoke) is the bug.

**Fix path (high-level — pick at design time):**

1. **Add explicit partial-remove signal to the `remove` request schema.** Either `grants_to_remove: { scope, type }[]` (enumerate exactly which grants to drop) or `whole_seat: boolean` with default `true` to preserve current behaviour. Schema change lands in `packages/shared`.
2. **Update `removeSeatOnRequestComplete`** to honour the signal. Whole-seat path: existing delete. Scope-specific path: update the seat — drop the matching grant from primary or `duplicate_grants[]`; if the removed scope was primary, promote a remaining duplicate to primary.
3. **Update extension `provisionRemove`** to compute target Kindoo state from the post-remove SBA seat shape. For each removed building, call `KindooRevokeUserFromAccesSchedule(EUID, ruleId)`. If post-remove rules is empty, call `RevokeUserFromEnvironment` to delete the env-user record. The `KindooRevokeUserFromAccesSchedule` endpoint wrapper is already shipped on PR #88 in preparation for this.
4. **SPA roster Remove buttons** must signal scope-specific intent. A ward-roster Remove means "drop this ward's grant"; a separate "Remove entirely from stake" affordance (new) signals whole-seat. UX copy and confirm-dialog text follow.

**Won't fix in v2.2 (PR #88):** operator explicitly chose option A (whole-user revoke) for v2.2 stability — partial-remove is deferred to a coordinated design pass spanning SBA schema, SBA trigger, extension orchestrator, and SPA roster UI.

**Branch / PR:** none — design pass not yet started.

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
