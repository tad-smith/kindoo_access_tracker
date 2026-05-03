# Phase 10.5 — Push notifications via FCM Web

**Shipped:** 2026-04-29
**Commits:** see PR [#40](https://github.com/tad-smith/kindoo_access_tracker/pull/40) (5 commits on `phase-10.5-fcm-push`).

## What shipped

Managers receive a Web push notification when a new request is submitted, paralleling the existing email. Email remains the source-of-truth channel; push is additive opt-in. Per-device subscription is managed from a new "Push Notifications" panel on the dedicated Notifications page under the Settings nav section. Each device is keyed by a stable `crypto.randomUUID()` persisted in localStorage, so disabling push on one device leaves other devices' tokens intact. The fanout trigger reads active managers' `userIndex` entries, filters on `notificationPrefs.push.newRequest === true` plus non-empty `fcmTokens`, calls FCM `sendEachForMulticast`, and prunes invalid tokens via `FieldValue.delete()`.

The phase shipped over five commits across two parallel lanes (web + backend) on a single branch:

- `005f89c` — sub-change A (shared schema): `userIndex` extended with `fcmTokens` + `notificationPrefs`.
- `456551f` — sub-changes A (re-applied on backend) + E (backend): `pushOnRequestSubmit` trigger + userIndex self-update rule.
- `9d0cc59` — sub-changes B + C + D (web): service worker, push panel UI, token registration hooks.
- `c532495` — TASKS.md: T-30 backend lane.
- `ba31a41` — `lastTouched` removed from client userIndex writes to satisfy the rule allowlist (cross-workspace constraint propagation; see below).

### Sub-change A — schema (`005f89c`)

`packages/shared/` — `userIndex` Zod schema gets two optional fields: `fcmTokens?: Record<deviceId, token>` and `notificationPrefs?: { push?: { newRequest: boolean } }`. Both append-only-safe; absent on read is treated as "no subscriptions" and "no preferences" respectively. No backfill required.

### Sub-change B — service worker (`9d0cc59`)

`apps/web/public/firebase-messaging-sw.js` (new). Compat-SDK style as FCM convention dictates. The static SW receives Firebase config via URL query params from the SPA's `register()` call so the file itself stays environment-agnostic. Background push renders via `self.registration.showNotification`; `notificationclick` focuses an existing window or opens `/manager/queue`. Workbox `navigateFallbackDenylist` extended to skip the SW path so the existing PWA SW (vite-plugin-pwa) doesn't intercept the FCM SW request. Coexists at distinct scope: FCM SW at `/firebase-cloud-messaging-push-scope`, Workbox SW at `/`.

### Sub-change C — settings UI (`9d0cc59`, relocated post-phase)

`PushNotificationsPanel` lives on a dedicated Notifications page under the Settings nav section (`/notifications`). The route is manager-only for-now; the page component itself is role-agnostic so future expansion (Phase 9 push for completed/rejected/cancelled requests visible to bishopric + stake users) only needs the route gate relaxed. Five render branches keyed by testid: `push-unsupported` / `push-requires-install` / `push-vapid-missing` / `push-denied` / `push-enable-button` / `push-subscribed-with-toggle`. The `requires-install` branch handles the iOS gotcha: iOS Web push requires the PWA installed to home screen (Phase 10 shipped that prerequisite).

The panel was initially placed inside `ConfigKeysTab` of `ConfigurationPage` per an early operator decision; relocated to its own page in a follow-up before phase close so the Settings nav has an obvious entry-point and the page is structured for future per-event toggles.

### Sub-change D — token registration (`9d0cc59`)

Three hooks: `useEnablePushMutation`, `useDisablePushMutation`, `useUpdateNewRequestPrefMutation`. Stable per-device id via `crypto.randomUUID()` persisted in localStorage on first subscribe. Subscribe flow: explicit `navigator.serviceWorker.register('/firebase-messaging-sw.js?...config', { scope: '/firebase-cloud-messaging-push-scope' })`, then `getToken({ vapidKey, serviceWorkerRegistration })`, then merge-set `userIndex/{canonical}` with the deviceId-keyed token slot and `notificationPrefs.push.newRequest = true`. Disable flow: `deleteField()` on the deviceId slot only — other devices on the same account untouched.

### Sub-change E — backend trigger + rules (`456551f`)

`pushOnRequestSubmit` (`onDocumentCreated('stakes/{sid}/requests/{rid}')`, pinned to `APP_SA`). Reads active managers from the stake's manager scope, fans userIndex lookups, filters on `notificationPrefs.push.newRequest === true` AND non-empty `fcmTokens`, calls `sendEachForMulticast`, and prunes invalid-token slots via `FieldValue.delete()` based on FCM error codes. Logs `{requestId, tokensSent, tokensInvalid, tokensCleaned}`. The header carries a forward-reference comment for Phase 9: when Phase 9's email-extension pattern lands, its trigger coexists with `pushOnRequestSubmit` (or the two are merged).

Firestore rules — `userIndex/{canonical}` self-update permitted with:

- `affectedKeys().hasOnly(['fcmTokens', 'notificationPrefs', 'lastActor'])`
- `lastActorMatchesAuth(request.resource.data)` integrity check (the writer's identity is recorded in `lastActor`).

Create + delete on `userIndex` remain server-only.

## Decisions made during the phase

Operator-decided departures from the original brief, plus discoveries during implementation.

- **10.5 ships before Phase 9.** Per operator decision. Phase 9 was gated on T-04, which closed 2026-05-02 — Phase 9 is now unblocked but hasn't shipped yet. Push is additive; when Phase 9 lands, its trigger coexists with `pushOnRequestSubmit` (or extends it). The forward-reference comment in the trigger header captures this.
- **`notificationPrefs.push.newRequest` defaults to `true` on subscribe.** Clicking "Enable" implies opt-in. Future per-category toggles can override on the Phase 10.5 follow-up if measured need exists.
- **VAPID private key NOT in Secret Manager.** Operator decision — the Admin SDK uses service-account auth for the send path, so the VAPID private key is never needed server-side. The VAPID *public* key ships as `VITE_FCM_VAPID_PUBLIC_KEY` (build-time env var, public by design).
- **No audit-row fanout for userIndex writes.** Operator decision — push subscription is ephemeral per-device noise; subscription state has full audit lineage via `lastActor` on the doc itself. Audit-trigger collection list does not include `userIndex` for push writes.
- **Push panel moved from Configuration → Config tab to a dedicated Notifications page under Settings.** Initial operator decision was to nest the panel inside Configuration; reversed before phase close so the Settings nav has a clear entry-point (`bell` icon, between Configuration and Audit Log) and the page is structured for future per-event toggles. Manager-only for-now; the page component itself is role-agnostic so Phase 9's bishopric/stake push categories only need the route gate relaxed.
- **iOS push gotcha rendered as its own branch.** `push-requires-install` testid; copy points at the home-screen install. Phase 10 shipped the install prerequisite, so the path is in place.

## Cross-cutting decisions

- **Web SW + FCM SW coexist at distinct scopes.** vite-plugin-pwa keeps `/`; FCM SW takes `/firebase-cloud-messaging-push-scope`. Workbox `navigateFallbackDenylist` extended so the SPA never intercepts the FCM SW path. DevTools → Application → Service Workers should show both during operator review.
- **Per-device tokens, not per-user.** `fcmTokens` is keyed by a stable `deviceId` (UUID in localStorage). Disable on one device leaves others alone. This matters because a user may sign in from desktop + phone + tablet and disable push on a single device without losing the others.
- **Rule allowlist drove a client write surface change.** Backend-engineer's allowlist (`fcmTokens`, `notificationPrefs`, `lastActor`) didn't include `lastTouched` — web-engineer's initial userIndex writes carried it from the existing pattern. The propagation: rule rejected the write → web-engineer dropped `lastTouched` from the userIndex push-write surface in `ba31a41`. Net: writes pass the rule; subscription state still has full audit lineage via `lastActor`. Worth recording as an example of cross-workspace constraint propagation that was caught early (rule tests failed, not production).

No new architecture D-numbers earned. The schema additions are field-level optional; the trigger pattern reuses Phase 8's parameterized-trigger conventions; the rule extension uses existing helpers (`lastActorMatchesAuth`, `affectedKeys().hasOnly(...)`).

## Spec / doc edits in this phase

`docs/spec.md` is **not** touched. Phase 10.5 is additive on the Firebase-only side; Apps Script reality (which `spec.md` still describes until Phase 11 cutover) has no push.

- `docs/architecture.md` — unchanged.
- `docs/firebase-migration.md` — Phase 10.5 stub flipped from `Deferred` to `[DONE]`; rest of entry intact.
- `docs/firebase-schema.md` — **not** updated in this phase. The new `userIndex.fcmTokens` and `userIndex.notificationPrefs` fields are not yet reflected in the schema reference. Same follow-up bucket as the Phase 10.3 / 10.4 schema-doc-sync entry in TASKS.md.
- `docs/data-model.md` — **not** updated. Same reason.
- `docs/changelog/phase-10.5-fcm-push.md` — this entry.

## Operator-side prerequisites

- **VAPID public key generation.** Firebase Console → Project Settings → Cloud Messaging → Web configuration → "Generate key pair". Copy the public key.
- **Set `VITE_FCM_VAPID_PUBLIC_KEY`** as an env var on staging + prod deploy.
- **Until set:** the panel renders the `push-vapid-missing` branch with operator-pointed copy. No crash; no broken UI.

## Test footprint

- **Web:** schema round-trips (5), `useLongPress` unit (preserved from 10.4), `PushNotificationsPanel` render tests (9 across 5 branches + click handlers), hook tests (6), lib tests (9). All preceding tests preserved.
- **Backend:** 8 integration tests for `pushOnRequestSubmit` — active-only filter; prefs filter; empty-tokens filter; tokens fan; both invalid-token error codes; mixed valid + invalid tokens; silent-skip on no subscribers; non-cleanup error codes preserved.
- **Rules:** 6 self-update test cases — allowed fields pass, denied uid / typedEmail / lastSignIn, denied without `lastActor.canonical` match, denied foreign update, denied unauthenticated.
- **E2E:** limited — real FCM doesn't work in Playwright. Settings page redirect for non-managers covered.

Realistic testing path is **real iOS device, real Android Chrome, real desktop Chrome** — Playwright + emulator can't validate FCM end-to-end.

## Areas worth focused operator review during staging

- **Real-device push delivery.** iOS (PWA installed to home screen), Android Chrome, desktop Chrome.
- **Permission denied recovery copy.** Confirm the `push-denied` branch reads sensibly when the user has previously denied permission at the browser level.
- **Coexistence of vite-plugin-pwa SW + FCM messaging SW.** DevTools → Application → Service Workers should show both at distinct scopes.
- **Disable on one device leaves other devices' tokens intact.** Subscribe on phone + desktop; disable on phone; submit a request; desktop still receives push.
- **All five panel render branches** visible at corresponding device states (unsupported / requires-install / vapid-missing / denied / enable-button / subscribed-with-toggle).

## Deferred / follow-ups

No cross-workspace follow-ups beyond what landed in this phase. Per-category push toggles (completion / rejection / cancellation / over-cap) remain out of scope until measured need.

## Next

Phase 9 (extended email patterns) is unblocked (T-04 closed 2026-05-02) and is now the next backend lane to land. Its push counterpart will coexist with or extend `pushOnRequestSubmit`. Phase 11 (data migration + cutover) remains the open critical-path lane; Phase 10.1 (left-rail nav redesign) is still operator-deferred.
