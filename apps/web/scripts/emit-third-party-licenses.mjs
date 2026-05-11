// Emit `apps/web/dist/THIRD_PARTY_LICENSES.txt`.
//
// What it does:
//   - Parses the workspace pnpm-lock.yaml directly (no pnpm CLI shell-
//     out). Starting from the apps/web importer's `dependencies`
//     section, walks the runtime graph via the `snapshots:` block to
//     collect every transitive runtime package the SPA bundle depends
//     on.
//   - For each resolved (name, version) pair, locates the package on
//     disk in pnpm's flat store layout (node_modules/.pnpm/<sanitized-
//     snapshot-key>/node_modules/<scope>/<name>/), reads the package's
//     own package.json for license / repository / author metadata, and
//     reads LICENSE / LICENCE / COPYING and NOTICE files for verbatim
//     embedding.
//   - Concatenates per-package blocks into a single text file at
//     apps/web/dist/THIRD_PARTY_LICENSES.txt so Firebase Hosting serves
//     it at /THIRD_PARTY_LICENSES.txt.
//
// Compliance driver: Apache-2.0 deps in the runtime bundle (firebase,
// @firebase/*, etc.) require LICENSE + NOTICE preservation in the
// distributed artifact; MIT deps require copyright + license-notice
// preservation. A link to this file is surfaced from the SPA's nav-
// overlay footer (apps/web/src/components/layout/NavOverlay.tsx).
//
// Why a hand-rolled walk over pnpm-lock.yaml:
// Earlier revisions tried `license-checker-rseidelsohn` (misses pnpm's
// flat .pnpm store entirely; saw only 20 direct deps) and `pnpm
// licenses list` (works in isolation but pnpm 10 refuses the inner
// invocation when this script runs anywhere downstream of a `pnpm run`
// lifecycle — even invoked as a separate top-level node step inside
// the deploy script, the parent pnpm environment leaks down through
// the bash process chain and triggers ERR_PNPM_RECURSIVE_RUN_FIRST_
// FAIL with empty stderr). Parsing the lockfile and walking the .pnpm
// store directly removes the pnpm CLI from the path entirely; the
// emit step now needs only `node` and the on-disk install.
//
// Failure modes:
//   - Cannot find / parse pnpm-lock.yaml → exit 1.
//   - apps/web importer block missing → exit 1 (someone renamed or
//     removed the workspace).
//   - Output smaller than MIN_SIZE_BYTES → exit 1 (treats it as a
//     broken-artifact signal; better to fail the deploy than ship an
//     empty notices file).
//
// Invocation: plain `node`, never via `pnpm run …`. Each caller (CI
// `Emit THIRD_PARTY_LICENSES.txt` step, infra/scripts/deploy-
// staging.sh step 3a, infra/scripts/deploy-prod.sh step 3a) runs it as
//
//   node apps/web/scripts/emit-third-party-licenses.mjs
//
// from the repo root or any other cwd.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webRoot = resolve(__dirname, '..');
const repoRoot = resolve(__dirname, '..', '..', '..');
const lockPath = resolve(repoRoot, 'pnpm-lock.yaml');
const pnpmStoreDir = resolve(repoRoot, 'node_modules', '.pnpm');
const distDir = resolve(webRoot, 'dist');
const outFile = resolve(distDir, 'THIRD_PARTY_LICENSES.txt');

const WORKSPACE_IMPORTER_KEY = 'apps/web';

// Minimum reasonable size for the artifact. The SPA has ~25 direct
// runtime deps and ~120+ transitives; a healthy run produces well
// over 100 KB. Anything under 16 KB means the walk found almost no
// license text — fail rather than ship a broken artifact.
const MIN_SIZE_BYTES = 16 * 1024;

// Filenames the script will treat as a package's primary license text.
// Case-insensitive match on basename (with or without extension).
const LICENSE_FILE_CANDIDATES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENSE.markdown',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.md',
  'COPYING.txt',
];

const NOTICE_FILE_CANDIDATES = ['NOTICE', 'NOTICE.md', 'NOTICE.txt'];

function header() {
  const generatedAt = new Date().toISOString();
  return [
    '================================================================================',
    'THIRD-PARTY SOFTWARE NOTICES AND INFORMATION',
    '================================================================================',
    '',
    'This file is generated automatically at build time. It enumerates the',
    'third-party open-source packages bundled into the Stake Building Access',
    'web client (the SPA served at https://stakebuildingaccess.org), together',
    'with the license under which each package is distributed and the full',
    'text of that license (and, where applicable, the package NOTICE file).',
    '',
    `Generated: ${generatedAt}`,
    '',
    'Per-package blocks follow. Each block begins with a divider line and',
    'lists: package name and version, declared license, author / homepage',
    '(when available), the verbatim license text, and (for packages that',
    'ship a NOTICE file, e.g. Apache-2.0) the verbatim NOTICE text.',
    '',
    'If you redistribute the SPA you must preserve this file in the',
    'distributed artifact.',
    '',
    '================================================================================',
    '',
    '',
  ].join('\n');
}

// Build an index from "name@version" → { pkgDir, packageJson } by
// scanning every entry under node_modules/.pnpm/. Each store entry
// contains exactly one canonical package at:
//   <dirKey>/node_modules/<name>          (unscoped)
//   <dirKey>/node_modules/<scope>/<name>  (scoped)
//
// Scanning the disk directly sidesteps pnpm's depPathToFilename
// algorithm — that algorithm replaces `(` with `_` and `)` with `_`,
// but also content-hashes the suffix when the resulting name exceeds
// ~120 chars (e.g.,
// `@radix-ui+react-dismissable-layer@…___1028c2c…`). Reimplementing
// the hashing rule from scratch is brittle; reading the on-disk
// package.json is authoritative.
function buildStoreIndex() {
  const index = new Map();
  if (!existsSync(pnpmStoreDir)) return index;
  for (const dirKey of readdirSync(pnpmStoreDir)) {
    const nmDir = join(pnpmStoreDir, dirKey, 'node_modules');
    if (!existsSync(nmDir)) continue;
    let entries;
    try {
      entries = readdirSync(nmDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      // Scoped: descend one level.
      if (ent.name.startsWith('@')) {
        const scopeDir = join(nmDir, ent.name);
        let subEntries;
        try {
          subEntries = readdirSync(scopeDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          const pkgDir = join(scopeDir, sub.name);
          recordPackage(index, pkgDir);
        }
      } else {
        const pkgDir = join(nmDir, ent.name);
        recordPackage(index, pkgDir);
      }
    }
  }
  return index;
}

function recordPackage(index, pkgDir) {
  const pkgJson = readPackageJson(pkgDir);
  if (!pkgJson?.name || !pkgJson?.version) return;
  const key = `${pkgJson.name}@${pkgJson.version}`;
  // First write wins. Multiple store entries can carry the same
  // (name, version) under different peer-suffix dirs; pick any one
  // since the published files are identical.
  if (!index.has(key)) {
    index.set(key, { pkgDir, packageJson: pkgJson });
  }
}

function findFileMatching(dir, candidates) {
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const lowerSet = new Map();
  for (const name of entries) {
    lowerSet.set(name.toLowerCase(), name);
  }
  for (const cand of candidates) {
    const hit = lowerSet.get(cand.toLowerCase());
    if (hit) {
      return join(dir, hit);
    }
  }
  return null;
}

function readTextOrEmpty(path) {
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function readPackageJson(pkgDir) {
  const p = join(pkgDir, 'package.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Compose a single snapshot key from a dep name and the lockfile's
// versioned-ref string. The ref is either a plain version ("0.14.11")
// or a version with peer suffix ("2.11.1(@firebase/app@0.14.11)").
// In both cases the snapshot key is `<name>@<ref>`.
function makeSnapshotKey(name, ref) {
  return `${name}@${ref}`;
}

// Parse a snapshot key back into its base name + version. The base
// version strips the peer-suffix parenthetical, since the published
// version on disk does not carry peer info in its package.json.
function parseSnapshotKey(key) {
  // Find the '@' that separates name from version, then truncate at
  // the first '(' to drop the peer suffix. Scoped names start with '@'
  // so we cannot just search for the first '@'.
  const parenIdx = key.indexOf('(');
  const head = parenIdx === -1 ? key : key.slice(0, parenIdx);
  const atIdx = head.lastIndexOf('@');
  if (atIdx <= 0) return { name: head, version: '' };
  return { name: head.slice(0, atIdx), version: head.slice(atIdx + 1) };
}

// Walk the runtime graph rooted at apps/web's `dependencies` section.
// Returns a Map<"name@version", { name, version }> where the keys are
// the BASE package coordinates (peer-suffix stripped). The snapshot
// graph is fully traversed (so transitives are captured), but two
// keys differing only by peer suffix collapse to one (same package
// on disk, same license file).
function collectRuntimeGraph(lock) {
  const importers = lock.importers ?? {};
  const apps = importers[WORKSPACE_IMPORTER_KEY];
  if (!apps) {
    throw new Error(`pnpm-lock.yaml has no importer entry for '${WORKSPACE_IMPORTER_KEY}'`);
  }
  const directDeps = apps.dependencies ?? {};
  const snapshots = lock.snapshots ?? {};

  const visitedKeys = new Set();
  const result = new Map();
  const queue = [];

  for (const [name, info] of Object.entries(directDeps)) {
    const ref = info.version;
    if (!ref) continue;
    // Workspace links resolve as "link:../../packages/shared" — skip
    // those (own code, not third-party).
    if (typeof ref === 'string' && ref.startsWith('link:')) continue;
    queue.push(makeSnapshotKey(name, ref));
  }

  while (queue.length > 0) {
    const key = queue.shift();
    if (visitedKeys.has(key)) continue;
    visitedKeys.add(key);

    const { name, version } = parseSnapshotKey(key);
    if (name && version) {
      const baseKey = `${name}@${version}`;
      if (!result.has(baseKey)) result.set(baseKey, { name, version });
    }

    const snapshot = snapshots[key];
    if (!snapshot) continue;

    // dependencies + optionalDependencies both materialize on disk
    // (pnpm installs optionals by default for the current platform).
    // peerDependencies are typically already represented in the
    // snapshot key suffix; we do not enqueue them separately.
    const transitives = {
      ...(snapshot.dependencies ?? {}),
      ...(snapshot.optionalDependencies ?? {}),
    };
    for (const [depName, depRef] of Object.entries(transitives)) {
      if (typeof depRef !== 'string') continue;
      if (depRef.startsWith('link:')) continue;
      const childKey = makeSnapshotKey(depName, depRef);
      if (!visitedKeys.has(childKey)) {
        queue.push(childKey);
      }
    }
  }

  return result;
}

function formatEntry(entry, packageJson, licenseText, noticeText) {
  const lines = [];
  lines.push('--------------------------------------------------------------------------------');
  lines.push(`Package: ${entry.name}@${entry.version}`);

  // Resolve license. Prefer package.json `license` (modern); fall back
  // to `licenses[]` (old). Render "(unknown)" if neither is present.
  let license = '(unknown)';
  if (packageJson) {
    if (typeof packageJson.license === 'string') {
      license = packageJson.license;
    } else if (packageJson.license && typeof packageJson.license === 'object') {
      license = packageJson.license.type ?? packageJson.license.name ?? '(unknown)';
    } else if (Array.isArray(packageJson.licenses) && packageJson.licenses.length > 0) {
      license = packageJson.licenses.map((l) => l.type ?? l.name ?? l).join(', ');
    }
  }
  lines.push(`License: ${license}`);

  // Author can be a string or an {name, email, url} object.
  if (packageJson?.author) {
    const a = packageJson.author;
    if (typeof a === 'string') {
      lines.push(`Author: ${a}`);
    } else if (a.name) {
      lines.push(`Author: ${a.name}${a.email ? ` <${a.email}>` : ''}`);
    }
  }

  if (packageJson?.homepage) {
    lines.push(`Homepage: ${packageJson.homepage}`);
  } else if (packageJson?.repository) {
    const r = packageJson.repository;
    const url = typeof r === 'string' ? r : r.url;
    if (url) lines.push(`Repository: ${url}`);
  }

  if (packageJson?.description) {
    lines.push(`Description: ${packageJson.description}`);
  }

  lines.push('--------------------------------------------------------------------------------');
  lines.push('');

  if (licenseText) {
    lines.push(licenseText);
  } else {
    lines.push('(No license text file found in the published package.)');
  }
  lines.push('');

  if (noticeText) {
    lines.push('');
    lines.push('--- NOTICE ---');
    lines.push('');
    lines.push(noticeText);
    lines.push('');
  }

  lines.push('');
  return lines.join('\n');
}

function main() {
  console.log('[third-party-licenses] parsing pnpm-lock.yaml...');
  if (!existsSync(lockPath)) {
    console.error(`[third-party-licenses] cannot find lockfile at ${lockPath}`);
    process.exit(1);
  }
  let lock;
  try {
    lock = yaml.load(readFileSync(lockPath, 'utf8'));
  } catch (err) {
    console.error('[third-party-licenses] failed to parse pnpm-lock.yaml:', err.message);
    process.exit(1);
  }

  let graph;
  try {
    graph = collectRuntimeGraph(lock);
  } catch (err) {
    console.error('[third-party-licenses]', err.message);
    process.exit(1);
  }
  console.log(`[third-party-licenses] walked ${graph.size} runtime packages from lockfile.`);

  console.log('[third-party-licenses] indexing .pnpm store...');
  const storeIndex = buildStoreIndex();
  console.log(`[third-party-licenses] indexed ${storeIndex.size} installed packages on disk.`);

  // Stable sort for deterministic output: by name (case-insensitive),
  // then by version.
  const entries = [...graph.values()].sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    if (nameCmp !== 0) return nameCmp;
    return a.version.localeCompare(b.version);
  });

  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  let body = header();
  let onDisk = 0;
  let missing = 0;
  for (const entry of entries) {
    const baseKey = `${entry.name}@${entry.version}`;
    const hit = storeIndex.get(baseKey);
    if (!hit) {
      // Most common reason: platform-specific optional dep (e.g.,
      // @rollup/rollup-darwin-arm64 on a linux runner). Emit the
      // metadata we have so the artifact still acknowledges the
      // package, but skip the disk reads.
      missing++;
      body += formatEntry(entry, null, '', '');
      continue;
    }
    onDisk++;
    const licenseFile = findFileMatching(hit.pkgDir, LICENSE_FILE_CANDIDATES);
    const noticeFile = findFileMatching(hit.pkgDir, NOTICE_FILE_CANDIDATES);
    const licenseText = readTextOrEmpty(licenseFile);
    const noticeText = readTextOrEmpty(noticeFile);
    body += formatEntry(entry, hit.packageJson, licenseText, noticeText);
  }

  writeFileSync(outFile, body, 'utf8');

  const sizeBytes = Buffer.byteLength(body, 'utf8');
  console.log(
    `[third-party-licenses] wrote ${outFile} (${sizeBytes} bytes; ${onDisk} on disk, ${missing} missing).`,
  );

  if (sizeBytes < MIN_SIZE_BYTES) {
    console.error(
      `[third-party-licenses] artifact is suspiciously small (${sizeBytes} bytes < ${MIN_SIZE_BYTES} minimum). Failing build.`,
    );
    process.exit(1);
  }
}

main();
