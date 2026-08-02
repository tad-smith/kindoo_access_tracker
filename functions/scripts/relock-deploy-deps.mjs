// Regenerates functions/deploy-lock/package-lock.json — the lockfile
// Cloud Build installs the deployed functions from.
//
// Run this any time functions/package.json `dependencies` change (add,
// remove, or version bump), after `pnpm install` has updated pnpm-lock.yaml.
// Nothing else needs it: this is not a routine step and deliberately does
// not run on every build. `pnpm --filter @kindoo/functions deps:check`
// (also run inside every build) tells you when it IS needed.
//
// Assumes: `pnpm install` has already run, so pnpm-lock.yaml carries the
// versions local dev + CI exercise. Assumes network access to the npm
// registry. Assumes npm >= 9 on PATH.
//
// What it does:
//   1. Pins each direct dependency to the version pnpm-lock.yaml resolves,
//      so the deployed tree's direct versions match what CI tests.
//   2. Resolves the full transitive tree with `npm install --package-lock-only`
//      in a temp dir. Metadata-only resolution, so the result is
//      platform-independent — a real install on macOS can prune optional
//      platform packages that linux/x64 Cloud Build needs.
//   3. Verifies the result with a real `npm ci` plus the three requires that
//      failed in the outage this exists to prevent.
//   4. Copies the lockfile into functions/deploy-lock/.
//
// Leaves behind: functions/deploy-lock/package-lock.json (overwritten).
// The temp dir is removed unless --keep is passed.
//
// Flags: --dry-run (resolve + verify, do not write the repo file)
//        --keep    (leave the temp dir in place for inspection)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEPLOY_LOCK_DIR,
  DEPLOY_LOCK_PATH,
  RELOCK_COMMAND,
  buildDeployManifest,
  deployLockDeps,
  pinnedDirectDeps,
  readPnpmFunctionsDeps,
  readSourcePackage,
} from './deploy-deps.mjs';

// The exact three module loads that failed in production when npm skipped
// @firebase/app (an optional peer of @firebase/database-compat). Cloud
// Functions loads the whole of index.js in every container, and the 1st-gen
// onAuthUserCreate pulls firebase-functions/v1, which eagerly loads
// firebase-admin/database — so one missing transitive took all 24 functions
// down at container start.
const SMOKE_REQUIRES = ['firebase-functions', 'firebase-functions/v1', 'firebase-admin/database'];

// Transitives worth printing. @firebase/database-compat + @firebase/app are
// the outage pair; the rest are the heavy runtime deps most likely to move.
const REPORT_TRANSITIVES = ['@firebase/database-compat', '@firebase/app', '@grpc/grpc-js'];

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const keep = argv.includes('--keep');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`\`${command} ${args.join(' ')}\` exited ${result.status}`);
  }
}

async function installedVersion(dir, name) {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, 'node_modules', name, 'package.json'), 'utf-8'),
    );
    return manifest.version;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const sourcePackage = await readSourcePackage();
const pnpmDeps = await readPnpmFunctionsDeps();
const { pinned, problems } = pinnedDirectDeps(sourcePackage, pnpmDeps);

if (problems.length > 0) {
  console.error('Cannot regenerate the deploy lockfile:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const manifest = buildDeployManifest(sourcePackage, pinned);

console.log('Pinning direct dependencies to their pnpm-lock.yaml versions:');
for (const [name, version] of Object.entries(manifest.dependencies)) {
  console.log(`  ${name.padEnd(24)} ${sourcePackage.dependencies[name].padEnd(12)} -> ${version}`);
}
console.log('');

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindoo-deploy-lock-'));
try {
  await fs.writeFile(
    path.join(workDir, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );

  console.log(`Resolving the transitive tree in ${workDir} ...`);
  run('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], workDir);

  const lock = JSON.parse(await fs.readFile(path.join(workDir, 'package-lock.json'), 'utf-8'));
  const lockedDirect = deployLockDeps(lock);
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (lockedDirect[name] !== version) {
      throw new Error(
        `npm wrote root dependency ${name}="${lockedDirect[name]}" for a manifest declaring ` +
          `"${version}". build.mjs derives lib/package.json from this entry, so they must agree.`,
      );
    }
  }

  console.log('\nVerifying with a real `npm ci` ...');
  run('npm', ['ci', '--no-audit', '--no-fund'], workDir);

  for (const specifier of SMOKE_REQUIRES) {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(specifier)})`], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(
        `require('${specifier}') failed against the freshly locked tree:\n${result.stderr}`,
      );
    }
    console.log(`  require('${specifier}') OK`);
  }

  console.log('\nResolved versions:');
  const reported = new Set([...Object.keys(manifest.dependencies), ...REPORT_TRANSITIVES]);
  for (const name of reported) {
    const version = await installedVersion(workDir, name);
    console.log(`  ${name.padEnd(28)} ${version ?? '(absent)'}`);
  }

  // Always label the target repo-relative — pnpm runs this with cwd set to
  // functions/, so a cwd-relative path reads wrong from the repo root.
  const packageCount = Object.keys(lock.packages).length - 1;
  if (dryRun) {
    console.log('\n[dry-run] not writing functions/deploy-lock/package-lock.json');
  } else {
    await fs.mkdir(DEPLOY_LOCK_DIR, { recursive: true });
    await fs.copyFile(path.join(workDir, 'package-lock.json'), DEPLOY_LOCK_PATH);
    console.log(`\nWrote functions/deploy-lock/package-lock.json (${packageCount} packages).`);
    console.log('Commit it alongside the functions/package.json change that prompted this run.');
  }
} finally {
  if (keep) {
    console.log(`\n[--keep] temp dir left at ${workDir}`);
  } else {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

if (dryRun) {
  console.log(`\nRe-run without --dry-run to update the lockfile:  ${RELOCK_COMMAND}`);
}
