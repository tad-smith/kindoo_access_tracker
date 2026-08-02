// Shared logic for the dependency tree Cloud Build installs.
//
// What it does: derives the deploy manifest (functions/lib/package.json)
// and the drift check that keeps functions/deploy-lock/package-lock.json
// honest. Imported by build.mjs, relock-deploy-deps.mjs and
// check-deploy-deps.mjs — the three places that touch deploy deps.
//
// Why any of this exists. `firebase deploy` uploads only functions/lib
// (firebase.json: `source: "functions/lib"`), so lib/ is the package root
// Cloud Build installs from. Before T-73 no lockfile reached that install,
// pnpm-lock.yaml was never consulted, and every range in the generated
// manifest re-resolved at deploy time — shipping a tree nothing had
// tested. That took prod down once: @firebase/database-compat 2.1.5
// declares @firebase/app as an OPTIONAL peer, npm skipped it, and all 24
// functions died at container start on `Cannot find module '@firebase/app'`.
// Pinning direct deps alone would not have caught it; the break was
// transitive, so only a full lockfile closes the class.
//
// The three files and how they relate:
//
//   functions/package.json           declared ranges (^13.8.0). Source of
//                                    truth for WHICH packages we depend on.
//   pnpm-lock.yaml                   what local dev + CI actually install.
//                                    Source of truth for direct VERSIONS.
//   functions/deploy-lock/           npm lockfile for the deploy manifest.
//     package-lock.json              Source of truth for TRANSITIVES.
//
// Direction of derivation is one-way, which is what makes the whole thing
// checkable offline:
//
//   package.json (names+ranges) ─┐
//                                ├─> pinned deps ─> deploy-lock ─> lib/package.json
//   pnpm-lock.yaml (versions) ───┘
//
// build.mjs writes lib/package.json's `dependencies` straight out of the
// deploy lockfile's root entry, so the manifest and the lockfile can never
// disagree. That matters because the GCP Node.js buildpack runs `npm ci`
// when it finds a package-lock.json, and `npm ci` refuses a lockfile that
// does not cover the manifest.
//
// `npm ci`'s own check is NOT a substitute for the drift check below.
// Measured against this artifact (npm 10.9.7):
//
//   manifest declares a dep the lockfile lacks      -> EUSAGE, exit 1
//   lockfile version does not satisfy the range     -> ERESOLVE, exit 1
//   manifest range merely looser than the pin       -> passes (satisfies)
//   lockfile has a dep the manifest dropped         -> passes, dep OMITTED
//
// That last row is the dangerous one, and it is exactly the outage's shape:
// dropping @firebase/app from functions/package.json would leave a green
// `npm ci` that quietly ships a container missing the module. Only the
// offline drift check catches it, and only before the artifact is built.
//
// Leaves behind: nothing. Pure functions plus file reads.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FUNCTIONS_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.dirname(FUNCTIONS_ROOT);
export const LIB_DIR = path.join(FUNCTIONS_ROOT, 'lib');
export const DEPLOY_LOCK_DIR = path.join(FUNCTIONS_ROOT, 'deploy-lock');
export const DEPLOY_LOCK_PATH = path.join(DEPLOY_LOCK_DIR, 'package-lock.json');
export const PNPM_LOCK_PATH = path.join(REPO_ROOT, 'pnpm-lock.yaml');
export const SOURCE_PACKAGE_PATH = path.join(FUNCTIONS_ROOT, 'package.json');

/** Command an operator runs to bring the deploy lockfile back in step. */
export const RELOCK_COMMAND = 'pnpm --filter @kindoo/functions deps:relock';

/** npm 7+ writes lockfileVersion 2; npm 9+ writes 3. `npm ci` needs >= 2. */
const MIN_LOCKFILE_VERSION = 2;

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

export async function readSourcePackage() {
  return readJson(SOURCE_PACKAGE_PATH);
}

export async function readDeployLock() {
  try {
    return await readJson(DEPLOY_LOCK_PATH);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Missing deploy lockfile at functions/deploy-lock/package-lock.json.\n` +
          `Generate it with:  ${RELOCK_COMMAND}`,
      );
    }
    throw err;
  }
}

/**
 * Root ("") entry of an npm lockfile — mirrors the manifest it was
 * generated from, so its `dependencies` are the declared specs. We
 * generate against exact versions, so these ARE the pinned versions.
 */
export function deployLockDeps(lock) {
  const root = lock?.packages?.[''];
  if (!root) {
    throw new Error(
      `functions/deploy-lock/package-lock.json has no root ("") entry — it is not an ` +
        `npm lockfileVersion 2+ file. Regenerate with:  ${RELOCK_COMMAND}`,
    );
  }
  return root.dependencies ?? {};
}

/**
 * Direct dependencies of the `functions` importer in pnpm-lock.yaml.
 *
 * Hand-parsed rather than pulled through a YAML dependency: this runs from
 * build.mjs on every build (including inside `firebase deploy`'s predeploy
 * hook) and adding a runtime dep to the build path for one nested lookup is
 * not worth it. The slice we read is a fixed-indentation block:
 *
 *   importers:
 *     functions:
 *       dependencies:
 *         firebase-admin:
 *           specifier: ^13.8.0
 *           version: 13.8.0
 *
 * Anything structural we do not recognise throws rather than returning a
 * partial map — a silently-empty result would make the drift check vacuous.
 */
export function parsePnpmFunctionsDeps(text) {
  const versionLine = text.split('\n').find((l) => l.startsWith('lockfileVersion:'));
  const lockfileVersion = versionLine?.split(':')[1]?.trim().replace(/['"]/g, '');
  if (!lockfileVersion?.startsWith('9.')) {
    throw new Error(
      `pnpm-lock.yaml is lockfileVersion ${lockfileVersion ?? '(unknown)'}; the parser in ` +
        `functions/scripts/deploy-deps.mjs only understands 9.x. Update parsePnpmFunctionsDeps().`,
    );
  }

  const deps = {};
  let inImporters = false;
  let inFunctions = false;
  let inDependencies = false;
  let current = null;

  for (const line of text.split('\n')) {
    if (line === 'importers:') {
      inImporters = true;
      continue;
    }
    if (!inImporters) continue;
    if (line.trim() === '') continue;
    // A new top-level key ends the importers section.
    if (/^\S/.test(line)) break;

    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 2) {
      inFunctions = body === 'functions:';
      inDependencies = false;
      current = null;
      continue;
    }
    if (!inFunctions) continue;

    if (indent === 4) {
      // `dependencies:` only — devDependencies never reach the deploy tree.
      inDependencies = body === 'dependencies:';
      current = null;
      continue;
    }
    if (!inDependencies) continue;

    if (indent === 6) {
      current = unquote(body.replace(/:$/, ''));
      deps[current] = { specifier: null, version: null };
      continue;
    }

    if (indent === 8 && current) {
      const match = body.match(/^(specifier|version):\s*(.+)$/);
      if (!match) continue;
      const value = unquote(match[2].trim());
      // pnpm suffixes resolved versions with their peer context, e.g.
      // `7.2.5(firebase-admin@13.8.0)`. npm has no such notion.
      deps[current][match[1]] = match[1] === 'version' ? value.split('(')[0] : value;
    }
  }

  if (Object.keys(deps).length === 0) {
    throw new Error(
      `Found no dependencies under importers > functions in pnpm-lock.yaml. Either the ` +
        `functions workspace lost its dependencies or the lockfile layout changed — fix ` +
        `parsePnpmFunctionsDeps() in functions/scripts/deploy-deps.mjs.`,
    );
  }
  return deps;
}

export async function readPnpmFunctionsDeps() {
  return parsePnpmFunctionsDeps(await fs.readFile(PNPM_LOCK_PATH, 'utf-8'));
}

function unquote(value) {
  return value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

/**
 * The exact versions the deploy tree should pin its direct deps to: the
 * names+ranges from functions/package.json, resolved through pnpm-lock.yaml
 * so the deploy artifact carries the versions CI actually exercises.
 * Returns { pinned, problems }; `pinned` is only trustworthy when
 * `problems` is empty.
 */
export function pinnedDirectDeps(sourcePackage, pnpmDeps) {
  const declared = sourcePackage.dependencies ?? {};
  const problems = [];
  const pinned = {};

  for (const name of Object.keys(declared).sort()) {
    const entry = pnpmDeps[name];
    if (!entry) {
      problems.push(
        `${name} is a dependency of functions/package.json but absent from pnpm-lock.yaml. ` +
          `Run \`pnpm install\` first.`,
      );
      continue;
    }
    if (entry.specifier !== declared[name]) {
      problems.push(
        `${name}: functions/package.json declares "${declared[name]}" but pnpm-lock.yaml ` +
          `records specifier "${entry.specifier}". pnpm-lock.yaml is stale — run \`pnpm install\`.`,
      );
      continue;
    }
    if (!entry.version) {
      problems.push(`${name}: pnpm-lock.yaml has no resolved version. Run \`pnpm install\`.`);
      continue;
    }
    pinned[name] = entry.version;
  }

  for (const name of Object.keys(pnpmDeps).sort()) {
    if (!(name in declared)) {
      problems.push(
        `${name} is a direct dependency in pnpm-lock.yaml but not in functions/package.json. ` +
          `pnpm-lock.yaml is stale — run \`pnpm install\`.`,
      );
    }
  }

  return { pinned, problems };
}

/**
 * The manifest build.mjs writes to functions/lib/package.json. `deps` must
 * already be exact versions — callers pass either the pinned map (when
 * generating the lockfile) or the lockfile's own root deps (every build).
 */
export function buildDeployManifest(sourcePackage, deps) {
  return {
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: 'module',
    main: 'index.js',
    engines: sourcePackage.engines ?? { node: '22' },
    dependencies: Object.fromEntries(Object.keys(deps).sort().map((n) => [n, deps[n]])),
  };
}

/**
 * Offline drift check.
 *
 * Deliberately does NOT re-resolve anything. "Regenerate and diff" would
 * fail the moment any upstream publishes a new version, because regeneration
 * re-resolves against the live registry — a red check with no repo change
 * behind it. Every input here is a committed file, so an upstream release
 * cannot move any of them. What it catches is the real failure mode: someone
 * edits functions/package.json's dependencies (or `pnpm install` moves a
 * direct version) and forgets to regenerate the deploy lockfile.
 *
 * Returns an array of human-readable problems; empty means no drift.
 */
export function findDeployLockDrift({ sourcePackage, pnpmDeps, deployLock }) {
  const { pinned, problems } = pinnedDirectDeps(sourcePackage, pnpmDeps);
  if (problems.length > 0) return problems;

  const drift = [];

  const lockfileVersion = deployLock.lockfileVersion ?? 0;
  if (lockfileVersion < MIN_LOCKFILE_VERSION) {
    drift.push(
      `deploy-lock/package-lock.json is lockfileVersion ${lockfileVersion}; ` +
        `\`npm ci\` needs >= ${MIN_LOCKFILE_VERSION}.`,
    );
  }

  const locked = deployLockDeps(deployLock);

  for (const name of Object.keys(pinned)) {
    if (!(name in locked)) {
      drift.push(`${name} ${pinned[name]} is missing from the deploy lockfile.`);
    } else if (locked[name] !== pinned[name]) {
      drift.push(
        `${name}: deploy lockfile pins "${locked[name]}", pnpm-lock.yaml resolves ` +
          `"${pinned[name]}". The deploy tree would not match what CI exercises.`,
      );
    }
  }

  for (const name of Object.keys(locked)) {
    if (!(name in pinned)) {
      drift.push(
        `${name} is pinned in the deploy lockfile but is no longer a dependency of ` +
          `functions/package.json.`,
      );
    }
  }

  return drift;
}

/** One place that formats drift for both build.mjs and the CLI check. */
export function formatDrift(drift) {
  return [
    'Deploy lockfile is out of step with functions/package.json + pnpm-lock.yaml:',
    ...drift.map((d) => `  - ${d}`),
    '',
    `Fix:  ${RELOCK_COMMAND}`,
    '',
    'Cloud Build installs functions/lib from the copied lockfile, so shipping this as-is',
    'would either fail `npm ci` at deploy time or deploy a tree nothing has tested.',
  ].join('\n');
}

/** Reads all three inputs and returns the drift list. */
export async function loadAndCheckDrift() {
  const sourcePackage = await readSourcePackage();
  const pnpmDeps = await readPnpmFunctionsDeps();
  const deployLock = await readDeployLock();
  return {
    sourcePackage,
    pnpmDeps,
    deployLock,
    drift: findDeployLockDrift({ sourcePackage, pnpmDeps, deployLock }),
  };
}
