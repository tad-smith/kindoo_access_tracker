// Build script for Cloud Functions deploy artifact.
//
// Produces functions/lib/index.js (bundled) + functions/lib/package.json
// (clean, no workspace deps). firebase.json points at functions/lib/ as
// the deploy source, so Cloud Build runs `npm install` on the clean
// package.json — no `workspace:*` for npm to choke on.
//
// Why bundling: pnpm's `workspace:*` protocol isn't understood by npm,
// which Cloud Build uses regardless of the local package manager.
// esbuild inlines @kindoo/shared into lib/index.js; firebase-admin and
// firebase-functions stay external (Cloud Build installs them via the
// generated lib/package.json).

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FUNCTIONS_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIB_DIR = path.join(FUNCTIONS_ROOT, 'lib');

// Read the source package.json to derive the deploy package.json's deps.
const src = JSON.parse(
  await fs.readFile(path.join(FUNCTIONS_ROOT, 'package.json'), 'utf-8'),
);

// Real-npm runtime deps — these stay external in the bundle and get
// installed by Cloud Build via the generated lib/package.json.
const runtimeDeps = src.dependencies ?? {};
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

// Generate the deploy package.json. Only runtime deps; no workspace deps,
// no devDeps. main: index.js (relative to lib/, since firebase.json's
// `source: functions/lib` makes lib/ the package root for Cloud Build).
const deployPackage = {
  name: src.name,
  version: src.version,
  private: true,
  type: 'module',
  main: 'index.js',
  engines: src.engines ?? { node: '22' },
  dependencies: runtimeDeps,
};

await fs.writeFile(
  path.join(LIB_DIR, 'package.json'),
  JSON.stringify(deployPackage, null, 2) + '\n',
  'utf-8',
);

// Symlink lib/node_modules → ../node_modules so the local emulator can
// resolve firebase-functions / firebase-admin. Cloud Build doesn't
// upload this symlink (firebase.json's `ignore: ["node_modules"]`
// excludes it) and runs `npm install` against lib/package.json fresh.
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

console.log(`Built ${path.relative(FUNCTIONS_ROOT, LIB_DIR)}/index.js + package.json`);
console.log(`Symlinked ${path.relative(FUNCTIONS_ROOT, LIB_DIR)}/node_modules → ../node_modules`);
console.log(`External (Cloud Build installs): ${externalNames.join(', ')}`);
