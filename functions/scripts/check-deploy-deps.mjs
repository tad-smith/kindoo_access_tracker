// Offline drift check for functions/deploy-lock/package-lock.json.
//
// Asserts the committed deploy lockfile's root dependency set still matches
// functions/package.json's `dependencies` (same names) at the versions
// pnpm-lock.yaml resolves (same versions CI exercises). Exit 0 = the tree
// Cloud Build would install is the tree this repo has tested.
//
// Assumes: nothing beyond the three committed files. No network, no
// registry lookup, no node_modules, no credentials. Deliberately never
// re-resolves — "regenerate and diff" would go red the moment any upstream
// publishes a new version, with no repo change behind it.
//
// Leaves behind: nothing. Read-only.
//
// Runs automatically inside `pnpm --filter @kindoo/functions build`, which
// means CI's "Build functions for emulator" step and `firebase deploy`'s
// predeploy hook both gate on it already. This CLI exists so the check can
// be run on its own, and so it can be wired as an explicit CI step later.

import {
  DEPLOY_LOCK_PATH,
  RELOCK_COMMAND,
  deployLockDeps,
  formatDrift,
  loadAndCheckDrift,
} from './deploy-deps.mjs';

let loaded;
try {
  loaded = await loadAndCheckDrift();
} catch (err) {
  console.error(`deploy-lock check failed: ${err.message}`);
  process.exit(1);
}

const { sourcePackage, pnpmDeps, deployLock, drift } = loaded;

if (drift.length > 0) {
  console.error(formatDrift(drift));
  process.exit(1);
}

const locked = deployLockDeps(deployLock);
const packageCount = Object.keys(deployLock.packages ?? {}).length - 1;

console.log('deploy-lock check: OK');
console.log(`  ${DEPLOY_LOCK_PATH.replace(/^.*\/(functions\/)/, '$1')}`);
console.log(`  lockfileVersion ${deployLock.lockfileVersion}, ${packageCount} packages pinned`);
console.log('');
console.log('  DEPENDENCY                 DECLARED      pnpm-lock     deploy-lock');
for (const name of Object.keys(locked).sort()) {
  console.log(
    `  ${name.padEnd(26)} ${(sourcePackage.dependencies[name] ?? '?').padEnd(13)} ` +
      `${(pnpmDeps[name]?.version ?? '?').padEnd(13)} ${locked[name]}`,
  );
}
console.log('');
console.log(`  Transitives are pinned by the lockfile itself. Regenerate with: ${RELOCK_COMMAND}`);
