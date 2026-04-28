# infra/

Operational tooling for the Firebase port: deploy scripts, monitoring config, runbooks, CI workflows.

See `infra/CLAUDE.md` for the agent-facing conventions; this README is for human operators.

## Project IDs are placeholders until B1

The repo currently references two Firebase projects:

- `kindoo-staging` (rehearsal)
- `kindoo-prod` (live)

These IDs are written into `.firebaserc` at the repo root and into the `infra/scripts/deploy-*.sh` scripts. **As of 2026-04-27 these are placeholder IDs.** No real GCP project has been created under either name. The actual creation of the projects, billing linkage, service-account provisioning, Cloud Scheduler jobs, and PITR enablement is gated behind operator task **B1** in `docs/firebase-migration.md`.

When B1 lands, no scripts in `infra/` should need to change — `firebase deploy --project staging` (or `prod`) reads the alias from `.firebaserc` and resolves it to whatever real project ID was created. Just verify the IDs match. If different IDs are chosen, edit `.firebaserc` once and everything else picks them up.

The end-to-end click-by-click runbook for B1 is at `infra/runbooks/provision-firebase-projects.md`. Walk it once for staging, then again for prod; estimated ~90 minutes total for a first-time operator.

## Layout

```
infra/
├── scripts/
│   ├── deploy-staging.sh             # operator-triggered deploy to staging
│   ├── deploy-prod.sh                # operator-triggered deploy to prod (requires B1)
│   └── stamp-version.js              # writes apps/web/src/version.ts + functions/src/version.ts
├── ci/
│   └── workflows/
│       └── test.yml                  # source-of-truth for .github/workflows/test.yml
├── monitoring/
│   ├── alerts/                       # Cloud Monitoring alert policy YAML (gcloud-applied)
│   └── metrics/                      # log-based metric definitions (gcloud-applied)
├── runbooks/
│   ├── provision-firebase-projects.md  # B1: create both Firebase projects end-to-end
│   ├── deploy.md                       # operator playbook for staging + prod deploy
│   ├── observability.md                # what alerts fire, how to find logs
│   └── restore.md                      # PITR restore, GCS-export restore, partial restore
└── CLAUDE.md                         # agent-facing conventions
```

## What's wired now (Phase 1) and what's not

Wired:

- pnpm workspace (`pnpm-workspace.yaml`, root `package.json`).
- Firebase CLI config (`firebase.json`, `.firebaserc`).
- Deploy script skeletons under `infra/scripts/deploy-*.sh` — fully structured but `--dry-run` is the only mode that runs cleanly until B1.
- CI workflow (`infra/ci/workflows/test.yml` mirrored to `.github/workflows/test.yml`).
- Monitoring + alerts directories with placeholder YAML files (commented-out commands; reference only until B1).
- Runbook skeletons.

Not yet wired (waits on engineering agents):

- `apps/web/` package.json + workspace `dev`/`build`/`test` scripts → web-engineer.
- `functions/` package.json + workspace scripts → backend-engineer.
- `packages/shared/` package.json + workspace scripts → web/backend co-owners.
- `firestore/` rules implementation beyond the lock-everything stub → backend-engineer (Phase 3).
- Real composite indexes → backend-engineer (Phase 3).
- Real test scripts → all engineering agents in their own workspaces.

Until those land, `pnpm test` etc. pass vacuously (recursive over zero workspaces with that script).
