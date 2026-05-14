# extension — Claude Code guidance

Chrome MV3 extension that bridges the Stake Building Access (SBA) pending-request queue into a Kindoo Manager's Kindoo workflow. The user works inside the Kindoo admin UI (manually adding seats, granting access, etc.) and the extension's slide-over panel surfaces pending SBA requests next to them, with a "Mark Complete" button that calls back into SBA when the manager finishes the Kindoo-side work.

**Owner agent:** `extension-engineer`.

## Architecture

- **Content-script slide-over** on Kindoo pages, mounted inside a Shadow DOM so SBA styles do not leak into Kindoo (and vice versa).
- **Service worker** owns `chrome.identity` + Firebase Auth + the callable invocations. The content script cannot touch those surfaces from a page context; it round-trips through the SW via `chrome.runtime.sendMessage`.
- **Auth flow:** `chrome.identity.getAuthToken` → Firebase `GoogleAuthProvider.credential(null, accessToken)` → `signInWithCredential`. The SW keeps Firebase Auth state across suspends via the SDK's IndexedDB persistence; access token + a slim principal snapshot are also persisted to `chrome.storage.local`.
- **No Firestore from the extension.** All SBA data goes through the two callables (`getMyPendingRequests`, `markRequestComplete`).
- **Toolbar action** posts a `panel.togglePushedFromSw` message to the active tab; the content script flips the slide-over open / closed and persists the state in `chrome.storage.local`.

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
│   │   └── kindoo/                # Kindoo API client (CS-side; v2.1+v2.2)
│   │       ├── auth.ts            # read SessionTokenID + EID from localStorage
│   │       ├── client.ts          # multipart-form POST helper
│   │       ├── endpoints.ts       # typed wrappers: getEnvironments, getEnvironmentRules,
│   │       │                      # checkUserType, inviteUser, editUser,
│   │       │                      # saveAccessRule, lookupUserByEmail, revokeUser,
│   │       │                      # listAllEnvironmentUsers (Sync, paginated)
│   │       ├── provision.ts       # v2.2 — orchestrates add/change/remove flows
│   │       │                      # (read-first / merged-state pattern)
│   │       ├── sync-provision.ts  # Sync Phase 2 — drives Kindoo to a single Seat
│   │       │                      # (sba-only + *-mismatch "Update Kindoo")
│   │       └── sync/              # Sync — drift detection + per-row fix dispatch
│   │           ├── parser.ts      # Kindoo Description → resolved scope+calling segments
│   │           ├── classifier.ts  # segment → intended seat shape (auto/manual/temp)
│   │           ├── detector.ts    # union(seats, kindoo users) → Discrepancy[]
│   │           └── fix.ts         # Phase 2 — per-row fix dispatcher (callable | orchestrator)
│   ├── panel/
│   │   ├── App.tsx                # React root — five-state router
│   │   ├── SignedOutPanel.tsx
│   │   ├── NotAuthorizedPanel.tsx
│   │   ├── ConfigurePanel.tsx     # v2.1 first-run + reconfigure wizard
│   │   ├── QueuePanel.tsx
│   │   ├── RequestCard.tsx        # v2.2 Provision & Complete button
│   │   ├── ResultDialog.tsx       # v2.2 post-provision result + retry
│   │   ├── SyncPanel.tsx          # Sync — drift report + per-row Fix actions (Phase 2)
│   │   └── panel.css              # panel styles (Shadow DOM scoped)
│   └── lib/
│       ├── firebase.ts            # Firebase app + auth + functions singletons (SW)
│       ├── auth.ts                # chrome.identity → Firebase credential exchange (SW)
│       ├── api.ts                 # callable client wrappers (SW)
│       ├── messaging.ts           # shared SW <-> CS wire protocol
│       ├── extensionApi.ts        # CS-side wrappers over chrome.runtime.sendMessage
│       └── constants.ts           # STAKE_ID
└── CLAUDE.md
```

## Conventions

- **Service worker stays stateless.** MV3 SWs spin up on demand and suspend after idle; never hold mutable in-memory state. Firebase Auth re-hydrates from IndexedDB on revive (`waitForAuthHydrated()` gates the first `auth.getState` response). Other state persists via `chrome.storage`.
- **All cross-context messaging via `chrome.runtime.sendMessage`** (typed via the protocol in `lib/messaging.ts`). The panel never reaches into the SW directly; the SW never DOM-touches the page.
- **Firebase Auth client is separate from SBA's.** Same project (`kindoo-prod` / `kindoo-staging` per build mode), distinct Auth client instance running in the SW.
- **Callables are the only SBA surface.** No direct Firestore reads. Source of truth for the request data is the callable response.
- **Shadow DOM for the panel.** CSS variables on `.sba-slideover-root` (not `:host` / `:root` — those do not apply inside the shadow root the way you would expect). `html`, `body` selectors will silently no-op.
- **Tailwind / shadcn are NOT used.** Vanilla CSS, scoped inside the Shadow DOM. If we ever want them, add the Tailwind config locally and ensure the build inlines into the shadow root.
- **Tests colocated** under `src/`. Pure logic (callable wrappers, message handlers, auth-flow steps) is unit-tested with vitest. Chrome APIs are mocked at the wrapper level.
- **All console logging is prefixed `[sba-ext]`** so the user can grep extension logs in Chrome's DevTools.
- **Build per-env via Vite mode:** `--mode staging` loads `.env.staging`; default loads `.env.production`. Same pattern as `apps/web/`.

## Don't

- **Don't talk directly to Firestore from the extension.** Go through the callables.
- **Don't reach into Kindoo's DOM.** The slide-over is a self-contained panel; it does not read or modify Kindoo page state. Kindoo writes (v2.2 Provision & Complete) go through the typed wrappers in `content/kindoo/endpoints.ts`, never via DOM scraping. See `extension/docs/v2-design.md`.
- **Don't read Kindoo's `localStorage` outside the documented `kindoo/auth.ts` helper.** The keys are documented in the Kindoo runtime state section; readers route through that helper so we have one place to handle missing/expired state.
- **Don't bundle production credentials.** Firebase web SDK config is public; the Google OAuth client ID is public-by-design; nothing else ships in the bundle.
- **Don't depend on `apps/web/` code.** Share types via `@kindoo/shared`. The extension is its own consumer.
- **Don't touch the Chrome storage keys** declared in `lib/messaging.ts` `STORAGE_KEYS` from outside the SW + the content-script mount file — they are owned by those two surfaces. If you need to read them from a new place, route through a message.

## Kindoo runtime state — reference

Kindoo stores everything in `localStorage` on `web.kindoo.tech`. `sessionStorage` is empty. v2.1 reads these to call the Kindoo API; v2.2 builds on the same session to drive provision writes.

- **`SessionTokenID`** — `localStorage.kindoo_token`. UUID string (e.g. `5e94a57a-3f08-4681-a01a-...`). The bearer token Kindoo's admin UI uses to authenticate against the ASMX API on `service89.kindoo.tech`.
- **`EID`** (environment / site id) — `localStorage.state`. A JSON blob with the shape:
  ```json
  { "sites": { "ids": [27994], "entities": { "27994": { ... } } }, ... }
  ```
  The first id is the active site; `EID = JSON.parse(localStorage.state).sites.ids[0]`.

All reads route through `content/kindoo/auth.ts`. Do not access these keys from anywhere else — one place to handle missing / expired state.

## Boundaries

- **New callable needed** → coordinate with `backend-engineer`; the callable lands in `functions/src/callable/`.
- **Shared type / schema** → edit `packages/shared/`; coordinate via `TASKS.md`.
- **Chrome API surface changes** (new permission, new host_permissions entry) → update `manifest.config.ts` and document the why in the commit. Every entry is a Chrome Web Store review surface; widening `host_permissions` after the initial submission forces a re-review.

## Per-env setup

Staging and production builds coexist in the same Chrome profile. Each env has its own RSA keypair (so each pins a stable extension ID), its own GCP "Chrome extension" OAuth client (bound to that extension ID), and distinguishable visual identity (different `name`, orange-tinted icons for staging).

**Operator walkthrough lives in `infra/runbooks/extension-deploy.md`.** It covers keypair generation, OAuth client registration, the `.env.<mode>` template (including which `VITE_FIREBASE_*` values to copy from `apps/web/.env.<mode>`), and the per-build loop. Read that runbook end-to-end before the first build in a new env.

Subsequent builds for the same env reuse the existing `.env.<mode>` — only re-run the keypair / GCP / Chrome dance if you rotate the keypair (which invalidates the extension ID — you'd need a new GCP OAuth client) or rotate the OAuth client itself.

**Staging icon generation.** The orange-tinted staging icons under `public/icons/icon-{16,48,128}-staging.png` are generated by `pnpm --filter @kindoo/extension icons:tint` from the canonical prod icons. One-shot generator; re-run only when the prod icons change, and check the regenerated PNGs in.

## Tests

- **Unit:** pure functions in `src/lib/` + `src/background/` + `src/content/` (callable wrappers, auth-flow steps, message handlers, Shadow-DOM mount). Mock the Chrome / Firebase boundary.
- **Component:** `src/panel/App.test.tsx` exercises the four-state router with mocked extensionApi hooks.
- **No E2E yet.** Playwright MV3 extension testing is doable but invasive; deferred until v2.

## Deploy

Operator walkthrough lives in `infra/runbooks/extension-deploy.md`. Summary: per-env builds via `pnpm --filter @kindoo/extension build [--mode staging]`; output in `extension/dist/<mode>/`. Staging is loaded unpacked from `dist/staging/`. Production ships via Chrome Web Store (Unlisted in v1) — zip the contents of `dist/production/`, upload to the developer dashboard, submit for review. The operator owns the Web Store listing content + the OAuth consent screen in each GCP project.

Before any callable-driven path works in a freshly-deployed env, the two callables (`getMyPendingRequests`, `markRequestComplete`) must already be deployed to that env. The browser surfaces a missing callable as a CORS error; runbook §Troubleshooting captures the symptom and fix.
