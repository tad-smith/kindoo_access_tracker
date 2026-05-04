# functions — Claude Code guidance

Cloud Functions: Firestore triggers, scheduled jobs (importer, expiry, reconciliation), HTTPS callables, email send, audit fan-in, custom-claims sync. All server-side compute lives here.

**Owner agent:** `backend-engineer`. Also responsible for `firestore/` (rules + indexes).

## Stack

- Node.js 22 LTS
- TypeScript strict
- Firebase Admin SDK
- `firebase-functions` v6+ (2nd gen — runs on Cloud Run under the hood)
- `googleapis` for Sheets API (importer)
- `resend` SDK (email; per F16)
- Vitest for tests, against Firebase emulators
- Secrets via Secret Manager (env-injected at deploy)

## File layout

```
src/
├── triggers/
│   ├── onAuthUserCreate.ts        # writes userIndex, seeds claims
│   ├── syncAccessClaims.ts        # access doc → custom claims
│   ├── syncManagersClaims.ts      # kindooManagers doc → custom claims
│   ├── syncSuperadminClaims.ts    # platformSuperadmins → custom claims
│   ├── auditTrigger.ts            # parameterized; fans audit rows for every entity write
│   ├── notifyOnRequestWrite.ts    # email on submit/complete/reject/cancel
│   ├── notifyOnOverCap.ts         # email when last_over_caps_json transitions
│   └── removeSeatOnRequestComplete.ts  # Admin-SDK delete for remove-request completions
├── scheduled/
│   ├── runImporter.ts             # hourly fire; loops over stakes per their schedule
│   ├── runExpiry.ts               # hourly fire; loops over stakes per expiry_hour
│   └── reconcileAuditGaps.ts      # nightly; alerts on audit-log gaps
├── callable/
│   ├── createStake.ts             # superadmin-only (Phase 12)
│   └── runImportNow.ts            # manager-invoked; calls Importer for one stake
├── services/                      # business logic (Importer, Expiry, EmailService)
├── lib/                           # admin SDK init, resend client, sheets client, helpers
├── tests/                         # vitest suites mirroring src/
└── index.ts                       # function exports for Firebase deploy
```

## Conventions

- **One file per function** (or per closely-related group of triggers).
- **Idempotency by deterministic write paths.** Audit trigger uses `{writeTime}_{collection}_{docId}` so retries write the same row.
- **All shared types from `packages/shared/`.** No duplicated `Seat`/`Request`/`Access` types.
- **Canonical email helper from `packages/shared/canonicalEmail.ts`.** Don't re-implement.
- **Wrap all multi-doc writes in `db.runTransaction(...)`** — same atomicity guarantees as client transactions.
- **All secrets via env injection** (`process.env.RESEND_API_KEY`); never in code.
- **Cloud Functions 2nd gen** for everything (Cloud Run under the hood). Default timeout 60s; bump to 540s for importer/expiry. Default memory 256MB; bump for importer if needed.

## Don't

- **Don't write audit rows directly from non-audit functions.** The parameterized `auditTrigger` handles it. Exception: importer + expiry write history docs explicitly because Admin SDK bypasses rules and the trigger needs the actor info.
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
- **Mock external services** (Resend, Sheets API, FCM) at the wrapper level only.
- **Each trigger / scheduled / callable function has at least:** happy path, error path, idempotency case (where applicable).
- **Importer is the highest-stakes test surface.** Heavy unit coverage on parsing + diff math; integration tests against fixture LCR sheets.

## Deploy

- Functions deploy via `pnpm deploy:functions:staging` / `:prod` (scripts in `infra/scripts/`).
- 2nd-gen functions inherit Cloud Run service identity; service account `kindoo-app@<project>.iam.gserviceaccount.com` needs Firestore + Secret Manager + Sheets API roles.
