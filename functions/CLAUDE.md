# functions — Claude Code guidance

Cloud Functions: Firestore triggers, HTTPS callables, email send, push send, audit fan-in, custom-claims sync, and the scheduled-task dispatcher. All server-side compute lives here.

**Exactly one scheduled function, and it stays that way.** `dispatchScheduledTasks` is an hourly cron that walks the stakes and enqueues Cloud Tasks work; every scheduled feature is a `lib/taskRegistry.ts` entry it dispatches, never a second `onSchedule`. Cloud Scheduler's free tier is three jobs per billing account and staging + prod spend two of them on any single job.

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
│   ├── syncBootstrapClaims.ts         # stake bootstrap_admin_email + setup_complete → bootstrap marker
│   ├── auditTrigger.ts                # parameterized; fans audit rows for every entity write (9 collections)
│   ├── notifyOnRequestWrite.ts        # email on submit/complete/reject/cancel
│   ├── notifyOnOverCap.ts             # email when last_over_caps_json transitions
│   ├── notifyOnAccessGranted.ts       # welcome email on the no-scopes → some-scopes access transition
│   ├── pushOnRequestSubmit.ts         # FCM push on new request submission
│   └── removeSeatOnRequestComplete.ts # Admin-SDK delete for remove-request completions
├── callable/
│   ├── getMyPendingRequests.ts        # signed-in caller's pending requests across roles
│   ├── markRequestComplete.ts         # manager-invoked; completes a request + writes seats
│   ├── createStake.ts                 # superadmin-invoked; seeds a stake + its platformAuditLog row
│   ├── syncApplyFix.ts                # extension Sync per-row fix applier (auto + manual + temp paths)
│   ├── mintExtensionToken.ts          # custom token for the extension sign-in handoff (D33)
│   ├── backfillEqPresidentAccess.ts   # reconciles access docs after the EQ-president flag flips
│   └── backfillKindooSiteId.ts        # one-shot migration helper for Kindoo Sites
├── scheduled/
│   └── dispatchScheduledTasks.ts      # hourly cron; seeds, selects and enqueues per-stake tasks
├── tasks/
│   └── runScheduledTask.ts            # the ONE onTaskDispatched worker; resolves a job from the registry
├── services/                          # business logic (EmailService, SyncReminderService)
├── lib/                               # admin SDK init, resend client, audit diff, task registry, helpers
├── tests/                             # vitest suites mirroring src/
└── index.ts                           # function exports for Firebase deploy
```

No Sheets-client wrapper, no importer service, no `runImporter` / `runImportNow` — the LCR Sheet importer was removed in T-45 (see `docs/architecture.md` D14). The extension's Sync feature is now the sole auto-seat source; `syncApplyFix` is its server entry point.

## Conventions

- **One file per function** (or per closely-related group of triggers).
- **Idempotency by deterministic write paths.** Audit trigger uses `{writeTime}_{collection}_{docId}` so retries write the same row.
- **The nine audit registrations set `retry: true`.** Firestore triggers don't retry by default, so a failed audit write would silently lose the row after the entity write already committed. The deterministic doc id above is what makes that safe — a redelivery carries the original CloudEvent time, so every retry `set()`s the same row. Don't enable retries on a trigger whose write isn't idempotent.
- **All shared types from `packages/shared/`.** No duplicated `Seat`/`Request`/`Access` types.
- **Canonical email helper from `packages/shared/canonicalEmail.ts`.** Don't re-implement.
- **Wrap all multi-doc writes in `db.runTransaction(...)`** — same atomicity guarantees as client transactions.
- **All secrets via env injection** (`process.env.RESEND_API_KEY`); never in code.
- **Cloud Functions 2nd gen** for everything (Cloud Run under the hood). Default timeout 60s; bump to 540s for any long-running callable. Default memory 256MB.
- **Read per-stake config once per invocation, outside the transactions.** `syncApplyFix` reads the stake doc after the auth gate and threads the derived options into each handler; the handlers keep their strict reads-before-writes ordering untouched. A config flip landing mid-run is a benign race the next run heals — don't add a mid-transaction read to close it.
- **Manager auth on callables reads `kindooManagers/{canonical}` directly, not the claim.** The custom claim can be ~1h stale on an idle session. `syncApplyFix` and `backfillEqPresidentAccess` both check the doc plus `active === true`.
- **Scheduled dispatch is at-least-once; every job handler must be idempotent within its own window.** `dispatchScheduledTasks` enqueues, then stamps `last_trigger_time` / `next_trigger_time`. The reverse order loses a fire silently when the process dies between the two, and a lost fire is invisible — so the double-fire is the failure mode we keep. Two things narrow it without closing it: the deterministic Cloud Tasks id (`{stakeId}--{job}--{YYYYMMDDTHH}`, whose `functions/task-already-exists` rejection is treated as success) dedupes a same-hour retry, and each handler carries its own guard (`sendSyncReminderIfDue` uses a stake-local date stamp). A new job that can't tolerate running twice needs its own guard before it goes in the registry.
- **A new scheduled feature is a `lib/taskRegistry.ts` entry and nothing else** — no new `onSchedule`, no per-job `onTaskDispatched`, no queue. `defaultEnabled` is `false` for everything: the dispatcher seeds an entry onto every stake automatically, and a seeded job must not start acting on a stake's behalf before a human turns it on. Seeding only ever ADDS a missing entry — never rewrite an existing one, because a manager's `enabled: false` is a decision.
- **`stakeSchedules/{stakeId}` is top level and deliberately unaudited.** Under `stakes/{stakeId}` it would land inside the slice `auditTrigger.registration.test.ts` reads and force an audit trigger on a doc the dispatcher rewrites hourly; on the stake parent doc the hourly stamp would fan an `auditStakeWrites` row, and `BOOKKEEPING_FIELDS` would suppress the `enabled` toggle along with it. Neither trade is worth it at this collection's value.
- **Reconcile callables are merge-only over the field they own.** `backfillEqPresidentAccess` adds / removes exactly one calling inside `importer_callings[scope]` rather than reusing `writeAccessForAutoScope`'s wholesale replace — a rebuild would silently "fix" unrelated entries the operator didn't consent to touching. A destructive direction takes an explicit parameter guarded against current config (`failed-precondition` on mismatch), so a stale client confirmation can't write the wrong side.

## Changing dependencies

**Any edit to `dependencies` in `functions/package.json` — add, remove, or version bump — is a two-command change:**

```bash
pnpm install         # updates pnpm-lock.yaml
pnpm deps:relock     # regenerates functions/deploy-lock/package-lock.json
```

Commit the regenerated `functions/deploy-lock/package-lock.json` in the same commit. You will not forget silently: `pnpm --filter @kindoo/functions build` runs the drift check and fails, which takes CI's build step and `firebase deploy`'s predeploy hook down with it. Run `pnpm deps:check` any time to see the state.

Why it exists: `firebase deploy` uploads only `functions/lib`, so `lib/` is the package root Cloud Build installs from, and before T-73 every range in the generated `lib/package.json` re-resolved at deploy time against no lockfile. That deployed a tree neither local dev nor CI had exercised, and it took prod down once — `@firebase/database-compat` declares `@firebase/app` as an **optional** peer, npm skipped it, and all 24 functions died at container start on `Cannot find module '@firebase/app'` (Cloud Functions loads the whole of `index.js` in every container, and the 1st-gen `onAuthUserCreate` pulls `firebase-functions/v1`, which eagerly loads `firebase-admin/database`).

Consequences for how you declare deps:

- **`@firebase/app` is a load-bearing explicit dependency,** not incidental. It is an optional peer of a transitive; nothing else guarantees it. Do not remove it.
- **Anything the bundle leaves external must be a real `dependencies` entry.** esbuild externalises exactly the keys of `dependencies`; anything else is inlined into `lib/index.js`.
- **`@kindoo/shared` stays a devDependency** — `workspace:*` is not installable by npm. See `infra/CLAUDE.md` "Cloud Functions deploy artifact" and `docs/architecture.md` D12.
- **The deploy tree's direct versions are pinned from `pnpm-lock.yaml`,** so what deploys is what CI tested. A caret range in `functions/package.json` no longer means the deploy floats.

Details: `functions/deploy-lock/README.md`, `functions/scripts/deploy-deps.mjs`, `infra/runbooks/deploy.md` "Deploy dependency pinning".

## Don't

- **Don't hand-edit `functions/deploy-lock/package-lock.json`.** Regenerate it with `pnpm deps:relock`. It is not a workspace lockfile — local dev and CI install through `pnpm-lock.yaml` and never read it.
- **Don't write audit rows directly from non-audit functions.** The parameterized `auditTrigger` handles it. Server-driven writes stamp the synthetic actor (e.g. `RemoveTrigger`) on the entity's `lastActor` and let the trigger emit the audit row. **Exception:** `createStake` writes the `platformAuditLog` row directly (per F19). The `auditTrigger` only fans per-stake `auditLog`, not the cross-stake `platformAuditLog`, and sub-1-write-a-year doesn't justify a separate trigger — keep this in-callable.
- **Don't reach into Firestore from outside `src/services/` helpers.** Keeps test boundaries clean and audit traceable.
- **Don't store secrets in code.** Use Secret Manager + env vars.
- **Don't bypass `packages/shared/` types.** Define new types there.
- **Don't catch and silently swallow errors.** Log + rethrow OR write a typed error to the response. Silent failures are the worst kind. One documented carve-out: `emitAuditRow` drops a permanently rejected audit row (gRPC `INVALID_ARGUMENT`, i.e. oversize) after logging its coordinates, because retrying it would burn the full 24h redelivery window to land nowhere. Every other code rethrows so the retry redelivers. It's unit-tested; don't widen it.

## Boundaries

- **Schema/type change** → edit `packages/shared/`, note in `TASKS.md`.
- **New rule needed** → you own `firestore/`, but rule + test land in that workspace's PR.
- **New index needed** → edit `firestore/firestore.indexes.json`.
- **Web-engineer needs a new callable** → coordinate via `TASKS.md`.

## Tests

- **Vitest + Firebase emulator.** No mocks for Firestore or Auth — emulator is the test database.
- **Mock external services** (Resend, FCM) at the wrapper level only.
- **Each trigger / callable function has at least:** happy path, error path, idempotency case (where applicable).
- **`markRequestComplete` and `syncApplyFix` are the highest-stakes test surfaces** — together they carry the bulk of the integration suite (the two largest files in `tests/`). Both touch multiple collections in a single transaction: `markRequestComplete` writes seat / request / stake docs and triggers the audit fan-in; `syncApplyFix` is the auto-seat applier the extension calls (every kindoo-to-sba drift-row shape — `kindoo-only`, `callings-mismatch`, `type-mismatch`, `scope-mismatch`, `buildings-mismatch`, `kindoo-unparseable`, `sba-only` — has its own path with its own seat / access bookkeeping; sba-to-kindoo variants are extension-side and never reach the backend). When changing either, expect to update the matching test file in lockstep.

## Deploy

- Functions deploy via `pnpm deploy:functions:staging` / `:prod` (scripts in `infra/scripts/`).
- 2nd-gen functions inherit Cloud Run service identity; service account `kindoo-app@<project>.iam.gserviceaccount.com` needs Firestore + Secret Manager roles (plus FCM admin + Eventarc consumer roles for the push / Firestore-trigger paths — see `infra/runbooks/provision-firebase-projects.md` step 1.8).
