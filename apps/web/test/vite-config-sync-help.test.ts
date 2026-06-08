// Regression guard for the help-guide sync (PR #233).
//
// Background: the static end-user guides live in `docs/user-guide/` and
// must be copied into `apps/web/public/help/` so Vite emits them into
// `dist/help/` and Firebase Hosting serves them as real files. Originally
// the copy ran only from the `prebuild`/`predev` npm hooks. `prebuild`
// fires for `pnpm build` but NOT for `pnpm build:staging` (there is no
// `prebuild:staging` hook), so the staging deploy — which runs
// `build:staging` — shipped an empty `dist/help/`, and Hosting's
// catch-all rewrite served the SPA shell ("Not Found") for every
// `/help/*.html`.
//
// The fix moves the sync into a Vite plugin (`kindoo:sync-help`) whose
// `buildStart` hook fires for EVERY Vite invocation regardless of the
// wrapping npm script, so no `build:*` variant can drop `/help/`. This
// test pins two halves of that contract:
//   1. the config registers the `kindoo:sync-help` plugin (text-level,
//      mirroring vite-config-pwa-denylist.test.ts — a functional eval of
//      the config is brittle: it loads env and instantiates the router /
//      PWA plugins), and
//   2. running its sync produces the real guide HTML (not the SPA shell).

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncHelp } from '../scripts/sync-help.mjs';

const CONFIG_PATH = resolve(__dirname, '..', 'vite.config.ts');

describe('vite.config.ts — help-guide sync plugin', () => {
  it('registers the kindoo:sync-help plugin in the plugins array', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    // The plugin factory is named and registered; both must be present so
    // the sync can never be dropped by a `build:*` mode variant again.
    expect(src).toContain("name: 'kindoo:sync-help'");
    expect(src).toContain('syncHelpPlugin()');
  });

  it('drives the sync from a buildStart hook (mode-independent, not a prebuild npm hook)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/buildStart\(\)\s*\{\s*syncHelp\(\);/);
  });
});

describe('syncHelp() — guide copy', () => {
  // syncHelp writes to the real `public/help/` (gitignored). Snapshot and
  // restore so the test leaves the working tree as it found it.
  let backup: string | null = null;
  const helpDir = resolve(__dirname, '..', 'public', 'help');

  beforeEach(() => {
    // Preserve any pre-existing built copy so we can restore it after.
    backup = mkdtempSync(resolve(tmpdir(), 'help-backup-'));
    if (existsSync(helpDir)) cpSync(helpDir, resolve(backup, 'help'), { recursive: true });
  });

  afterEach(() => {
    if (!backup) return;
    rmSync(helpDir, { recursive: true, force: true });
    const saved = resolve(backup, 'help');
    if (existsSync(saved)) cpSync(saved, helpDir, { recursive: true });
    rmSync(backup, { recursive: true, force: true });
    backup = null;
  });

  it('emits the real guide HTML, not the SPA shell', () => {
    const result = syncHelp();
    expect(result.count).toBe(2);

    const manager = readFileSync(resolve(helpDir, 'kindoo-manager-guide.html'), 'utf8');
    const requester = readFileSync(resolve(helpDir, 'requesting-access.html'), 'utf8');

    // Real guide markup — the SPA shell has neither of these and DOES
    // have an `id="root"` mount point.
    expect(manager).toContain('<h1>Kindoo Manager Guide</h1>');
    expect(requester).toContain('<h1>Requesting Building Access</h1>');
    expect(manager).not.toContain('id="root"');
    expect(requester).not.toContain('id="root"');
  });
});
