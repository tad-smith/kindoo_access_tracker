// MV3 manifest source. @crxjs/vite-plugin reads this and emits the
// final dist/manifest.json with bundled asset paths.
//
// Architecture: the panel is a content-script-injected slide-over on
// Kindoo pages, NOT a Chrome side panel. The service worker owns
// chrome.identity + Firebase Auth + the callable invocations; the
// content script posts messages via chrome.runtime.sendMessage.
//
// Kindoo runs across two origins confirmed by a live network capture:
//   - https://web.kindoo.tech/*         — the admin UI (where the
//     content script injects)
//   - https://service89.kindoo.tech/*   — the ASMX API endpoints
//
// host_permissions includes BOTH origins so v2 can `fetch()` the
// Kindoo API from the content script without triggering a Chrome Web
// Store re-review for a manifest change. v1 does not call the API;
// the listing in host_permissions is forward compatibility only.
//
// content_scripts.matches lists only the UI origin — the API host
// has no DOM to inject into.
//
// Per-env: the function form of defineManifest receives the active
// Vite mode. We swap the manifest `name`, `key` (which pins the
// extension ID), `icons`, and `oauth2.client_id` per env so the
// operator can load BOTH staging and production builds side-by-side
// in the same Chrome profile with stable IDs. See extension/CLAUDE.md
// "Per-env setup" for the keypair / GCP OAuth client flow.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineManifest } from '@crxjs/vite-plugin';
import { loadEnv } from 'vite';

const KINDOO_UI_ORIGIN = 'https://web.kindoo.tech/*';
const KINDOO_API_ORIGIN = 'https://service89.kindoo.tech/*';

const DEFAULT_NAME = 'Stake Building Access — Kindoo Helper';

// Extension root = parent of src/ where this file lives. loadEnv
// resolves .env.{mode} against this directory.
const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineManifest(({ mode }) => {
  const env = loadEnv(mode, EXTENSION_ROOT, 'VITE_');
  const isStaging = mode === 'staging';
  const name = env.VITE_EXTENSION_NAME || DEFAULT_NAME;
  const oauthClientId = env.VITE_GOOGLE_OAUTH_CLIENT_ID ?? '';
  const extensionKey = env.VITE_EXTENSION_KEY ?? '';

  const iconSuffix = isStaging ? '-staging' : '';
  const icons = {
    '16': `icons/icon-16${iconSuffix}.png`,
    '48': `icons/icon-48${iconSuffix}.png`,
    '128': `icons/icon-128${iconSuffix}.png`,
  };

  return {
    manifest_version: 3,
    name,
    short_name: 'SBA Helper',
    description:
      'Surfaces pending Stake Building Access requests in a slide-over panel on Kindoo so a Kindoo Manager can work the queue alongside the Kindoo admin UI.',
    version: '0.4.5',
    // `key` pins the extension ID across rebuilds when set. Omit
    // when unset so Chrome auto-assigns a random ID for first-time
    // dev before the operator generates a keypair.
    ...(extensionKey ? { key: extensionKey } : {}),
    icons,
    action: {
      // Action click is wired in the SW to post a toggle message to
      // the active tab; the CS opens / closes the slide-over.
      default_title: 'Toggle SBA helper panel',
    },
    permissions: ['identity', 'identity.email', 'storage'],
    host_permissions: [KINDOO_UI_ORIGIN, KINDOO_API_ORIGIN],
    background: {
      // Entry filenames are distinct (service-worker.ts vs
      // content-script.ts) instead of both `index.ts`. @crxjs's chunk
      // naming collides on same-named entries and cross-wires the
      // loader scripts, which manifested as the SW loader importing
      // the content-script bundle (React → `document is not defined`).
      service_worker: 'src/background/service-worker.ts',
      type: 'module',
    },
    content_scripts: [
      {
        matches: [KINDOO_UI_ORIGIN],
        js: ['src/content/content-script.ts'],
        run_at: 'document_idle',
      },
    ],
    // chrome.identity exchanges this OAuth client ID for a Google
    // access token; we then mint a Firebase credential from it. The
    // ID is env-specific because the GCP "Chrome app" client type
    // is bound to a single extension ID.
    oauth2: {
      client_id: oauthClientId,
      scopes: ['openid', 'email', 'profile'],
    },
  };
});
