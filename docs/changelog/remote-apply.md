# Remote apply — tap on the phone, execute on the desktop extension

**Shipped:** 2026-08-03
**Commits:** PR #250 (`feat/remote-apply`), folding three parallel streams: `feat(shared)` + `feat(firestore)` (mailbox types + rules), `feat(web)` (queue UI), `feat(extension)` (opt-in, heartbeat, poller, `applyRequest` extraction).

## What shipped

A Kindoo Manager can now act on a pending request from their phone. They opt in once on their desktop Chrome extension ("Allow requests from my phone", top of the Queue tab); while that is on and a usable Kindoo tab is open, the extension heartbeats presence into `remoteApply/{canonicalEmail}`. The web queue on the manager's phone reads that presence and, while it is fresh, offers **Apply via extension** on each pending card. Tapping writes a job doc; the desktop claims it, runs the identical provisioning flow its own button runs, and writes the outcome back; the phone renders queued → running → applied ✓ / partial / failed live.

No new Cloud Functions, no new Chrome permissions, no new composite index, and no new role. The Requests Queue page is no longer read-only.

## Why polling, and why it was the only real option

Worth stating plainly because it looks like a lazy choice and isn't: **Kindoo writes can only happen in the content script.** They need the page's `localStorage.kindoo_token` and the active-site EID recovered by scraping the Kindoo header. Remote execution therefore already requires an open, signed-in Kindoo tab — and whenever that tab exists, the content script is mounted (on every page load, panel open or closed) and can simply poll.

That reduces push to a latency argument, and the latency is about five seconds. Buying those five seconds costs a VAPID keypair, a Secret Manager entry, a `web-push` sender, and a receiver in an MV3 service worker that structurally cannot hold state — and the receiver would still have to hand the work to the content script, which is where the poll already lives. At 1–2 requests a week that trade is not close.

Two other transports were considered and are dead on arrival rather than merely worse: a Firestore `onSnapshot` listener in the service worker (`onSnapshot` rides WebChannel, which needs `XMLHttpRequest`, undefined in MV3 — the same wall the reject path hit), and `externally_connectable` (same-device only; the phone is by definition a different device).

Recorded as `architecture.md` **D27**.

## Decisions made during the build

- **The heartbeat is gated on a *usable* Kindoo session, not on a token string.** `readKindooSession()` only proves a token exists; an expired one is indistinguishable from a live one until something calls the API. The loop resolves the active site name via Kindoo's `getEnvironments` on each heartbeat — a call it needs anyway, since the phone displays that name — and treats a rejection as "this desktop cannot act": no presence write, and the poll is skipped too. That costs one Kindoo API call per 60s per open Kindoo tab. It is worth it because **absence of a fresh heartbeat is the entire mechanism by which the phone learns the desktop can't help.** A heartbeat that outlived its session would leave the manager tapping a button that fails every time, with nothing on screen explaining why.

- **`partial` is a distinct terminal status, not a failure.** Kindoo took the write and `markRequestComplete` didn't. The phone says "Applied in Kindoo, but this request is still open here", tells the manager to finish it on the desktop, and deliberately offers **no Retry** — retrying would consume a second Kindoo licence. Calling this "failed" is the one wording mistake in the whole feature that costs real money.

- **The rules type-check the terminal fields but do not require them.** `finished_at`, `outcome`, `claimed_at`, and `claimed_by` are all optional in their transition branches. A denial on the extension's report-back would strand the job in `running` with the phone spinning forever, which is a worse failure than a terminal row missing a timestamp. Related: `outcome.code` is checked as `is string` rather than against the `RemoteApplyOutcomeCode` union, so the desktop's vocabulary can grow without a rules deploy — the extension ships through Chrome Web Store review on its own cadence, and making a rules deploy a prerequisite for an extension release would be a standing trap. Both are written down in `firebase-schema.md` §6.1 so a future reader doesn't "tighten" them by accident.

- **The job *create* rule is an exact key set, not a minimum.** `hasOnly` AND `hasAll` over the six fields the phone knows at tap time. Adding a field to the job doc later requires widening the rule first — deliberate friction, since the create rule is the only thing standing between "a manager's phone" and "arbitrary documents in a collection keyed on their own email".

- **Ownership alone was not enough; `isManager` is the second gate.** Because the doc key *is* the writer's canonical email, an ownership-only rule would let any signed-in user write whatever they liked to their own mailbox. Every write predicate also requires the manager claim for the doc's `stake_id`. It reads the claim only — no document read — so it costs nothing on the heartbeat path.

- **The status transitions are the lock, because no transaction is available.** The consuming side is an MV3 service worker, where `runTransaction` throws. So the compare-and-set lives in the rules: each branch pins the before-status. Two Kindoo tabs racing the same job both fire the claim; the first commits, the second is denied and skips silently. The service worker maps that one `permission-denied` to `claimed: false` rather than an error — losing a race is the correct outcome for the second tab, not a fault worth logging loudly — while every other failure still throws, so a rules regression can't masquerade as a lost race. The 90-second no-pickup timeout races the claim in the other direction and is settled by the same mechanism: the phone's `cancelled` write comes back denied, which means the desktop picked it up after all, so it is swallowed.

- **One provisioning orchestration, extracted to `content/kindoo/applyRequest.ts`.** This was the bulk of the work and the main risk. Previously the whole session → seat → envs → site-check → provision → `markRequestComplete` sequence lived inline in `panel/RequestCard.tsx`. Both the desktop button and the remote runner now call the extracted function, which returns a discriminated outcome: the card renders it into `ResultDialog`, the runner serialises it onto the job doc. A second copy would eventually have let the phone and the desktop report different results for the same request, with no way to tell which one lied. `extension/CLAUDE.md` now carries a "don't fork the provisioning flow" rule.

- **`ProvisionSiteMismatchError` now names the active site as well as the target** — "This request needs to be provisioned on 'X'. You are currently in 'Y'. Switch Kindoo sites and try again." This is the **one place the refactor changed existing desktop behaviour**, and it changed the desktop's rendered text too. The reason is on the phone: site mismatch is deliberately *not* duplicated there (the desktop is the only place that knows which Kindoo site is open), so the phone displays the desktop's sentence — and "switch sites" is unactionable on a phone unless the sentence says which site the desktop is currently sitting in.

- **The loop is hosted by `panel/TabbedShell`, not `panel/QueuePanel`.** `QueuePanel` unmounts when the operator switches to the Sync tab. A manager who left the panel on Sync would have silently stopped being reachable from their phone.

- **The phone distinguishes "wrong stake" from "not there".** A desktop can be heartbeating perfectly while sitting in another stake's Kindoo site. Telling that manager to go open Kindoo would send them chasing the wrong problem, so `other-stake` is its own presence state with its own sentence. Freshness for that state is computed by evaluating the shared `isRemoteApplyOnline` against the presence doc's *own* stake, so the staleness window stays defined in exactly one place.

- **The opt-in defaults off and fails closed**, matching the defaulting discipline D25 established for anything that grants authority. Absent means off; a `chrome.storage` read error resolves to off. Turning it off publishes the opted-out state immediately instead of just going quiet, so the button disappears at once rather than after the 150-second staleness window — and that disable write fires even when the Kindoo session is already dead, because clearing consent must never be blocked by a broken tab.

- **The runner trusts the job doc for nothing but a `request_id`.** The phone is a second device with a snapshot that may be minutes stale, so the desktop re-resolves the request through `getMyPendingRequests` and refuses if it is no longer pending. That single check also covers the double-tap case and the "someone already handled it" case.

## What didn't change that you'd expect to

- **No Cloud Function.** Both ends of the mailbox are client SDK writes gated by rules, and the work the desktop does once it claims a job runs through the two callables that already existed — `getMyPendingRequests` and `markRequestComplete`. Nothing server-side participates in the transport.
- **No composite index.** The extension's poll is `where('status','==','queued')` + `limit(1)`; the phone's active-jobs subscription is `where('status','in',['queued','running'])`. Both are single-field and served by the automatic index. Noted explicitly in `firebase-schema.md` §5.1 so the absence reads as a decision rather than an oversight.
- **No new manifest permission.** `setInterval` in the content script and Firestore writes from the service worker were both already in use. Widening `host_permissions` after the initial Web Store submission would have forced a re-review.
- **No new audit semantics.** The job doc is a transport record, not an audited entity; nothing fans an audit row for it. The audited rows are the `complete_request` and seat writes `markRequestComplete` produces — byte-identical to a desktop-initiated apply.
- **No presence on `userIndex`.** Its update rule is a strict three-key `hasOnly` allowlist the Phase 10.5 changelog already records as painful to widen, and heartbeat churn would have re-rendered the notifications page that subscribes to it.
- **No new role, and no widening of an existing one.** Remote apply changes *where* a manager can act from, never *who* may act. Everything the desktop does when it claims a job was already something that manager could do at that desktop.
- **Jobs are never deleted.** `delete: false` on both the presence doc and the jobs. At 1–2 requests/week the collection stays trivially small and the trail is useful when a provision misbehaves.
- **The extension's own queue behaviour is otherwise untouched.** Reject, the add-onto-existing-seat gate, the edit-missing-seat gate, and the requester line all behave exactly as before. `RequestCard` shed 207 lines to the extraction and gained 33, with no new behaviour beyond the site-mismatch sentence.
- **No E2E coverage.** The extension has no Playwright harness, and the feature is meaningless without one — a web-only E2E could exercise the phone half against a fabricated presence doc, but it would prove nothing about the half that matters. Covered instead by rules tests (every legal and illegal transition, the double-claim race, cross-user denial), extension unit tests (claim/skip on a lost race, outcome → job serialisation, heartbeat suppression on an unusable session), and web unit tests (the four gating states, each status rendering).

## Spec / doc edits in this PR

- `docs/architecture.md` — new **D27**: the transport decision and the alternatives, the usable-session heartbeat gate, the rules-as-lock, `partial` as terminal, the two deliberate gaps in the terminal-write rule, the exact-key-set create rule, the `isManager` second gate, the shared `applyRequest` extraction and the site-mismatch message change, and the `TabbedShell` hosting.
- `docs/firebase-schema.md` — new **§3.4** for `remoteApply/{canonicalEmail}` and its `jobs/{jobId}` subcollection (field tables, the status lifecycle, written-by / read-by, the rules summary, and why the mailbox is top-level); §5.1 the explicit no-composite-index note; §6 the two new rule blocks in the rules paste; §6.1 three notes — the transitions-as-lock discipline, the two gaps that must not be tightened, and why `isManager` joins ownership; §7 a paragraph recording that remote apply adds no Cloud Function and no audit row.
- `docs/spec.md` — §3.1 the new top-level collection; §5.3 the Requests Queue is no longer described as read-only, the note's new wording, and the presence line; new **§16** covering the desktop opt-in, the four presence states and their copy, the tap → live-status flow, the retry rules, what each failure means, the desktop-side banner and refetch, and what is explicitly not in scope.
- `extension/CLAUDE.md` — updated by the extension stream, verified against the merged code: the remote-apply architecture bullet, the `content/remoteApply/` + `lib/remoteApplyPrefs.ts` + `content/kindoo/applyRequest.ts` file-layout entries, `remoteApplyEnabled` added to the storage-key ownership rule, and the new "don't fork the provisioning flow" rule.
- `CLAUDE.md` — remote apply added to the open-follow-ups list, pending Chrome Web Store review.
- `docs/changelog/remote-apply.md` — this entry.

## Known issues / deferred work

- **Production is gated on Chrome Web Store review.** The web half ships first and is inert until a presence doc exists, so there is no ordering hazard; the extension half is unusable in production until the reviewed build lands. Staging is unpacked and testable immediately. See `infra/runbooks/extension-deploy.md`, which warns the review takes days to weeks.
- **Push wake-up for the extension is not built and is not planned.** Executing with Chrome closed is out of scope for the same reason: no Kindoo tab, no Kindoo write.
- **Remote *reject* is not built and would be much cheaper.** Rejection needs no Kindoo session at all, and `firestore.rules` already permits a manager's reject write — it could be a plain button on the phone with zero extension involvement. Flagged here because the asymmetry is surprising: the hard half shipped and the easy half didn't.
- **Presence is per Chrome profile, not per person.** A manager with two computers opts in on each. There is no surface anywhere that lists which of their desktops are online — the phone reads one presence doc, and the last heartbeat wins.
- **The App Check gap on callables is unchanged** (T-40). Remote apply drives the same two callables as the desktop button and neither widens nor narrows that gap.
