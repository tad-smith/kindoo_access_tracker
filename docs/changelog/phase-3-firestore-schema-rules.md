# Phase 3 — Firestore schema + security rules + indexes

**Shipped:** 2026-04-28
**Commits:** _(this commit; predecessor was Phase 2 close `cf1532a`)_

## What shipped

The Firestore data layer is locked in. Every collection from `docs/firebase-schema.md` §§3–4 has a TypeScript type, a zod schema with a round-trip test, and a security-rules match block backed by emulator-run rules tests. The lock-everything stub from Phase 1 is gone; rules now match `firebase-schema.md` §6 1:1. All composite indexes from §5.1 are declared. `auditLog` TTL on the collection group is operator follow-up (T-15) since `gcloud firestore fields ttls update` is not part of `firebase deploy`.

Phase 3 acceptance criteria from `docs/firebase-migration.md` line 502 onward — every collection defined, every rules path tested, composite-key uniqueness on access, email canonicalization tests pass via shared helper, cross-stake reads forbidden, type-check clean, no `any` in shared types — are all met.

Concretely landed:

- **`packages/shared/src/types/`** — 13 new collection types: `Stake`, `Ward`, `Building`, `KindooManager`, `Access`, `Seat`, `Request`, `WardCallingTemplate`, `StakeCallingTemplate`, `AuditLog`, `PlatformSuperadmin`, `PlatformAuditLog`, plus the `Actor` value type used inside several. `UserIndex` from Phase 2 carried forward unchanged. Barrel `types/index.ts` updated.
- **`packages/shared/src/schemas/`** — 13 new zod schemas mirroring the types, plus a `TimestampLike` zod brand reused across collections. `schemas.test.ts` (27 cases) round-trips a representative seed doc per collection through `schema.parse`.
- **`packages/shared/src/buildingSlug.{ts,test.ts}`** — `'Cordera Building' → 'cordera-building'`; deterministic; 10 cases.
- **`packages/shared/src/auditId.{ts,test.ts}`** — `<ISO ts>_<uuid>` generator; deterministic format, sortable by reverse-lex when negated, no collisions across synthetic distinct inputs; 9 cases.
- **`packages/shared/src/index.ts`** — barrel re-exports the new types, schemas, and helpers.
- **`firestore/firestore.rules`** — replaced the lock-everything stub with the full per-collection matrix from `firebase-schema.md` §6 (~384 lines). Helpers landed: `isAuthed`, `authedCanonical`, `isManager`, `isStakeMember`, `bishopricWardOf`, `isAnyMember`, `isPlatformSuperadmin`, `lastActorMatchesAuth`. The cross-doc invariant `tiedToRequestCompletion` uses `getAfter()` to verify a `seats` create lands in the same transaction as a `requests` doc transitioning to `complete`. Phase 2's `userIndex/{memberCanonical}` block is preserved verbatim. Inline comments explain the `getAfter()` use, the `lastActor` integrity check, and the `access` split-ownership.
- **`firestore/firestore.indexes.json`** — 10 composite indexes per `firebase-schema.md` §5.1: 6 on the `auditLog` collection group and 4 on the `requests` collection group.
- **`firestore/README.md`** — per-index justifications, since `firestore.indexes.json` has no comment syntax. Each composite is paired with the query that needs it.
- **`firestore/tests/`** — 10 new per-match-block test files: `access.test.ts`, `auditLog.test.ts`, `buildings.test.ts`, `callingTemplates.test.ts`, `kindooManagers.test.ts`, `requests.test.ts`, `seats.test.ts`, `stakes.test.ts`, `topLevel.test.ts`, `wards.test.ts`. Phase 2's `userIndex.test.ts` carries forward.
- **`firestore/tests/lib/rules.ts`** — extended persona helpers: `managerContext`, `stakeMemberContext`, `bishopricContext`, `outsiderContext`, `superadminContext`, a `personas` collection for table-driven cross-stake denial, and a `lastActorOf(persona)` builder so test docs can be constructed with a canonical-matching `lastActor`.
- **`firestore/tests/setup.test.ts`** — converted from "lock-everything is locked" smoke to "any unmatched path is denied," reflecting that the stub no longer exists.
- **`firestore/package.json`** — added `firebase` as a devDep so tests can call `serverTimestamp()` when constructing fixtures.

**Test outcomes (measured fresh):**

- `@kindoo/shared`: **69 tests pass** across 5 files (`buildingSlug` 10, `canonicalEmail` 11 carry-over, `principal` 12 carry-over, `auditId` 9, `schemas` 27).
- `@kindoo/firestore-tests`: **160 tests pass against the Firestore emulator** across 12 files.
- `@kindoo/functions`: 1 unit test passes; the 21 Phase-2 emulator-gated integration tests still pass — no Phase-3 regression.

## Deviations from the pre-phase spec

Phase 3's "spec" is the Phase 3 section of `docs/firebase-migration.md` plus `docs/firebase-schema.md` §§3–6. Implementation matches the spec. No deviations beyond two operational notes:

- **`auditLog` TTL on the collection group is deferred to operator follow-up.** The Phase 3 sub-task list calls for `gcloud firestore fields ttls update` to enable TTL on `auditLog`'s `expiresAt` field across the collection group. This is operator-side and not part of `firebase deploy`. Captured as **T-15**; due before Phase 8 starts emitting audit rows in earnest.
- **`apps/web/src/lib/docs.ts` typed-doc helper is left for Phase 4.** Phase 3 sub-task 7 mentions a thin typed-doc-helper layer in `apps/web/src/lib/docs.ts`. That belongs in `web-engineer`'s lane and lands when Phase 4 starts wiring the SPA to Firestore reads. Captured as **T-16**.

## Decisions made during the phase

Phase 3 is implementation of already-decided rules per `firebase-schema.md` §6, so no new D-number is earned. A few load-bearing implementation choices worth recording:

- **`getAfter()` is used in exactly one place** — `seats` create's `tiedToRequestCompletion` cross-doc invariant. This is the only cross-document check the rules engine needs; everywhere else, claim-based and same-doc invariants suffice. The single use is called out in an inline comment in `firestore.rules` so the next reader knows why this rules pattern appears here and nowhere else.
- **`lastActor` integrity check is the primary defense for trustworthy audit attribution.** Every client write must carry `lastActor.{email, canonical}` matching the auth token's typed email and the custom-claim-derived canonical. This is what makes the audit trigger's fan-out (Phase 8) trustworthy without re-deriving identity server-side.
- **Split-ownership on `access`.** `importer_callings` is server-only (Admin SDK bypass via the importer Cloud Function); manager updates must leave the `importer_callings` map byte-equal. The `manual_grants` map is the manager's lane. Rules enforce both halves; tests cover the byte-equality case explicitly.
- **`firestore.indexes.json` is plain JSON, no comments allowed.** Per-index rationale lives in `firestore/README.md` so each composite index has a paired explanation of which query needs it. Worth recording as a small convention: future index additions update both files.
- **`callingTemplates.test.ts` shares one `RulesTestEnvironment` across both `wardCallingTemplates` and `stakeCallingTemplates` blocks.** Spinning up two separate envs in the same test file produced an emulator 500 from concurrent rules-load calls. One env, two `describe` blocks, clean reset between them. Worth a one-line note as a gotcha for future per-collection test files that share an emulator instance.

## Spec / doc edits in this phase

Phase 3 deliberately does not edit `docs/spec.md`, `docs/architecture.md`, or `docs/data-model.md`. Phase 3 is a behaviour-preserving migration step; the rules and schema were already locked in pre-Phase-1 (F1–F17) and detailed in `firebase-schema.md` §§3–6. Phase 11 cutover is when those three docs change to describe Firebase reality.

- `docs/firebase-migration.md` — F-row table unchanged.
- `docs/firebase-schema.md` — unchanged; this phase implements §§3–6 verbatim.
- `docs/changelog/phase-3-firestore-schema-rules.md` — this entry.
- `docs/TASKS.md` — appended **T-15** (operator gcloud TTL on `auditLog` collection group) and **T-16** (`apps/web/src/lib/docs.ts` typed-doc helper for Phase 4).

## Deferred

Items intentionally not in Phase 3, with where they land.

- **`auditLog` TTL operator step.** → T-15. Due before Phase 8.
- **`apps/web/src/lib/docs.ts` typed-doc helper.** → T-16. Phase 4, web-engineer's lane.
- **Web client wiring against the new collections.** Phase 4+.
- **Real data import.** Phase 11.
- **Cloud Function business logic** (importer, expiry, email). Phases 8 / 9 / 10.

## Next

Phase 4 is **Web SPA shell + auth flow + first page**. `web-engineer`'s lane. The data layer is now in place: rules permit reads for the right principals, types and zod schemas are available in `@kindoo/shared`, and the typed-doc helper (T-16) is the first thing Phase 4 builds before wiring any read or write. The Phase-2 hello page remains; Phase 4 re-renders it through the SPA shell as a smoke test before Phase 5 starts shipping real read-side pages.
