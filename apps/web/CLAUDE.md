# apps/web — Claude Code guidance

The user-facing SPA. React 19 + TypeScript + Vite + Firebase SDK direct-to-Firestore. Built across Phases 4–10 of the migration; deployed to Firebase Hosting at cutover.

**Owner agent:** `web-engineer`. Also responsible for `e2e/`.

## Stack

- React 19 (functional components + hooks only)
- TypeScript strict (`tsconfig.base.json` extended)
- Vite 8 (dev server + build; rolldown bundler)
- TanStack Router (file-based routes; **typed search params via zod schemas**)
- TanStack Query (cache substrate; mutations; the DIY hooks layer below pushes Firestore snapshots into it)
- DIY Firestore hooks at `apps/web/src/lib/data/` (per architecture D11): `useFirestoreDoc`, `useFirestoreCollection`, `useFirestoreOnce`. Consume SDK singletons from `apps/web/src/lib/firebase.ts` directly; no React-context provider required for the SDK instances.
- Zustand (cross-page local state: toast queue, modal stack, principal cache)
- react-hook-form + zod 4 (every form)
- shadcn-ui components (Radix primitives + Tailwind)
- Tailwind CSS (utility-first, no CSS-in-JS, no CSS modules)
- vite-plugin-pwa (service worker + manifest)

## File layout

```
src/
├── routes/                    # TanStack Router file-based routes (thin)
│   └── _authed/               # Auth-gated route group
├── features/                  # One folder per domain
│   └── {feature}/
│       ├── hooks.ts           # data hooks + mutations
│       ├── schemas.ts         # zod schemas (mirror in packages/shared if used by backend)
│       ├── components/
│       ├── pages/             # route components
│       └── tests/
├── components/                # Cross-feature shared UI
│   └── ui/                    # shadcn-ui copy-pasted components (per shadcn convention)
├── lib/                       # firebase init, principal hook, toast, utils
├── styles/                    # global Tailwind layer + tokens
└── main.tsx
```

## Conventions

- **Routes are thin.** Defined in `src/routes/`, just compose hooks + components from `features/`.
- **All Firestore reads via the DIY hooks at `apps/web/src/lib/data/`.** Wrap them in feature-specific hooks under `features/{x}/hooks.ts`; components consume those, never the SDK directly. The two patterns load-bearing inside `lib/data/`: cache values are sentinel-wrapped (`{ value: T | undefined }`) because TanStack Query 5 disallows raw `undefined`; live-subscribed hooks use a never-resolving `queryFn` so the `onSnapshot` listener owns state transitions. Preserve both when adding new hooks. (See architecture D11 implementation note.)
- **All mutations via TanStack `useMutation`** wrapping a Firestore transaction. Mutations live in `features/{x}/hooks.ts`.
- **Forms always use react-hook-form + zod resolver.** Same zod schema can move to `packages/shared/` if a Cloud Function validates the same shape.
- **shadcn-ui components are copy-pasted** into `src/components/ui/` via the shadcn CLI. They're your code, customize freely.
- **Tailwind classes inline.** No `@apply` in CSS files except for global tokens.
- **Tests colocated** under each feature's `tests/` directory. One test file per source file.
- **Types from `packages/shared/`** for any domain object (Seat, Request, Access). Don't redeclare locally.

## Don't

- **Don't import from another feature's internal files.** Cross-feature deps go through `lib/` or `components/`.
- **Don't write to Firestore outside a hook in `features/{x}/hooks.ts`.** Components consume hooks; they don't issue queries directly.
- **Don't reach into the auth token directly.** Use `usePrincipal()` from `lib/principal.ts`.
- **Don't add UI primitives by hand.** Install via `npx shadcn-ui add <component>`. The accessible Radix layer is the win.
- **Don't bypass `packages/shared/` types** — define new domain types there, not duplicated locally.
- **Don't manually register service workers.** vite-plugin-pwa handles it.

## Boundaries

- **New query needs a composite index** → edit `firestore/firestore.indexes.json` AND tag `backend-engineer` in `TASKS.md`.
- **New write path needs a rule change** → `TASKS.md` entry; do not touch `firestore/firestore.rules`.
- **New shared type or schema** → edit `packages/shared/`; note in `TASKS.md` so backend-engineer can sync if needed.
- **New Cloud Function needed** (e.g., trigger on entity write) → `TASKS.md` entry for backend-engineer.

## Tests

- **Unit tests:** pure functions, render helpers (vitest + jsdom).
- **Component tests:** RTL + jsdom; describe behaviour, not implementation.
- **Hook tests:** against Firebase emulator (real Firestore, real Auth).
- **E2E tests:** in `e2e/` workspace (Playwright); covered separately.
- **Coverage gate:** every render helper has at least one unit test; every page has at least one E2E.
- **Names:** `it('shows pending requests in FIFO order')`, not `it('renders list correctly')`.

## PWA

- vite-plugin-pwa configured in `vite.config.ts`. Workbox: cache-first for static assets, network-first for `index.html`, never cache Firestore traffic.
- Manifest auto-generated from config.
- Push notifications via FCM Web — Phase 10. Service worker at `public/firebase-messaging-sw.js` handles background pushes.
