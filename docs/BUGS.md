# Bugs

Cross-cutting known defects — live ones only. Closed and obsolete entries move to [`BUGS-archive.md`](BUGS-archive.md) so this file stays small enough to read whole.

Format per bug: `## [B-NN] <short imperative title>` then `Status:`, `Owner:`, optional `Phase:`, optional `Branch / PR:`, then a body describing symptom / repro / suspected layer / open questions. Numbering is `B-NN` (parallel to `TASKS.md`'s `T-NN`); never renumber, flip status in place when fixed, then move the entry to the archive.

---

## [B-29] Sync reminder UI copy still describes only the expired-seat condition
Status: open
Owner: @web-engineer
Phase: cross-cutting

T-106 (PR #293) gave `sendSyncReminderIfDue` a second, independent condition — a Kindoo site nobody has synced in seven days — but touched no file under `apps/web/`, so two pieces of copy now describe only half of what the toggle they sit beside actually does:

- `apps/web/src/features/manager/configuration/ConfigurationPage.tsx` (`SyncReminderToggle`'s `InfoTip`, ~line 1997): "A daily check that emails your active Kindoo Managers when a temporary seat has expired in Kindoo but is still on the SBA roster… it stops on its own once they are gone." That last clause is now wrong as well as incomplete — the backoff stamp is deleted only when *both* conditions clear (`architecture.md` D40), so a stake with a stale site but no expired seats keeps getting reminded, contradicting "stops on its own once they are gone."
- `apps/web/src/features/notifications/components/PushNotificationsPanel.tsx` (line 181): the push-category label reads `Sync reminders for expired temp seats`, which is the same one-condition framing.

Neither is a functional bug — the toggle and the push category still gate the right thing — but a manager reading either string has no way to learn the reminder now also fires on a stale sync. Update both strings (and any test pinning them) to name both conditions; `docs/spec.md` §9 and the "sync heartbeat" paragraph there describe the current behaviour to word it against.

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

