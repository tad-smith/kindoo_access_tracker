// Sync the end-user help guides from their source of truth in
// `docs/user-guide/` into the SPA's `public/help/` so Firebase Hosting
// serves them as real static files at stable external URLs:
//
//   docs/user-guide/creating-requests.html → public/help/requesting-access.html
//   docs/user-guide/kindoo-managers.html   → public/help/kindoo-manager-guide.html
//   docs/user-guide/img/                   → public/help/img/
//
// The guides reference screenshots with relative `img/...` paths, so both
// HTML files served at `/help/*.html` resolve images to `/help/img/...` —
// shared, no path rewriting.
//
// `public/help/` is generated output (gitignored). This module's
// `syncHelp()` runs from the `kindoo:sync-help` Vite plugin
// (`vite.config.ts`) on every build/dev `buildStart`, so it is
// mode-independent — `build`, `build:staging`, `build:prod`, `dev`,
// preview's build, and the e2e build all populate `public/help/`
// regardless of which npm script wraps the Vite invocation. A thin CLI
// wrapper below keeps `pnpm sync-help` working standalone.
//
// Node ESM, zero new dependencies — only `node:fs` / `node:path`.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, '..');
const repoRoot = resolve(webRoot, '../..');

const srcDir = resolve(repoRoot, 'docs/user-guide');
const outDir = resolve(webRoot, 'public/help');

// HTML source → served filename. The served names are the stable external
// URLs (`/help/requesting-access.html`, `/help/kindoo-manager-guide.html`);
// keep them decoupled from the source filenames so the source can be
// renamed without breaking links.
const htmlFiles = [
  ['creating-requests.html', 'requesting-access.html'],
  ['kindoo-managers.html', 'kindoo-manager-guide.html'],
];

/**
 * Copy the guides + shared `img/` into `public/help/`. Starts from a
 * clean output so a removed source file or image doesn't linger in the
 * served copy. Idempotent.
 */
export function syncHelp() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const [src, dest] of htmlFiles) {
    cpSync(resolve(srcDir, src), resolve(outDir, dest));
  }

  cpSync(resolve(srcDir, 'img'), resolve(outDir, 'img'), { recursive: true });

  return { count: htmlFiles.length, outDir };
}

// CLI wrapper: `node scripts/sync-help.mjs` / `pnpm sync-help`. Only runs
// the sync when invoked directly, not when imported by `vite.config.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { count, outDir: out } = syncHelp();
  console.log(`[sync-help] wrote ${count} guides + img/ to ${out}`);
}
