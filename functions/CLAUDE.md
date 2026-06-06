# functions — Claude Code guidance

Cloud Functions: Firestore triggers, scheduled jobs (audit reconciliation), HTTPS callables, email send, push send, audit fan-in, custom-claims sync. All server-side compute lives here.

**Owner agent:** `backend-engineer`. Also responsible for `firestore/` (rules + indexes).

## Stack

- Node.js 22 LTS
- TypeScript strict
- Firebase Admin SDK
- `firebase-functions` v6+ (2nd gen — runs on Cloud Run under the hood)
- `resend` SDK (email; per F16)
- Vitest for tests, against Firebase emulators
- Secrets via Secret Manager (env-injected at deploy)

## File layout

Authoritative export list: `src/index.ts`. Current surface:

```
src/
├── triggers/
│   ├── onAuthUserCreate.ts            # writes userIndex/{canonical}; seeds claims on first sign-in
│   ├── syncAccessClaims.ts            # access doc → custom claims
│   ├── syncManagersClaims.ts          # kindooManagers doc → custom claims
│   ├── syncSuperadminClaims.ts        # platformSuperadmins → custom claims
│   ├── auditTrigger.ts                # parameterized; fans audit rows for every entity write (10 collections)
│   ├── notifyOnRequestWrite.ts        # email on submit/complete/reject/cancel
│   ├── notifyOnOverCap.ts             # email when last_over_caps_json transitions
│   ├── pushOnRequestSubmit.ts         # FCM push on new request submission
│   └── removeSeatOnRequestComplete.ts # Admin-SDK delete for remove-request completions
├── scheduled/
│   └── reconcileAuditGaps.ts          # nightly; alerts on audit-log gaps
├── callable/
│   ├── getMyPendingRequests.ts        # signed-in caller's pending requests across roles
│   ├── markRequestComplete.ts         # manager-invoked; completes a request + writes seats
│   ├── syncApplyFix.ts                # extension Sync per-row fix applier (auto + manual + temp paths)
│   └── backfillKindooSiteId.ts        # one-shot migration helper for Kindoo Sites
├── services/                          # business logic (EmailService)
├── lib/                               # admin SDK init, resend client, audit diff, helpers
├── tests/                             # vitest suites mirroring src/
└── index.ts                           # function exports for Firebase deploy
```

No Sheets-client wrapper, no importer service, no `runImporter` / `runImportNow` — the LCR Sheet importer was removed in T-45 (see `docs/architecture.md` D14). The extension's Sync feature is now the sole auto-seat source; `syncApplyFix` is its server entry point.

## Conventions

- **One file per function** (or per closely-related group of triggers).
- **Idempotency by deterministic write paths.** Audit trigger uses `{writeTime}_{collection}_{docId}` so retries write the same row.
- **All shared types from `packages/shared/`.** No duplicated `Seat`/`Request`/`Access` types.
- **Canonical email helper from `packages/shared/canonicalEmail.ts`.** Don't re-implement.
- **Wrap all multi-doc writes in `db.runTransaction(...)`** — same atomicity guarantees as client transactions.
- **All secrets via env injection** (`process.env.RESEND_API_KEY`); never in code.
- **Cloud Functions 2nd gen** for everything (Cloud Run under the hood). Default timeout 60s; bump to 540s for any long-running scheduled job or callable. Default memory 256MB.

## Don't

- **Don't write audit rows directly from non-audit functions.** The parameterized `auditTrigger` handles it. Server-driven writes stamp the synthetic actor (e.g. `RemoveTrigger`) on the entity's `lastActor` and let the trigger emit the audit row. **Exception:** `createStake` writes the `platformAuditLog` row directly (per F19). The `auditTrigger` only fans per-stake `auditLog`, not the cross-stake `platformAuditLog`, and sub-1-write-a-year doesn't justify a separate trigger — keep this in-callable.
- **Don't reach into Firestore from outside `src/services/` helpers.** Keeps test boundaries clean and audit traceable.
- **Don't store secrets in code.** Use Secret Manager + env vars.
- **Don't bypass `packages/shared/` types.** Define new types there.
- **Don't catch and silently swallow errors.** Log + rethrow OR write a typed error to the response. Silent failures are the worst kind.

## Boundaries

- **Schema/type change** → edit `packages/shared/`, note in `TASKS.md`.
- **New rule needed** → you own `firestore/`, but rule + test land in that workspace's PR.
- **New index needed** → edit `firestore/firestore.indexes.json`.
- **Web-engineer needs a new callable** → coordinate via `TASKS.md`.

## Tests

- **Vitest + Firebase emulator.** No mocks for Firestore or Auth — emulator is the test database.
- **Mock external services** (Resend, FCM) at the wrapper level only.
- **Each trigger / scheduled / callable function has at least:** happy path, error path, idempotency case (where applicable).
- **`markRequestComplete` and `syncApplyFix` are the highest-stakes test surfaces** — together they carry the bulk of the integration suite (the two largest files in `tests/`). Both touch multiple collections in a single transaction: `markRequestComplete` writes seat / request / stake docs and triggers the audit fan-in; `syncApplyFix` is the auto-seat applier the extension calls (every kindoo-to-sba drift-row shape — `kindoo-only`, `callings-mismatch`, `type-mismatch`, `scope-mismatch`, `buildings-mismatch`, `kindoo-unparseable`, `sba-only` — has its own path with its own seat / access bookkeeping; sba-to-kindoo variants are extension-side and never reach the backend). When changing either, expect to update the matching test file in lockstep.

## Deploy

- Functions deploy via `pnpm deploy:functions:staging` / `:prod` (scripts in `infra/scripts/`).
- 2nd-gen functions inherit Cloud Run service identity; service account `kindoo-app@<project>.iam.gserviceaccount.com` needs Firestore + Secret Manager roles (plus FCM admin + Eventarc consumer roles for the push / Firestore-trigger paths — see `infra/runbooks/provision-firebase-projects.md` step 1.8).
