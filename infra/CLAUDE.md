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
│   ├── extension-deploy.md
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

## Cloud Functions deploy artifact

Cloud Build's `npm install` does not understand pnpm's `workspace:*` protocol, so the deploy artifact must not contain any workspace-protocol references. The repo handles this by bundling `@kindoo/shared` into the functions output and shipping a synthetic `package.json` that lists only real-npm runtime deps. See architecture decision **D12** for the rationale.

**Shape on disk.** `functions/scripts/build.mjs` is the single producer of the deploy tree:

- esbuild bundles `functions/src/index.ts` to `functions/lib/index.js` (ESM, `node22`), inlining `@kindoo/shared`. Runtime deps (`firebase-admin`, `firebase-functions`, `resend`) stay external — Cloud Build installs them via the generated manifest.
- The script writes `functions/lib/package.json` containing only `name`, `version`, `private`, `type: "module"`, `main: "index.js"`, `engines`, and the runtime deps copied verbatim from `functions/package.json`. No `@kindoo/shared` entry. No devDeps.
- The script symlinks `functions/lib/node_modules` to `../node_modules` so the local Functions emulator can resolve `firebase-admin` / `firebase-functions` against the workspace install. `firebase.json`'s `ignore: ["node_modules", ...]` excludes the symlink from the upload tarball, so Cloud Build sees an empty tree and runs `npm install` cleanly against `lib/package.json`.
- The script also copies any `functions/.env.*` files to `functions/lib/.env.*` unconditionally. Firebase CLI's `defineString` parameter resolution reads from the `source` directory (which is `functions/lib`), so source-of-truth env values must be propagated each build — overwrite is intentional, to avoid stale empty placeholders the CLI's interactive prompt may have written into `lib/`.

**Wiring.** `firebase.json` sets `"source": "functions/lib"` for the default codebase and `"predeploy": ["pnpm --filter @kindoo/functions build"]`. `functions/package.json` declares `@kindoo/shared` as a **devDependency** so esbuild can resolve it at build time without it leaking into the deploy manifest.

**What not to do.**

- Do **not** add `@kindoo/shared` as a regular `dependencies` entry in `functions/package.json`. Cloud Build will fail with `EUNSUPPORTEDPROTOCOL: workspace:`.
- Do **not** change `firebase.json`'s `functions.source` to `"functions"` (the workspace root) — same failure.
- Do **not** skip the predeploy hook on a manual `firebase deploy --only functions`. The upload is whatever currently lives in `functions/lib/`; a stale checkout deploys stale bytes.
- Do **not** drop the `lib/node_modules` symlink. The local emulator needs it to resolve runtime deps.

**Pointers.** `functions/scripts/build.mjs` for the implementation. `docs/architecture.md` D12 for the decision record. `docs/changelog/phase-2-auth-and-claims.md` "Deviations" section for the discovery trail (this approach was discovered when the first staging deploy in Phase 2 failed against `workspace:*`).

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
