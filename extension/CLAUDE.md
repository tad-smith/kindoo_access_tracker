# extension — Claude Code guidance

Chrome MV3 extension that bridges the Stake Building Access (SBA) pending-request queue into a Kindoo Manager's Kindoo workflow. The user works inside the Kindoo admin UI (manually adding seats, granting access, etc.) and the extension's slide-over panel surfaces pending SBA requests next to them, with a "Mark Complete" button that calls back into SBA when the manager finishes the Kindoo-side work.

**Owner agent:** `extension-engineer`.

## Architecture

- **Content-script slide-over** on Kindoo pages, mounted inside a Shadow DOM so SBA styles do not leak into Kindoo (and vice versa).
- **Service worker** owns `chrome.identity` + Firebase Auth + the callable invocations + the authenticated Firestore reads / writes. The content script cannot touch those surfaces from a page context; it round-trips through the SW via `chrome.runtime.sendMessage`.
- **Auth flow:** `chrome.identity.getAuthToken` → Firebase `GoogleAuthProvider.credential(null, accessToken)` → `signInWithCredential`. The SW keeps Firebase Auth state across suspends via the SDK's IndexedDB persistence; access token + a slim principal snapshot are also persisted to `chrome.storage.local`.
- **Firestore from the SW (not the content script).** The SW reads and writes Firestore directly as the signed-in manager via the client SDK (`background/data.ts` — `getDoc` / `getDocs` / `updateDoc` / `writeBatch`), with Firestore rules gating authorisation. Request-list reads still go through the `getMyPendingRequests` callable, and `markRequestComplete` remains a callable; but config reads/writes, seat lookups, the foreign-EID auto-populate, and the request **reject** transition are direct SW-side Firestore operations. The content script never imports the Firebase SDK — it round-trips every read/write through the SW. **No `runTransaction` / `onSnapshot` in the SW:** those ride the WebChannel transport, which needs `XMLHttpRequest` — undefined in an MV3 service worker, so they throw `ReferenceError: XMLHttpRequest is not defined` at runtime. Use discrete one-shot ops (`getDoc` / `getDocs` / `updateDoc` / `setDoc` / `writeBatch`), which use the fetch-based RestConnection. Server-enforced preconditions (e.g. the reject rule's `status == 'pending'` check) replace the atomicity a transaction would have given.
- **Toolbar action** posts a `panel.togglePushedFromSw` message to the active tab; the content script flips the slide-over open / closed and persists the state in `chrome.storage.local`.
- **Remote apply** (`docs/architecture.md` D27) lets a manager tap a pending request on their phone and have this extension provision it. Opt-in per profile ("Allow requests from my phone", top of the Queue tab). While opted in, the content script heartbeats presence and polls `remoteApply/{canonicalEmail}/jobs` for `queued` work — both through SW handlers, both one-shot. Five properties are load-bearing:
  - **Everything is scoped to the one Kindoo site the tab is inside.** A manager with two tabs on two sites of one stake runs two loops at once, and the foreground one polls six times as often. So: the opt-in flag lives on `remoteApply/{canonicalEmail}` (profile-wide — it comes from `chrome.storage.local`), while liveness lives on `remoteApply/{canonicalEmail}/desktops/{siteKey}`, one doc per site. Site keys come from `remoteApplySiteKey` in `@kindoo/shared` (`'home'` for the home site, which has no `kindooSites` doc); the EID → site mapping is `content/remoteApply/site.ts`, a thin adapter over `resolveActiveKindooSite` — don't write a second EID matcher, that function carries the guards against a home session trapping HOME_EID onto a foreign doc. A tab whose EID maps to no configured site publishes nothing and claims nothing.
  - **The heartbeat is gated on a usable Kindoo session.** Absence of a fresh desktop doc is precisely how the phone learns the desktop cannot act, so never publish presence from a tab that couldn't run a job. The opt-in is re-read **synchronously** in the instant before the write (`remoteApplyEnabledSnapshot`, no `await` in between): `stop()` can't abort a tick already awaiting Kindoo, and a late `enabled: true` would overwrite the disable write. Both presence docs are written **whole, never `{ merge: true }`** — rules enforce an exact key set against the merged result, so merging onto a doc an older extension left carrying `stake_id` / `last_seen_at` would be denied.
  - **Opting out deletes this tab's desktop doc**, not just the flag. Aging it out leaves the phone naming a Kindoo site as covered for a full `REMOTE_APPLY_STALE_MS`. Safe only because the flag is profile-wide: with it off no sibling tab is serving that site either — which is also why a tab that MOVES to another site must not delete the doc it is leaving.
  - **The poll fetches a page and claims the first job it can serve.** Not `limit(1)`: the single queued job routinely belongs to the sibling tab's site, and both taking it and stalling on it are wrong. `canClaimRemoteApplyJob` (shared) is the only claim rule — skip what it rejects, log at **info** (leaving a sibling's work alone is the feature working). The claim itself is a rules-enforced `queued → running` compare-and-set, so a tab losing the race gets `permission-denied` and must skip silently.
  - **A job doc with no `target_site_key` is frozen, not unlabelled** — rules' `jobCoreUnchanged` reads the field bare, and a missing-key read errors, which denies *every* transition (claim, the phone's cancel, the terminal write). `data.ts` drops such docs from both queries and warns; never guess a site for one. Guessing buys a doomed claim per poll that `claimRemoteApplyJob` misreports as "already claimed elsewhere", and would provision against a guessed site if the freeze were lifted. **This path is unreachable in production today** and stays that way only while nothing writes `remoteApply/*/jobs` via the Admin SDK — every current writer is a client, gated by a create rule requiring a non-empty `target_site_key`. If a Cloud Function ever queues jobs server-side it bypasses rules and must stamp the field itself; coordinate with `backend-engineer` via `TASKS.md` before that lands.
  - **The terminal write is the job's only exit, so it retries** (3 attempts, 1s/4s) — except on `permission-denied`, which means the job already left `running`. Anything still `running` is swept to `failed` on loop start and every 60s, at **one of two thresholds**: `REMOTE_APPLY_STRANDED_MS` (5 min) for a job this tab could itself have run, `REMOTE_APPLY_STRANDED_OTHER_SITE_MS` (10 min) for anything else. Two thresholds, not a filter — filtering absolutely would mean a job stranded on site B is only cleaned up by a tab on site B, and the likeliest way a job strands is that the manager closed that very tab. The sweep judges by **age plus the tab's own `inFlight` set and nothing else**; `claimed_by` is not tab-unique, and a job with no readable claim time is never swept. Don't add a `claimed_by` filter or promote the site check from threshold to gate: both only prevent cleanup.
  - **Don't let both provisioning entry points run at once.** `RequestCard`'s button is disabled while this tab is remote-applying that `request_id` (`remoteApplyRunning`, threaded from `QueuePanel` via `useRemoteApply`'s `running`). Two concurrent `applyRequest` runs mean two `inviteUser` calls for a member not yet in Kindoo — a consumed licence. Reject stays enabled; it makes no Kindoo write.

## Stack

- Chrome MV3 (service worker + content script; Shadow DOM React mount)
- TypeScript strict (`tsconfig.base.json` extended)
- Vite 8 + `@crxjs/vite-plugin` for the MV3 build
- React 19 (panel UI)
- Firebase SDK (Auth + Functions) — runs in the service worker only
- Vitest + jsdom for unit tests; chrome / firebase boundary mocked

## File layout

```
extension/
├── manifest.config.ts             # MV3 manifest source (built into dist/manifest.json)
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── .env.example                   # template; copy to .env.staging / .env.production
├── public/icons/                  # toolbar / Web Store icons (placeholders in v1)
├── test/setup.ts                  # vitest jsdom setup + chrome global stub
├── src/
│   ├── manifest.config.ts         # (mirror — see top)
│   ├── background/
│   │   ├── service-worker.ts      # SW entry — wires the three subsystems below
│   │   ├── messages.ts            # chrome.runtime.onMessage dispatcher
│   │   ├── authPush.ts            # broadcast auth state to all CS tabs
│   │   └── actionToggle.ts        # toolbar click → CS toggle message
│   ├── content/
│   │   ├── content-script.ts      # CS entry — calls mountPanel
│   │   ├── mount.tsx              # Shadow-DOM + React mount + toggle wiring
│   │   ├── container.css          # slide-over chrome (Shadow DOM)
│   │   ├── remoteApply/           # Remote apply — phone-queued jobs (D27)
│   │   │   ├── loop.ts            # heartbeat + poll tick loop
│   │   │   ├── site.ts            # active EID → SBA Kindoo site key
│   │   │   ├── runner.ts          # claim → resolve → applyRequest → report
│   │   │   └── useRemoteApply.ts  # React binding, hosted by TabbedShell
│   │   └── kindoo/                # Kindoo API client (CS-side; v2.1+v2.2)
│   │       ├── auth.ts            # read SessionTokenID + EID from localStorage
│   │       ├── applyRequest.ts    # THE provisioning orchestration — shared by
│   │       │                      # RequestCard's button and the remote runner
│   │       ├── client.ts          # multipart-form POST helper
│   │       ├── endpoints.ts       # typed wrappers: getEnvironments, getEnvironmentRules,
│   │       │                      # checkUserType, inviteUser, editUser,
│   │       │                      # saveAccessRule, lookupUserByEmail, revokeUser,
│   │       │                      # listAllEnvironmentUsers (Sync, paginated)
│   │       ├── provision.ts       # v2.2 — orchestrates add/change/remove/edit flows
│   │       │                      # (read-first / merged-state pattern). The ONLY
│   │       │                      # SBA → Kindoo write path; Sync never writes Kindoo.
│   │       └── sync/              # Sync — drift detection + per-row fix dispatch
│   │           ├── parser.ts      # Kindoo Description → resolved scope+calling segments
│   │           ├── classifier.ts  # segment → intended seat shape (auto/manual/temp)
│   │           ├── detector.ts    # union(seats, kindoo users) → Discrepancy[]
│   │           ├── buildingsFromDoors.ts  # door-grant → effective rules → SBA buildings
│   │           │                  # (true auto-user reconciliation across direct
│   │           │                  #  + AccessRule grants)
│   │           └── fix.ts         # Phase 2 — per-row fix dispatcher (SBA-side callable only;
│   │                              # Kindoo-authoritative — sba-only deletes, mismatches Update SBA)
│   ├── panel/
│   │   ├── App.tsx                # React root — top-level router (stake resolution + downstream)
│   │   ├── SignedOutPanel.tsx
│   │   ├── NotAuthorizedPanel.tsx
│   │   ├── StakePicker.tsx        # full-takeover gate when an EID has >1 candidate stake (12.5)
│   │   ├── ConfigurePanel.tsx     # v2.1 first-run + reconfigure wizard
│   │   ├── TabbedShell.tsx        # Toolbar + TabBar + active tab; HOSTS the remote-apply
│   │   │                          # loop, so it survives a tab switch (D27)
│   │   ├── Toolbar.tsx            # gray header — signed-in email + Sign out
│   │   ├── TabBar.tsx             # Request Queue / Sync / gear tab strip
│   │   ├── QueuePanel.tsx         # queue sections + the remote-apply opt-in row
│   │   ├── RequestCard.tsx        # v2.2 Provision & Complete button
│   │   ├── RejectDialog.tsx       # per-card reject + required reason
│   │   ├── ResultDialog.tsx       # v2.2 post-provision result + retry
│   │   ├── SyncPanel.tsx          # Sync — drift report + per-row Fix actions (Phase 2)
│   │   └── panel.css              # panel styles (Shadow DOM scoped)
│   └── lib/
│       ├── firebase.ts            # Firebase app + auth + functions singletons (SW)
│       ├── auth.ts                # chrome.identity → Firebase credential exchange (SW)
│       ├── api.ts                 # callable client wrappers (SW)
│       ├── messaging.ts           # shared SW <-> CS wire protocol
│       ├── remoteApplyPrefs.ts    # owner of the remote-apply opt-in storage key
│       └── extensionApi.ts        # CS-side wrappers over chrome.runtime.sendMessage
└── CLAUDE.md
```

## Conventions

- **Service worker stays stateless.** MV3 SWs spin up on demand and suspend after idle; never hold mutable in-memory state. Firebase Auth re-hydrates from IndexedDB on revive (`waitForAuthHydrated()` gates the first `auth.getState` response). Other state persists via `chrome.storage`.
- **All cross-context messaging via `chrome.runtime.sendMessage`** (typed via the protocol in `lib/messaging.ts`). The panel never reaches into the SW directly; the SW never DOM-touches the page.
- **Firebase Auth client is separate from SBA's.** Same project (`kindoo-prod` / `kindoo-staging` per build mode), distinct Auth client instance running in the SW.
- **SBA surface is split: callables + direct SW-side Firestore.** The pending-request list (`getMyPendingRequests`) and request completion (`markRequestComplete`) are callables; the callable response is the source of truth for the request data. Everything else the panel needs — stake/building/ward config, seat lookups, the foreign-EID auto-populate, and the request **reject** write — is a direct Firestore read/write performed in the SW (`background/data.ts`) as the signed-in manager, gated by Firestore rules. New SW-side Firestore ops are fine when rules already cover the path; reach for a callable only when server-side logic (Admin SDK, cross-doc invariants, fan-out) is required.
- **Shadow DOM for the panel.** CSS variables on `.sba-slideover-root` (not `:host` / `:root` — those do not apply inside the shadow root the way you would expect). `html`, `body` selectors will silently no-op.
- **Tailwind / shadcn are NOT used.** Vanilla CSS, scoped inside the Shadow DOM. If we ever want them, add the Tailwind config locally and ensure the build inlines into the shadow root.
- **Tests colocated** under `src/`. Pure logic (callable wrappers, message handlers, auth-flow steps) is unit-tested with vitest. Chrome APIs are mocked at the wrapper level.
- **All console logging is prefixed `[sba-ext]`** so the user can grep extension logs in Chrome's DevTools.
- **Build per-env via Vite mode:** `--mode staging` loads `.env.staging`; default loads `.env.production`. Same pattern as `apps/web/`.

## Don't

- **Don't touch Firestore from the content script.** The Firebase SDK runs only in the SW. The panel round-trips every read/write through `lib/extensionApi.ts` → `chrome.runtime.sendMessage` → the SW handlers in `background/data.ts`. Direct SW-side Firestore is allowed (and is how config, seat lookups, and the reject write work); page-context Firestore access is not.
- **Don't reach into Kindoo's DOM** (one sanctioned exception, below). The slide-over is a self-contained panel; it does not read or modify Kindoo page state. Kindoo writes (v2.2 Provision & Complete) go through the typed wrappers in `content/kindoo/endpoints.ts`, never via DOM scraping. See `extension/docs/v2-design.md`.

  **Exception — `readActiveEidFromDom` in `content/kindoo/auth.ts`.** Active-site identification is the one place we scrape Kindoo's DOM. The active Kindoo site (EID) is not in `localStorage` (`state.sites.ids[0]` is the access-list head, not the active site; `user.object.EnvironmentID` is always `null`), not in the URL, and not on any DOM data attribute — Kindoo tracks it only in React in-memory state. The visible header text rendered as `[dir="auto"]` is the only observable signal, and we match it against `state.sites.entities[<eid>].EnvironmentName` to recover the active EID. Single visible match → the active EID; zero or multiple matches → `null` (`readKindooSession` collapses to `{ ok: false, error: 'no-eid' }`). This is brittle by construction — a Kindoo redesign that drops `[dir="auto"]` or changes the header markup will break detection. All other DOM access stays prohibited.
- **Don't read Kindoo's `localStorage` outside the documented `kindoo/auth.ts` helper.** The keys are documented in the Kindoo runtime state section; readers route through that helper so we have one place to handle missing/expired state.
- **Don't bundle production credentials.** Firebase web SDK config is public; the Google OAuth client ID is public-by-design; nothing else ships in the bundle.
- **Don't depend on `apps/web/` code.** Share types via `@kindoo/shared`. The extension is its own consumer.
- **Don't touch the Chrome storage keys** declared in `lib/messaging.ts` `STORAGE_KEYS` from outside their owning module. Each key has a single owner: `googleAccessToken` + `principalSnapshot` belong to the SW (`lib/auth.ts`), `panelOpen` belongs to the CS mount (`content/mount.tsx`), `eidStakeChoice` belongs to `lib/extensionApi.ts`'s `readEidStakeChoice` / `writeEidStakeChoice` / `clearEidStakeChoice` helpers, and `remoteApplyEnabled` belongs to `lib/remoteApplyPrefs.ts`. If you need a new key, give it one owner module and route every other reader / writer through that owner.
- **Don't fork the provisioning flow.** `content/kindoo/applyRequest.ts` is the only path from a pending request to a Kindoo write plus `markRequestComplete`. Both the panel's button (`panel/RequestCard.tsx`) and the phone-initiated runner (`content/remoteApply/runner.ts`) call it. A second copy would let the two surfaces report different results for the same request, with no way to tell which one was right.

## Kindoo runtime state — reference

Kindoo stores everything in `localStorage` on `web.kindoo.tech`. `sessionStorage` is empty. v2.1 reads these to call the Kindoo API; v2.2 builds on the same session to drive provision writes.

- **`SessionTokenID`** — `localStorage.kindoo_token`. UUID string (e.g. `5e94a57a-3f08-4681-a01a-...`). The bearer token Kindoo's admin UI uses to authenticate against the ASMX API on `service89.kindoo.tech`.
- **`EID`** (environment / site id) — recovered by **DOM scrape**, not `localStorage`. Kindoo tracks the active site only in React in-memory state — `localStorage.state.sites.ids[0]` is the access-list head (not the active site), `user.object.EnvironmentID` is always `null`, the URL carries no site discriminator. `readActiveEidFromDom` (in `content/kindoo/auth.ts`) matches the visible site name rendered as `[dir="auto"]` against `state.sites.entities[<eid>].EnvironmentName` to recover the active EID. `localStorage.state` provides the name → EID lookup table; the DOM provides the active-site selection signal. Operator must be inside a specific Kindoo site (not the "My Sites" listing page, which renders multiple names at once and resolves ambiguous → `no-eid`).

All reads route through `content/kindoo/auth.ts`. Do not access these keys from anywhere else — one place to handle missing / expired state.

## Boundaries

- **New callable needed** → coordinate with `backend-engineer`; the callable lands in `functions/src/callable/`.
- **Shared type / schema** → edit `packages/shared/`; coordinate via `TASKS.md`.
- **Chrome API surface changes** (new permission, new host_permissions entry) → update `manifest.config.ts` and document the why in the commit. Every entry is a Chrome Web Store review surface; widening `host_permissions` after the initial submission forces a re-review.

## Per-env setup

Staging and production builds coexist in the same Chrome profile. Each env has its own RSA keypair (so each pins a stable extension ID), its own GCP "Chrome extension" OAuth client (bound to that extension ID), and distinguishable visual identity (different `name`, orange-tinted icons for staging).

**Two extension IDs are in play.** The deterministic ID derived from the manifest `key` (via `pnpm --filter @kindoo/extension ext-id`) is what staging and prod-mode local unpacked loads use. The published production build strips the `key` (`VITE_OMIT_KEY=true`) and Chrome assigns its own ID at first Web Store upload — those two IDs are not the same string. Each ID needs its own GCP OAuth client. Runbook covers the post-first-upload OAuth client registration; runtime code shouldn't care which ID is live (`chrome.identity` resolves it from the running extension).

**Operator walkthrough lives in `infra/runbooks/extension-deploy.md`.** It covers keypair generation, OAuth client registration, the `.env.<mode>` template (including which `VITE_FIREBASE_*` values to copy from `apps/web/.env.<mode>`), and the per-build loop. Read that runbook end-to-end before the first build in a new env.

Subsequent builds for the same env reuse the existing `.env.<mode>` — only re-run the keypair / GCP / Chrome dance if you rotate the keypair (which invalidates the extension ID — you'd need a new GCP OAuth client) or rotate the OAuth client itself.

**Staging icon generation.** The orange-tinted staging icons under `public/icons/icon-{16,48,128}-staging.png` are generated by `pnpm --filter @kindoo/extension icons:tint` from the canonical prod icons. One-shot generator; re-run only when the prod icons change, and check the regenerated PNGs in.

## Tests

- **Unit:** pure functions in `src/lib/` + `src/background/` + `src/content/` (callable wrappers, auth-flow steps, message handlers, Shadow-DOM mount). Mock the Chrome / Firebase boundary.
- **Component:** `src/panel/App.test.tsx` exercises the four-state router with mocked extensionApi hooks.
- **No E2E yet.** Playwright MV3 extension testing is doable but invasive; deferred until v2.

## Deploy

Operator walkthrough lives in `infra/runbooks/extension-deploy.md`. Summary: per-env builds via `pnpm --filter @kindoo/extension build [--mode staging]`; output in `extension/dist/<mode>/`. Staging is loaded unpacked from `dist/staging/`. Production ships via Chrome Web Store (Unlisted in v1) — operator runs `./bin/build_extension_for_chrome_store.sh` from the repo root, which produces `extension/dist/sba-<version>.zip` with the manifest `key` stripped (`VITE_OMIT_KEY=true`), then uploads to the developer dashboard. The operator owns the Web Store listing content + the OAuth consent screen in each GCP project.

Before any callable-driven path works in a freshly-deployed env, the two callables (`getMyPendingRequests`, `markRequestComplete`) must already be deployed to that env. The browser surfaces a missing callable as a CORS error; runbook §Troubleshooting captures the symptom and fix.
