// MV3 manifest source. @crxjs/vite-plugin reads this and emits the
// final dist/manifest.json with bundled asset paths.
//
// Architecture: the panel is a content-script-injected slide-over on
// Kindoo pages, NOT a Chrome side panel. The service worker owns
// chrome.identity + Firebase Auth + the callable invocations; the
// content script posts messages via chrome.runtime.sendMessage.
//
// The Kindoo origin pattern is a placeholder until the operator
// confirms the production domain. Both `host_permissions` and
// `content_scripts[].matches` must agree once the real origin lands.

import { defineManifest } from '@crxjs/vite-plugin';

// TODO confirm Kindoo origin with operator. Provisional pattern below
// targets *.kindoo.io. Update both `host_permissions` and the
// content_scripts `matches` entry together — they MUST agree, or the
// CS will inject without permission to call back into the SW from
// the page context.
const KINDOO_MATCH_PATTERN = 'https://*.kindoo.io/*';

export default defineManifest({
  manifest_version: 3,
  name: 'Stake Building Access — Kindoo Helper',
  short_name: 'SBA Helper',
  description:
    'Surfaces pending Stake Building Access requests in a slide-over panel on Kindoo so a Kindoo Manager can work the queue alongside the Kindoo admin UI.',
  version: '0.1.0',
  icons: {
    '16': 'icons/icon-16.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  },
  action: {
    // Action click is wired in the SW to post a toggle message to
    // the active tab; the CS opens / closes the slide-over.
    default_title: 'Toggle SBA helper panel',
  },
  permissions: ['identity', 'identity.email', 'storage'],
  host_permissions: [KINDOO_MATCH_PATTERN],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: [KINDOO_MATCH_PATTERN],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  // OAuth client ID gets configured per-build via .env.local; the
  // chrome.identity flow exchanges this for a Google access token
  // and then for a Firebase ID token used to call SBA's callables.
  oauth2: {
    client_id: '__VITE_GOOGLE_OAUTH_CLIENT_ID__',
    scopes: ['openid', 'email', 'profile'],
  },
});
