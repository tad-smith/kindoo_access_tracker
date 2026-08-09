# packages/shared — Claude Code guidance

Shared TypeScript types, zod schemas, and pure utility functions consumed by `apps/web/`, `functions/`, and `extension/`. The single source of truth for domain types.

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
├── existingSeatGate.ts     # can an add be provisioned onto an existing seat
├── remoteApply.ts          # remote-apply timings, freshness, site keys, claim rule
├── unitName.ts             # ward_name → unit type + Kindoo scope name (D31)
└── index.ts
```

## Conventions

- **One source of truth per domain type.** No duplicate `Seat` / `Request` types anywhere else in the monorepo.
- **A predicate two surfaces must agree on lives here, not in each of them.** A gate expressed twice drifts, and the drift is invisible from either copy — neither surface can see the other's. It also rarely fails safe: the broader copy silently removes a capability for a class of input the other handles, which reads to the user as a bug in the feature rather than a disagreement between two files. `addBlockedByExistingSeat` (`existingSeatGate.ts`), `canClaimRemoteApplyJob` / `remoteApplySiteKey` / `remoteApplyTargetSiteKey` (`remoteApply.ts`), `unitType` / `kindooScopeName` / `kindooScopeNameVariants` (`unitName.ts`), `partitionPendingRequests`, and `deriveRequesterDisplay` are all here for that reason. Take the facts as arguments, not the surface's own data shapes, so a caller can consume it without reshaping its props.
- **zod schemas mirror types** via `z.infer<typeof schema>`. Define schema once; type comes free.
- **Pure functions only.** No DOM access, no `fs`, no Node-only APIs, no browser-only APIs. Must work everywhere.
- **Vitest unit tests** for every utility function and every schema (a `parse` test on representative inputs).
- **Optional booleans declare their own default direction — never copy the neighbouring field's.** `Stake.notifications_enabled` reads `?? true` (absent ⇒ on); `Stake.eq_president_app_access` reads `=== true` (absent ⇒ off). Anything that grants access or authority defaults **off**, because the field lands absent on every pre-existing doc and "nobody has answered this question yet" must not read as "yes". State the direction in the type's doc comment so consumers don't have to infer it.
- **A unit's kind comes from its name, never from a field.** `unitName.ts` is the only place that decides: a `ward_name` ending in `" Branch"` is a branch (scope name verbatim); anything else is a ward (`" Ward"` optional, appended when absent). Never test the suffix inline or compare `ward_name` to a Kindoo description directly. Don't add a `unit_type` field — `architecture.md` D31 says why. **The kind is also nearly all a branch is:** it is a ward but for its scope name and a handful of calling names (D31(f), D32), so `wards` / `ward_code` / `ward_name` and prose saying "ward" cover both kinds and are not drift to be swept to "unit". Where the kind can't be determined, assume ward rather than refuse, and branch a code path only at the point that actually differs.
- **App-access callings are three fixed lists plus explicit gates.** `WARD_APP_ACCESS_CALLINGS` / `BRANCH_APP_ACCESS_CALLINGS` / `STAKE_APP_ACCESS_CALLINGS` are churchwide and not per-stake (`architecture.md` D17, D32). The one seam is `AppAccessOptions`, an options bag threaded into `appAccessCallingsForScope` / `filterAppAccessCallings`. Add a gate there, never by making the arrays configurable. The bag now carries two gates of **different kinds**, and the distinction matters when adding a third: `eqPresidentAccess` is per-stake config, read once per invocation (D23), while `unitType` is a property of the unit `scope` names, derived from its `ward_name` and resolved per scope (D31, D32). `unitType` is optional and **absent reads as ward** — backward-compatible and fail-closed, since no branch calling is in the ward set. It cannot be derived from `scope`: a `ward_code` is a slug, not a name.

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
