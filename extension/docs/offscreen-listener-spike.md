# Spike — can an offscreen document hold the remote-apply listener?

Branch `spike/offscreen-listener`. **Not production code.** Nothing here is wired into the
remote-apply flow: the listener logs and messages the service worker, and the existing poll loop
runs untouched alongside it.

## Why

Remote apply polls: two Firestore reads per tick at 10s foreground / 60s background, plus a 60s
sweep read. That is ~18,700 reads/day **per open Kindoo tab**, and it scales with tabs and with
wall-clock time rather than with request volume. Two tabs open around the clock is ~37,400/day —
75% of the 50,000/day free tier before a second manager opts in.

A realtime listener bills the initial result set plus one read per changed document. The jobs
collection is empty almost always, so this takes the dominant cost to roughly zero.

The service worker cannot host it. `onSnapshot` rides WebChannel, which needs `XMLHttpRequest` —
undefined in an MV3 service worker (already recorded in `extension/CLAUDE.md`) — and an MV3 SW is
suspended after ~30s idle, which a quiet listener is. An offscreen document has a full DOM and, per
Chrome's docs, no automatic lifetime limit for any reason except `AUDIO_PLAYBACK`.

## Question 1 — does Firebase Auth rehydrate across the SW → offscreen boundary?

**Static evidence says yes.** From `@firebase/auth@1.13.0`:

| Context                                   | `getAuth()` persistence                                                |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| SW (`firebase/auth/web-extension`)        | `[indexedDBLocalPersistence]`                                          |
| Offscreen document (`firebase/auth`)      | `[indexedDBLocalPersistence, browserLocalPersistence, browserSession…]` |

The record key is `_persistenceKeyName('authUser', apiKey, appName)` → `firebase:authUser:<apiKey>:[DEFAULT]`
in both builds. Same `apiKey` (one `.env.<mode>`), same app name, and both contexts are the same
origin (`chrome-extension://<id>`), so they address the same IndexedDB record.
`PersistenceUserManager.create` additionally searches **every** persistence in the chain, not just
the first, so the document's chain is a strict superset of what the SW wrote.

The spike implements rehydration as the primary path and the token relay as the fallback, and
**logs which one ran** — so the operator's run converts the static argument into a measurement. The
three outcomes are kept distinct on purpose:

- `auth.rehydrated` — a user arrived on the first `onAuthStateChanged`. Rehydration works.
- `auth.noSessionAnywhere` — no user here **and** no principal snapshot in `chrome.storage.local`.
  Nobody is signed in anywhere; this run says nothing either way. Sign in via the panel and watch.
- `auth.notRehydrated` — no user here **but** the SW does hold a principal snapshot. That is the
  real negative, and it is what triggers the token relay.

Collapsing the last two would let a signed-out profile masquerade as a negative result.

### If the relay ever is the real path

`tokenRelaySignIn` reads `STORAGE_KEYS.googleAccessToken` straight out of `chrome.storage.local`.
That is a knowing violation of the one-owner-per-key rule in `extension/CLAUDE.md` (`lib/auth.ts`
owns that key) and is spike-only. It also carries the expiry problem the brief anticipated: the
token was minted when the operator signed in and Google access tokens last about an hour, so on any
profile that has been up a while the relay is *expected* to fail with `auth.tokenRelayFailed`. A
production relay would have to mint a fresh token rather than replay a cached one.

### One nuance worth knowing

`getAuth()` from the browser build attaches `browserPopupRedirectResolver`, which can eagerly load
a cross-origin auth iframe. It only does so when `_shouldInitProactively` is true, which is mobile
and Safari — not desktop Chrome. So no iframe, no CSP surprise. If that ever changes, swap
`getAuth(app)` for `initializeAuth(app, { persistence: [indexedDBLocalPersistence] })`, which pins
the document to exactly the persistence the SW uses and skips the resolver entirely.

## Question 2 — does it actually survive?

**Not yet answered. This spike is the instrument, not the result.** Chrome's docs say only
`AUDIO_PLAYBACK` sets a lifetime limit, but that is a claim about the API, not proof the browser
will not reap the document under memory pressure, on idle, or across an update. That has to be
measured over hours.

What the instrument gives you:

- `document.booted` on every boot, carrying **the gap since the previous logged event**. This is the
  load-bearing line. A dying document cannot finish an async storage write on its way out, so the
  gap on the *next* boot is the only durable evidence of a reap. There is a `document.pagehide`
  handler too, but treat it as a bonus, not a guarantee.
- `heartbeat` every two minutes with uptime, listener state, snapshot count, time since the last
  snapshot, the current uid, `navigator.onLine`, and `document.visibilityState`. Everything on that
  line is something that could plausibly explain a silent listener, so one heartbeat distinguishes
  "alive and idle" from "alive but broken".
- `listener.snapshot` with doc count, **`fromCache`**, `hasPendingWrites`, the doc-change list, and
  the job ids. `includeMetadataChanges: true` is on: without it, a listener that never actually
  reached Firestore looks identical to a healthy quiet one, and "quiet" is precisely the state we
  are trying to prove is real.
- `listener.error` / `listener.reattachScheduled` / `listener.detached` on every teardown, with
  capped backoff (5s → 15s → 60s → 300s). Capped rather than give-up: a listener that stopped
  retrying after a long outage would answer this question with a false negative.
- `offscreen.created` / `offscreen.createFailed` from the SW side.

### Reading the log

The console is not enough — the operator leaves this running with no devtools attached, and a
console that was never open has no history. Every event is also appended to a
`chrome.storage.local` ring buffer (`sba.spike.offscreenLog`, 1000 entries ≈ 33 hours at the
2-minute heartbeat).

Dump it from **any** extension console (service worker, offscreen document, or the panel):

```js
(await chrome.storage.local.get('sba.spike.offscreenLog'))['sba.spike.offscreenLog'].forEach((e) =>
  console.log(e.at, e.ctx, e.kind, JSON.stringify(e.detail ?? {})),
);
```

Clear it between runs with `chrome.storage.local.remove('sba.spike.offscreenLog')`.

The offscreen document's own console is at `chrome://extensions` → the extension → **Inspect views:
offscreen.html**. That link's presence or absence is itself a live liveness check.

### What to watch over a longer run

- **A `document.booted` with a large `gapSincePreviousEvent`.** That is a reap. Note what else
  happened around it: memory pressure, a Chrome update, the machine sleeping.
- **Heartbeats that stop and resume without a boot in between.** That is timer throttling, not
  death. The interval is deliberately above Chrome's one-minute intensive-throttling floor for
  hidden pages, but sleep/resume can still stretch it.
- **`fromCache: true` that never flips to `false`.** The listener attached but never reached
  Firestore. The lever is `initializeFirestore(app, { experimentalAutoDetectLongPolling: true })`
  or `experimentalForceLongPolling: true` — extension contexts have historically needed one of them.
- **Machine sleep and network drops.** Does the listener reconnect on its own, or does it need the
  backoff? `listener.error` followed by a `listener.snapshot` with `fromCache: false` is a clean
  recovery.
- **Snapshot count growth while nothing is happening.** Each snapshot is billed reads. A listener
  that re-delivers on a timer would undermine the whole cost argument.
- **Whether the SW gets recreated when nothing wakes it.** See the gap below.

## The `reasons` enum — the Web Store risk

None of Chrome's fifteen `Reason` values means "hold a long-lived authenticated network listener."
The ranking of the near misses, honestly:

| Value           | Documented meaning                          | Fit                                                                                                                                     |
| --------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `LOCAL_STORAGE` | "needs access to localStorage"              | **Chosen.** Closest. Auth's document-context chain really does include localStorage, and the underlying need — DOM-backed storage the SW lacks — is genuinely ours. Still not why we are here. |
| `TESTING`       | "used for testing purposes only"            | The honest label for a spike, but unshippable — and evidence gathered under a reason we could never declare in production transfers less well. |
| `DOM_SCRAPING`  | "embed an iframe and scrape its DOM"        | Flatly untrue for us. But it is what **Firebase's own Chrome-extension auth guide** tells you to use, with the justification string `'authentication'`. |
| `WORKERS`       | "needs to spawn workers"                    | Untrue.                                                                                                                                  |

The justification string is the half that can be truthful and the half a human reviewer actually
reads, so it says what is really going on:

> Holds the authenticated Firestore realtime listener that watches for access-provisioning jobs.
> Firestore listeners need DOM-backed storage and XMLHttpRequest, neither of which exists in an MV3
> service worker.

That Google's own Firebase documentation ships a demonstrably inaccurate `reasons` value is the
most useful precedent here: it suggests reviewers are not matching the enum against actual
behaviour, and that the field is treated as a declaration rather than an assertion. It is not a
guarantee. This is the single largest unknown in taking the approach to production, and it is a
policy question rather than a technical one — worth resolving before building on it, because the
`offscreen` permission also adds a new review surface to a currently minimal permission set.

## Build wiring — what it needed

Less than feared, but not nothing.

- `offscreen.html` lives at the **extension root** and is declared as an extra Rollup HTML input in
  `vite.config.ts`. @crxjs never discovers it on its own, because offscreen documents are created at
  runtime by `chrome.offscreen.createDocument` and so never appear in the manifest for the plugin to
  crawl.
- The input must be an **object**, not a string. @crxjs's `crx:stub-input` plugin swaps a bare
  `index.html` string input for its own stub; object inputs pass through untouched.
- Chunking came out right without intervention, which was the real risk. The offscreen document
  imports the browser `firebase/auth` build while the SW imports `firebase/auth/web-extension`, and
  the browser build touches `document` at module init — landing it in a chunk the SW loads would
  fatally error the service worker, exactly the class of failure the entry-filename comment in
  `manifest.config.ts` already records. Verified in `dist/staging`: `__/auth/iframe` and
  `sessionStorage` (browser-build-only markers) appear **only** in `assets/offscreen-*.js`. The
  265 kB shared chunk is Firestore plus `firebase/app`, auth-free. Total SW payload is ~427 kB
  against a ~423 kB baseline — the SW's firebase code moved into the shared chunk rather than being
  duplicated.
- `permissions: ['offscreen']` added to `manifest.config.ts`, flagged as spike-only.
- Manifest version deliberately left at `1.1.1`. This is not a release.

## What a production version would need that this does not have

1. **The sweep still matters, and a listener says nothing about it.** A listener answers "is there a
   job right now"; it cannot answer "did a job go stale while nothing was listening." Everything in
   `content/remoteApply/loop.ts` that runs on a clock rather than on an event survives the move:
   the `running` stranded sweep at its two thresholds, the `queued` pickup-timeout expiry, and the
   presence heartbeat. A listener replaces the poll's *read volume*, not its *timers*.
2. **A liveness gap when no Kindoo tab is open.** The SW is the only context that can create an
   offscreen document, and it has no loop of its own. With a Kindoo tab open the existing poll wakes
   it every 10–60s, so a reaped document comes back within about a minute. With no tab open, nothing
   wakes the SW and nothing notices the document died. `chrome.alarms` (another permission, minimum
   period 30s) is the usual answer.
3. **Who owns the answer.** The listener lives in a third context. Today the content script drives
   provisioning and the SW brokers Firestore. A production design has to decide whether the offscreen
   document just *notifies* (and the CS keeps claiming through the SW, as it does now) or whether it
   becomes the claimer — which would move the site-scoping and multi-tab logic that
   `extension/CLAUDE.md` documents at length. One offscreen document per extension means two Kindoo
   tabs share one listener, and the existing design deliberately gives each tab its own loop scoped
   to the site it is inside. **This is the hard design question, not the plumbing.**
4. **Auth lifecycle.** The spike attaches on sign-in and detaches on sign-out. It does not handle
   token refresh failures, a revoked manager role mid-listen (the listener would just start erroring
   with `permission-denied`), or a stake change.
5. **Cost accounting that survives reconnects.** Each re-attach re-bills the initial result set. At
   an empty collection that is ~1 read, but a listener that flaps on a bad network is not free, and
   the spike's `listener.error` count is what tells you whether that is theoretical.
6. **Storage-key ownership and the log itself.** The ring buffer, the direct
   `STORAGE_KEYS.googleAccessToken` read, and the duplicated `firebaseConfig` in
   `src/offscreen/main.ts` are all spike shortcuts. The config duplication in particular wants a
   shared module rather than a copy.

## Files

| Path                                        | What                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `extension/offscreen.html`                  | Host page. Vite HTML entry.                                          |
| `extension/src/offscreen/main.ts`           | Auth probe, listener, heartbeat.                                     |
| `extension/src/background/offscreenSpike.ts`| SW half: create the document, log snapshot pushes.                   |
| `extension/src/lib/spike.ts`                | Shared constants, the `reasons` decision, the logger + ring buffer.  |

## Test coverage

`src/background/offscreenSpike.test.ts` covers the one piece with real branching: the create/skip
decision, scoping the `getContexts` probe, treating a lost create race as success rather than
failure, clearing the in-flight guard after a failure, and — the one that would bite silently — that
the spike's message listener never answers a message it does not own, since
`background/messages.ts` already answers everything carrying a string `type` and two listeners
racing to respond means the faster one wins.

`src/offscreen/main.ts` is **not** tested. It is wiring against a live Auth session and a live
Firestore listener; a mocked version would assert the mock rather than the behaviour the spike
exists to measure.
