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

Each script stamps version, typechecks, runs tests, builds web + functions, then runs `firebase deploy` for Hosting + Functions + Firestore (rules + indexes). Both support `--dry-run`.

Full pre-flight, verification, and rollback steps: `infra/runbooks/deploy.md`.

## Layout

```
infra/
├── scripts/
│   ├── deploy-staging.sh             # operator-triggered deploy to staging
│   ├── deploy-prod.sh                # operator-triggered deploy to prod
│   ├── ensure-version-gen.js         # seeds gitignored version.gen.ts placeholders on `pnpm install`
│   ├── stamp-version.js              # writes apps/web/src/version.gen.ts + functions/src/version.gen.ts
│   ├── generate-icons.mjs            # PWA icon generation from icon-sources/
│   └── icon-sources/                 # source SVGs for PWA icons
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
