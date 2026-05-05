# Bugs

Cross-cutting known defects. Active bugs first, resolved-but-recent in place with `[FIXED YYYY-MM-DD]`, prune stale ones in periodic cleanup.

Format per bug: `## [B-NN] <short imperative title>` then `Status:`, `Owner:`, optional `Phase:`, optional `Branch / PR:`, then a body describing symptom / repro / suspected layer / open questions. Numbering is `B-NN` (parallel to `TASKS.md`'s `T-NN`); never renumber, flip status in place when fixed.

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
