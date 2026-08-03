# functions/deploy-lock/

`package-lock.json` here is the **dependency tree Cloud Build installs for the deployed Cloud Functions**. It is a build input, not a workspace — local development and CI install through `pnpm-lock.yaml` and never touch this file.

## Why it is not `functions/package-lock.json`

`firebase.json` sets `functions.source: "functions/lib"`, so `firebase deploy` uploads only `functions/lib` and **`lib/` is the package root Cloud Build installs from**. A lockfile at `functions/package-lock.json` would never be read. `functions/scripts/build.mjs` copies this file to `functions/lib/package-lock.json` on every build, beside the `lib/package.json` it generates; `firebase.json`'s functions `ignore` list excludes only `node_modules`, `.git`, `firebase-debug*.log` and `*.local`, so both upload.

The GCP Node.js buildpack runs `npm ci` when it finds a `package-lock.json` beside the manifest, which installs exactly what is pinned here.

## Why there is no `package.json` in this directory

There is exactly one producer of the deploy manifest: `functions/scripts/build.mjs`. It writes `functions/lib/package.json` with `name` / `version` / `engines` taken from `functions/package.json` and `dependencies` taken verbatim from this lockfile's root (`packages[""].dependencies`), so the manifest and the lockfile cannot disagree.

That matters more than it looks, because `npm ci`'s own sync check is one-directional. Measured against this artifact on npm 10.9.7:

| manifest vs lockfile | `npm ci` |
|---|---|
| manifest declares a dep the lockfile lacks | `EUSAGE`, exit 1 |
| lockfile version does not satisfy the manifest's range | `ERESOLVE`, exit 1 |
| manifest range merely looser than the pin (`^13.8.0` vs `13.8.0`) | passes — the pin satisfies the range |
| lockfile has a dep the manifest dropped | **passes, and omits it** |

The last row is the outage's exact shape: dropping `@firebase/app` from `functions/package.json` would leave a green `npm ci` that quietly ships a container missing the module. Only the offline drift check catches that, which is why it gates the build.

To see the manifest this lockfile pairs with: run `pnpm --filter @kindoo/functions build` and read `functions/lib/package.json`.

## Regenerating

Any time `functions/package.json` `dependencies` change — added, removed, or version-bumped — and after `pnpm install` has updated `pnpm-lock.yaml`:

```bash
pnpm deps:relock
```

Direct dependencies are pinned to the versions `pnpm-lock.yaml` resolves, so the deployed tree's direct versions are the ones CI exercises. Transitives are resolved fresh by npm; npm and pnpm resolve differently, so transitive parity with `pnpm-lock.yaml` is not expected (today `@firebase/database-compat` is 2.1.5 here and 2.1.3 under pnpm). The divergence is visible in this committed file rather than invented at deploy time.

The regeneration verifies itself: it runs a real `npm ci` against the new lockfile plus the three module loads that failed in the outage this file exists to prevent (`firebase-functions`, `firebase-functions/v1`, `firebase-admin/database`).

## Checking

```bash
pnpm deps:check
```

Offline. Asserts this lockfile's root dependency set matches `functions/package.json`'s `dependencies` at the versions `pnpm-lock.yaml` resolves. It never re-resolves, so an upstream publishing a new version cannot turn it red. `functions/scripts/build.mjs` runs the same check and fails the build — and therefore the `firebase deploy` predeploy hook — when it does not hold.

Background: `docs/TASKS.md` T-73, `infra/runbooks/deploy.md` "Deploy dependency pinning".
