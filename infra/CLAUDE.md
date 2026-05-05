# infra — Claude Code guidance

Deploy automation, runbooks, CI workflows, monitoring config. Operational tooling for staging + prod.

**Owner agent:** `infra-engineer`. Touches every workspace at deploy time but doesn't author their code.

## Stack

- Firebase CLI (`firebase deploy`)
- gcloud CLI (project-level config, IAM, Secret Manager, Cloud Scheduler)
- Bash for deploy scripts
- GitHub Actions for CI (`.github/workflows/` symlinked or generated from `infra/ci/`)

## File layout

```
infra/
├── scripts/
│   ├── deploy-staging.sh
│   ├── deploy-prod.sh
│   ├── seed-staging.ts
│   └── stamp-version.js
├── runbooks/
│   ├── deploy.md
│   ├── restore.md
│   ├── observability.md
│   ├── provision-firebase-projects.md
│   ├── resend-api-key-setup.md
│   ├── custom-domain.md
│   └── granting-importer-sheet-access.md
├── ci/
│   └── workflows/
│       └── test.yml
├── monitoring/
│   ├── alerts/
│   └── metrics/
└── CLAUDE.md
```

## Conventions

- **All scripts have `--dry-run` mode** where they take destructive actions.
- **Runbooks are operator-readable.** Step-by-step, with copy-pasteable commands and expected outputs.
- **Two Firebase projects:** `kindoo-staging` (rehearsal) and `kindoo-prod` (live). Same code, different `--project` flag.
- **Secrets via Secret Manager + env-var injection.** Never in scripts, never in code.
- **CI deploys are not yet wired** — operator-triggered deploys via `pnpm deploy:staging` / `:prod`. CI gates tests + builds; prod deploys remain manual.

## Don't

- **Don't deploy to prod from a developer machine in the long run** — once stable, move to CI-driven deploys.
- **Don't store secrets in scripts or runbooks.** Use Secret Manager.
- **Don't write code that lives in `apps/web/`, `functions/`, or `firestore/`.** Those are owned elsewhere; `infra/` orchestrates their deploy.
- **Don't bypass dry-run on destructive scripts.**

## Boundaries

- **New deploy step** → update both `scripts/deploy-*.sh` AND `runbooks/deploy.md`.
- **CI workflow change** → tag all engineering agents in `TASKS.md` (affects everyone).
- **New Cloud Scheduler job, new Secret Manager secret, new IAM role** → document in the relevant runbook.

## Tests

- **Deploy scripts tested via `--dry-run` in CI** when reasonable.
