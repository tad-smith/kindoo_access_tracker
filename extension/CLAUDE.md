# extension — Claude Code guidance

Chrome MV3 extension that bridges the Stake Building Access (SBA) pending-request queue into a Kindoo Manager's Kindoo workflow. The user works inside the Kindoo admin UI (manually adding seats, granting access, etc.) and the extension's side panel surfaces pending SBA requests next to them, with a "Mark Complete" button that calls back into SBA when the manager finishes the Kindoo-side work.

**Owner agent:** `extension-engineer`.

## Stack

- Chrome MV3 (service worker + side panel; no content scripts in v1)
- TypeScript strict (`tsconfig.base.json` extended)
- Vite 8 + `@crxjs/vite-plugin` for the MV3 build
- React 19 (side panel UI)
- Firebase SDK (Auth + Functions) — extension is a Firebase Auth client of its own
- `chrome.identity.getAuthToken` for Google sign-in
- Vitest for unit tests

## File layout

```
extension/
├── manifest.config.ts             # MV3 manifest source (built into dist/manifest.json)
├── package.json
├── tsconfig.json
├── vite.config.ts
├── .env.example                   # template; copy to .env.staging / .env.production
├── src/
│   ├── background/
│   │   └── index.ts               # service worker — action click opens side panel
│   ├── sidepanel/
│   │   ├── index.html             # side panel entry (loaded via chrome.sidePanel)
│   │   └── main.tsx               # React root
│   └── lib/
│       ├── firebase.ts            # Firebase app + auth + functions singletons
│       ├── auth.ts                # chrome.identity → Firebase credential exchange
│       └── api.ts                 # callable client wrappers (getMyPendingRequests, markRequestComplete)
└── CLAUDE.md
```

## Conventions

- **Service worker stays stateless.** MV3 SWs spin up on demand and suspend after idle; never hold mutable in-memory state. Persist via `chrome.storage`.
- **All cross-context messaging via `chrome.runtime.sendMessage`** or `chrome.runtime.connect`. Don't reach into the side-panel from the SW directly.
- **Firebase Auth client is separate from SBA's.** Same project (`kindoo-prod` / `kindoo-staging` per build mode), distinct Auth client instance.
- **Callables are the only SBA surface.** No direct Firestore reads from the extension. Source of truth for the request data is the callable response.
- **Tailwind / shadcn are NOT used** in the side panel (out of scope for v1; keep CSS minimal). If we ever want them, add the Tailwind config locally.
- **Tests colocated** under `src/`. Pure logic (callable wrappers, message handlers) is unit-tested with vitest. Chrome APIs are mocked at the wrapper level.

## Don't

- **Don't add content scripts** unless we need to read or modify the Kindoo page DOM. v1 is side-panel only.
- **Don't talk directly to Firestore from the extension.** Go through the callables.
- **Don't bundle production credentials.** Firebase web SDK config is public; the Google OAuth client ID is public-by-design; nothing else ships in the bundle.
- **Don't depend on `apps/web/` code.** Share types via `@kindoo/shared`. The extension is its own consumer.

## Boundaries

- **New callable needed** → coordinate with `backend-engineer`; the callable lands in `functions/src/callable/`.
- **Shared type / schema** → edit `packages/shared/`; coordinate via `TASKS.md`.
- **Chrome API surface changes** (new permission, new host_permissions entry) → update `manifest.config.ts` and document the why in the commit. Be conservative — every permission is a Chrome Web Store review surface.

## Tests

- **Unit:** pure functions in `src/lib/` (callable wrappers, auth flow steps, message handlers). Mock the Chrome / Firebase boundary.
- **No E2E yet.** Playwright MV3 extension testing is doable but invasive; deferred until v2.

## Deploy

- Build artifact lands in `extension/dist/`.
- Manual distribution for v1: zip `dist/`, upload to Chrome Web Store Developer Dashboard, submit for review.
- Operator owns the Chrome Web Store listing + the OAuth consent screen in Google Cloud Console.
- Per-env builds: `pnpm --filter @kindoo/extension build` (default = production) or `pnpm --filter @kindoo/extension build --mode staging` (loads `.env.staging`).
