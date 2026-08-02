// Build script for Cloud Functions deploy artifact.
//
// Produces functions/lib/index.js (bundled) + functions/lib/package.json
// (clean, no workspace deps) + functions/lib/package-lock.json (copied
// from functions/deploy-lock/). firebase.json points at functions/lib/ as
// the deploy source, so lib/ is the package root Cloud Build installs
// from — no `workspace:*` for npm to choke on, and no unpinned ranges for
// it to re-resolve.
//
// Why bundling: pnpm's `workspace:*` protocol isn't understood by npm,
// which Cloud Build uses regardless of the local package manager.
// esbuild inlines @kindoo/shared into lib/index.js; firebase-admin and
// firebase-functions stay external (Cloud Build installs them via the
// generated lib/package.json).
//
// Why the lockfile (T-73): the GCP Node.js buildpack runs `npm ci` when it
// finds a package-lock.json beside the manifest, so the deployed tree is
// exactly the committed one. Without it every range re-resolved at deploy
// time — which took prod down once, when npm skipped @firebase/app (an
// optional peer of @firebase/database-compat) and all 24 functions died at
// container start. lib/package.json's `dependencies` are read straight out
// of the lockfile's root entry, so the manifest and the lockfile cannot
// disagree by construction — `npm ci` refuses a lockfile that does not
// cover its manifest, but it silently prunes the reverse case, so relying
// on its check alone would not be enough. The drift check below is what
// keeps the lockfile honest against functions/package.json.
// See functions/scripts/deploy-deps.mjs.
//
// Env files: firebase.json's `source: functions/lib` also makes lib/ the
// directory Firebase CLI reads `.env.<projectId>` from when resolving
// `defineString` params. Every build copies `.env.*` from functions/
// into lib/ unconditionally — source is the single source of truth.
// (Earlier no-overwrite behaviour was too defensive: a stale empty
// lib/.env.<projectId> from a CLI prompt would silently shadow the
// real source value.)

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEPLOY_LOCK_PATH,
  FUNCTIONS_ROOT,
  LIB_DIR,
  buildDeployManifest,
  deployLockDeps,
  formatDrift,
  loadAndCheckDrift,
} from './deploy-deps.mjs';

// Gate the build on the deploy lockfile being in step with
// functions/package.json. Failing here is the point: this script runs from
// firebase.json's predeploy hook, so a stale lockfile stops the deploy
// instead of shipping an untested tree (or blowing up inside Cloud Build's
// `npm ci`, where the error is far less legible).
const { sourcePackage: src, deployLock, drift } = await loadAndCheckDrift();
if (drift.length > 0) {
  console.error(formatDrift(drift));
  process.exit(1);
}

// Real-npm runtime deps — these stay external in the bundle and get
// installed by Cloud Build from the copied lockfile. Versions come from
// the lockfile root so lib/package.json and lib/package-lock.json agree.
const runtimeDeps = deployLockDeps(deployLock);
const externalNames = Object.keys(runtimeDeps);

// esbuild externals match exact module names AND subpath imports
// (e.g. `firebase-admin/firestore` is matched by `firebase-admin`).
// Adding `<pkg>/*` explicitly is belt-and-suspenders.
const external = externalNames.flatMap((pkg) => [pkg, `${pkg}/*`]);

await fs.mkdir(LIB_DIR, { recursive: true });

await build({
  entryPoints: [path.join(FUNCTIONS_ROOT, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: path.join(LIB_DIR, 'index.js'),
  sourcemap: true,
  external,
  // ESM `import` of CJS packages (firebase-admin) works at runtime via
  // Node's interop, but esbuild needs to know we're producing ESM.
  banner: {
    // Node 22 ESM doesn't expose require(); rare CJS-only deps that
    // need it pull in this shim. Harmless if unused.
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// Generate the deploy package.json. Only runtime deps, at the exact
// versions the lockfile pins; no workspace deps, no devDeps. main:
// index.js (relative to lib/, since firebase.json's `source: functions/lib`
// makes lib/ the package root for Cloud Build).
const deployPackage = buildDeployManifest(src, runtimeDeps);

await fs.writeFile(
  path.join(LIB_DIR, 'package.json'),
  JSON.stringify(deployPackage, null, 2) + '\n',
  'utf-8',
);

// Copy the committed lockfile in beside it. firebase.json's functions
// `ignore` list excludes node_modules / .git / firebase-debug logs /
// *.local and nothing else, so this file uploads with the rest of lib/.
await fs.copyFile(DEPLOY_LOCK_PATH, path.join(LIB_DIR, 'package-lock.json'));

// Symlink lib/node_modules → ../node_modules so the local emulator can
// resolve firebase-functions / firebase-admin. Cloud Build doesn't
// upload this symlink (firebase.json's `ignore: ["node_modules"]`
// excludes it) and installs into an empty tree from the copied
// package.json + package-lock.json pair.
const linkPath = path.join(LIB_DIR, 'node_modules');
try {
  const stat = await fs.lstat(linkPath);
  if (stat.isSymbolicLink() || stat.isDirectory()) {
    await fs.rm(linkPath, { recursive: true, force: true });
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
await fs.symlink('../node_modules', linkPath, 'dir');

// Copy .env.* files from functions/ → functions/lib/ so Firebase CLI
// (which reads them from `source` = functions/lib/) picks up values
// maintained in source. Source is authoritative: every build
// overwrites lib/.env.<project> from functions/.env.<project> so
// stale values (including empty placeholders the CLI's interactive
// prompt may have stashed) can't poison the deploy artifact.
//
// Workflow: if Firebase CLI prompts on first deploy and writes the
// answer into lib/.env.<project>, copy that value into the matching
// functions/.env.<project> immediately so the next build preserves it.
const sourceEntries = await fs.readdir(FUNCTIONS_ROOT, { withFileTypes: true });
const envFiles = sourceEntries
  .filter((e) => e.isFile() && e.name.startsWith('.env.'))
  .map((e) => e.name);
const copiedEnv = [];
for (const name of envFiles) {
  await fs.copyFile(path.join(FUNCTIONS_ROOT, name), path.join(LIB_DIR, name));
  copiedEnv.push(name);
}

const libRel = path.relative(FUNCTIONS_ROOT, LIB_DIR);
console.log(`Built ${libRel}/index.js + package.json + package-lock.json`);
console.log(`Symlinked ${libRel}/node_modules → ../node_modules`);
console.log(
  `External (Cloud Build \`npm ci\` installs): ${externalNames
    .map((name) => `${name}@${runtimeDeps[name]}`)
    .join(', ')}`,
);
if (copiedEnv.length > 0) {
  console.log(`Copied env files: ${copiedEnv.join(', ')}`);
}
