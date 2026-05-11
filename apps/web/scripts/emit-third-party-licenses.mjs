// Postbuild step: emit `apps/web/dist/THIRD_PARTY_LICENSES.txt`.
//
// What it does:
//   - Runs `pnpm licenses list --prod --long --json` from the SPA
//     workspace, which walks the RUNTIME dependency graph (transitives
//     included; devDependencies and workspace-internal packages
//     excluded) via pnpm's own resolver. Each entry comes back with the
//     package path on disk, declared license, author/homepage, etc.
//   - For each entry the script reads the LICENSE file (any of LICENSE,
//     LICENSE.md, LICENSE.txt, LICENCE, COPYING, etc.) and the NOTICE
//     file (Apache-2.0 requirement) from the package directory and
//     embeds the verbatim text.
//   - Concatenates per-package blocks into a single text file at
//     apps/web/dist/THIRD_PARTY_LICENSES.txt so Firebase Hosting serves
//     it at /THIRD_PARTY_LICENSES.txt.
//
// Compliance driver: Apache-2.0 deps in the runtime bundle (TypeScript,
// firebase, googleapis, etc.) require LICENSE + NOTICE preservation in
// the distributed artifact; MIT deps require copyright + license-notice
// preservation. The link to this file is surfaced from the SPA's
// nav-overlay footer (apps/web/src/components/layout/NavOverlay.tsx).
//
// Why `pnpm licenses` over `license-checker-rseidelsohn`:
// license-checker uses `read-installed-packages` which walks
// `node_modules/<dep>/node_modules/<sub>`; that pattern misses pnpm's
// flat `.pnpm/` store layout and captures only the top-level direct
// deps (~20 packages), leaving 300+ transitives uncovered. pnpm's
// built-in licenses subcommand uses its own graph and resolves the full
// runtime tree (343 packages on a fresh install at this commit).
//
// Failure modes:
//   - pnpm subcommand errors → exit 1 (build fails).
//   - Output smaller than MIN_SIZE_BYTES → exit 1 (treats it as a
//     broken-artifact signal; better to fail the deploy than ship an
//     empty notices file).
//
// Invocation: chained after `vite build` via the `build` script in
// apps/web/package.json. Also invokable standalone:
//   node apps/web/scripts/emit-third-party-licenses.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webRoot = resolve(__dirname, '..');
const distDir = resolve(webRoot, 'dist');
const outFile = resolve(distDir, 'THIRD_PARTY_LICENSES.txt');

// Minimum reasonable size for the artifact. The SPA has ~25 direct
// runtime deps and ~340 transitives at this commit; a healthy run
// produces well over 100 KB. Anything under 16 KB means the walker
// found almost no license text — fail rather than ship a broken
// artifact.
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

function findFileMatching(dir, candidates) {
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  // Case-insensitive lookup. Prefer the order in `candidates` so
  // LICENSE wins over LICENSE.md when both exist (rare).
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

function runPnpmLicenses() {
  // `--filter @kindoo/web` scopes the walk to this workspace's runtime
  // graph only. Without it, pnpm operates recursively across the whole
  // monorepo and pulls in server-side deps (firebase-admin, etc.) that
  // do not ship to the SPA. Run from the repo root via that filter so
  // pnpm reads the correct workspace boundaries.
  const result = spawnSync(
    'pnpm',
    ['--filter', '@kindoo/web', 'licenses', 'list', '--prod', '--long', '--json'],
    {
      cwd: webRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `pnpm licenses list exited with status ${result.status}. stderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}

function flatten(licensesByType) {
  // pnpm groups by license string. Flatten to a single list of entries.
  // Each entry has: name, versions[], paths[], license, author, homepage, description.
  // A package with multiple installed versions has one entry covering all of them.
  const entries = [];
  for (const [licenseKey, group] of Object.entries(licensesByType)) {
    for (const item of group) {
      entries.push({
        name: item.name,
        versions: item.versions ?? [],
        paths: item.paths ?? [],
        license: item.license ?? licenseKey,
        author: item.author ?? '',
        homepage: item.homepage ?? '',
        description: item.description ?? '',
      });
    }
  }
  // Sort case-insensitively by name then by first version, so the
  // output is deterministic across runs.
  entries.sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    if (nameCmp !== 0) return nameCmp;
    const av = a.versions[0] ?? '';
    const bv = b.versions[0] ?? '';
    return av.localeCompare(bv);
  });
  return entries;
}

function formatEntry(entry) {
  const lines = [];
  lines.push('--------------------------------------------------------------------------------');
  const versionLabel = entry.versions.length > 0 ? entry.versions.join(', ') : '(unknown)';
  lines.push(`Package: ${entry.name}@${versionLabel}`);
  lines.push(`License: ${entry.license}`);
  if (entry.author) {
    lines.push(`Author: ${entry.author}`);
  }
  if (entry.homepage) {
    lines.push(`Homepage: ${entry.homepage}`);
  }
  if (entry.description) {
    lines.push(`Description: ${entry.description}`);
  }
  lines.push('--------------------------------------------------------------------------------');
  lines.push('');

  // Pull LICENSE text from the first path that has one. Most packages
  // ship one install per (name, version) so this is usually a single
  // lookup; we union the path list defensively in case pnpm reports
  // multiple peer-resolved copies and only some of them carry the file.
  let licenseText = '';
  let noticeText = '';
  for (const pkgPath of entry.paths) {
    if (!licenseText) {
      const licenseFile = findFileMatching(pkgPath, LICENSE_FILE_CANDIDATES);
      licenseText = readTextOrEmpty(licenseFile);
    }
    if (!noticeText) {
      const noticeFile = findFileMatching(pkgPath, NOTICE_FILE_CANDIDATES);
      noticeText = readTextOrEmpty(noticeFile);
    }
    if (licenseText && noticeText) break;
  }

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
  console.log('[third-party-licenses] walking runtime dependency tree via pnpm licenses...');
  let grouped;
  try {
    grouped = runPnpmLicenses();
  } catch (err) {
    console.error('[third-party-licenses] pnpm licenses list failed:', err.message);
    process.exit(1);
  }

  const entries = flatten(grouped);
  console.log(`[third-party-licenses] found ${entries.length} runtime packages.`);

  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  let body = header();
  for (const entry of entries) {
    body += formatEntry(entry);
  }

  writeFileSync(outFile, body, 'utf8');

  const sizeBytes = Buffer.byteLength(body, 'utf8');
  console.log(`[third-party-licenses] wrote ${outFile} (${sizeBytes} bytes).`);

  if (sizeBytes < MIN_SIZE_BYTES) {
    console.error(
      `[third-party-licenses] artifact is suspiciously small (${sizeBytes} bytes < ${MIN_SIZE_BYTES} minimum). Failing build.`,
    );
    process.exit(1);
  }
}

main();
