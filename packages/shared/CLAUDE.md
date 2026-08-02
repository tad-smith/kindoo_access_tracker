# packages/shared — Claude Code guidance

Shared TypeScript types, zod schemas, and pure utility functions consumed by both `apps/web/` and `functions/`. The single source of truth for domain types.

**Owner agents:** co-owned by `web-engineer` and `backend-engineer`. Coordinate changes via `TASKS.md`.

## Stack

- TypeScript strict (`tsconfig.base.json` extended)
- zod (schemas + type inference)
- Pure functions only — must work in both browser and Node.js runtimes
- No runtime dependencies beyond zod

## File layout

```
src/
├── types/                  # Domain TypeScript types
│   ├── seat.ts
│   ├── request.ts
│   ├── access.ts
│   ├── audit.ts
│   ├── stake.ts
│   ├── auth.ts
│   └── index.ts
├── schemas/                # zod schemas (forms + Cloud Function input validation)
│   ├── request.ts
│   └── ...
├── canonicalEmail.ts       # the Gmail-aware canonicalization
├── hash.ts                 # source-row-hash equivalent (if still needed)
├── buildingSlug.ts         # building name → URL-safe slug
└── index.ts
```

## Conventions

- **One source of truth per domain type.** No duplicate `Seat` / `Request` types anywhere else in the monorepo.
- **zod schemas mirror types** via `z.infer<typeof schema>`. Define schema once; type comes free.
- **Pure functions only.** No DOM access, no `fs`, no Node-only APIs, no browser-only APIs. Must work everywhere.
- **Vitest unit tests** for every utility function and every schema (a `parse` test on representative inputs).
- **Optional booleans declare their own default direction — never copy the neighbouring field's.** `Stake.notifications_enabled` reads `?? true` (absent ⇒ on); `Stake.eq_president_app_access` reads `=== true` (absent ⇒ off). Anything that grants access or authority defaults **off**, because the field lands absent on every pre-existing doc and "nobody has answered this question yet" must not read as "yes". State the direction in the type's doc comment so consumers don't have to infer it.
- **App-access callings are a fixed list plus explicit gates.** `WARD_APP_ACCESS_CALLINGS` / `STAKE_APP_ACCESS_CALLINGS` are churchwide and not per-stake (`architecture.md` D17). The one exception is `AppAccessOptions`, an options bag threaded into `appAccessCallingsForScope` / `filterAppAccessCallings` that gates individual callings on stake config (D23). Add a gate there, never by making the arrays configurable.

## Don't

- **Don't add browser-specific or Node.js-specific code.** This is the leaf — both consumers must run.
- **Don't import from `apps/web/` or `functions/`.** This package is consumed, not consuming.
- **Don't make breaking type changes without coordinating.** Renames or removals require a `TASKS.md` entry naming the consumer changes that follow.
- **Don't add runtime dependencies casually.** Every dep ships in both client and Cloud Function bundles.

## Boundaries

- **Any change here triggers cross-workspace impact** — note in `TASKS.md` before merging if either consumer needs a sync update.
- **Type additions are append-only-friendly.** Renames or removals require coordinated migration.
- **The agent making the change owns the consumer updates** OR explicitly hands them off to the other agent in `TASKS.md`.

## Tests

- Every pure function has a vitest unit test.
- Every zod schema has a `schema.parse(seedDoc)` round-trip test on representative documents.
- Edge cases on `canonicalEmail`: typed-form variants of Gmail, dots, `+suffix`, `googlemail.com` → `gmail.com`, non-Gmail (no dot-strip), whitespace, casing.
