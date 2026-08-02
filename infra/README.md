# infra/

Operational tooling for the Firebase deployment: deploy scripts, monitoring config, runbooks, CI workflow source-of-truth.

See `infra/CLAUDE.md` for agent-facing conventions; this README is for human operators.

## Firebase projects

Two projects, same code, different `--project` flag:

- `kindoo-staging` — rehearsal environment.
- `kindoo-prod` — live environment; PITR enabled, weekly Firestore export to `gs://kindoo-prod-backups/` with a 90-day lifecycle.

Project IDs live in `.firebaserc` at the repo root. The deploy scripts resolve them via the `staging` / `prod` aliases.

## How to deploy

Operator-triggered from a developer machine:

```bash
pnpm deploy:staging      # invokes infra/scripts/deploy-staging.sh
pnpm deploy:prod         # invokes infra/scripts/deploy-prod.sh
```

Each script stamps version, typechecks, builds web + functions, runs `firebase deploy` for Hosting + Functions + Firestore (rules + indexes), then verifies the deploy actually landed. Both support `--dry-run` and `--skip-verify`.

The verification step exists because `firebase deploy` exiting 0 only means the API accepted the upload. It probes every deployed callable unauthenticated and compares the deployed function set against `functions/src/index.ts`, so an unreachable-but-"successfully-deployed" function fails the deploy instead of being discovered by a user clicking a button. Rationale and the incident that motivated it: the header of `infra/scripts/lib/verify-deploy.sh`.

Run it on its own, without deploying:

```bash
bash infra/scripts/lib/verify-deploy.sh staging     # or: prod
```

Full pre-flight, verification, and rollback steps: `infra/runbooks/deploy.md`.

## Cloud Functions dependency pinning

`firebase deploy` uploads only `functions/lib`, so `lib/` is the package root Cloud Build installs from. `functions/deploy-lock/package-lock.json` is the committed lockfile for that install — `functions/scripts/build.mjs` copies it into `lib/` on every build, and the GCP Node.js buildpack runs `npm ci` against it. Without it, every version range re-resolved at deploy time and shipped a tree nothing had tested; that took production down once (`Cannot find module '@firebase/app'`, all 24 functions, at container start).

Two commands, both from the repo root:

```bash
pnpm deps:relock     # regenerate the lockfile — after ANY functions/package.json dependency change
pnpm deps:check      # offline drift check; also runs inside every functions build
```

Direct versions are pinned to what `pnpm-lock.yaml` resolves, so the deployed direct deps match what CI exercises. Transitives are npm's own resolution and will not match pnpm's exactly — the divergence is committed and reviewable rather than invented at deploy time.

Details, expected output, and the manual verification steps: `infra/runbooks/deploy.md` "Deploy dependency pinning". Rationale: `docs/TASKS.md` T-73 and `functions/deploy-lock/README.md`.

## Layout

```
infra/
├── scripts/
│   ├── deploy-staging.sh             # operator-triggered deploy to staging
│   ├── deploy-prod.sh                # operator-triggered deploy to prod
│   ├── ensure-version-gen.js         # seeds gitignored version.gen.ts placeholders on `pnpm install`
│   ├── stamp-version.js              # writes apps/web/src/version.gen.ts + functions/src/version.gen.ts
│   ├── generate-icons.mjs            # PWA icon generation from icon-sources/
│   ├── icon-sources/                 # source SVGs for PWA icons
│   ├── lib/
│   │   └── verify-deploy.sh          # post-deploy verification, shared by both deploy scripts
│   └── tests/
│       └── verify-deploy.test.sh     # offline unit tests for verify-deploy.sh (no network, no creds)
│
│  (the deploy artifact's dependency pinning lives with the artifact:
│   functions/deploy-lock/ + functions/scripts/{deploy-deps,relock-deploy-deps,check-deploy-deps}.mjs)
├── ci/
│   └── workflows/
│       └── test.yml                  # source-of-truth for .github/workflows/test.yml
├── monitoring/
│   ├── alerts/                       # Cloud Monitoring alert policy YAML (gcloud-applied)
│   └── metrics/                      # log-based metric definitions (gcloud-applied)
├── runbooks/
│   ├── provision-firebase-projects.md   # initial project + billing + services setup (B1)
│   ├── deploy.md                        # operator playbook for staging + prod deploy
│   ├── observability.md                 # what alerts fire, how to find logs
│   ├── restore.md                       # PITR restore, GCS-export restore, partial restore
│   ├── resend-api-key-setup.md          # Resend secret provisioning for the notification triggers
│   ├── custom-domain.md                 # pointing stakebuildingaccess.org at Firebase Hosting
│   └── granting-importer-sheet-access.md  # giving the runtime SA read access to the roster Sheet
└── CLAUDE.md                         # agent-facing conventions
```

## CI workflow source-of-truth

`infra/ci/workflows/test.yml` is the canonical workflow. It is mirrored to `.github/workflows/test.yml` (which is what GitHub Actions actually executes). Edits go to the `infra/ci/` copy first; the `.github/workflows/` copy is kept in sync as part of the same commit.

## Runbook index

- `runbooks/deploy.md` — every deploy. Pre-flight, staging + prod commands, post-deploy verification, rollback.
- `runbooks/observability.md` — what's monitored, where to find logs and metrics, how to add new metrics or alerts.
- `runbooks/restore.md` — PITR restore (last 7 days), full GCS-export restore (last 90 days), partial collection restore.
- `runbooks/provision-firebase-projects.md` — initial project creation, billing, services, Firestore, Auth, runtime SA.
- `runbooks/resend-api-key-setup.md` — generating and storing the Resend API key for the notification triggers.
- `runbooks/custom-domain.md` — staging subdomain and apex DNS setup against Firebase Hosting.
- `runbooks/granting-importer-sheet-access.md` — sharing the roster Google Sheet with the runtime SA so the importer can read it.
