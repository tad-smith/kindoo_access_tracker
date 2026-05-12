// MV3 manifest source. @crxjs/vite-plugin reads this and emits the final
// dist/manifest.json with bundled asset paths.
//
// Host permission is scoped to Kindoo's domain so the extension only
// activates where it has business. Update the host pattern once we
// confirm Kindoo's actual domain (the operator will surface this during
// the first debug session).

import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Stake Building Access — Kindoo Helper',
  short_name: 'SBA Helper',
  description: 'Surfaces pending Stake Building Access requests in a Chrome side panel on Kindoo so a Kindoo Manager can work the queue alongside the Kindoo admin UI.',
  version: '0.1.0',
  icons: {
    '16': 'icons/icon-16.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  },
  action: {
    default_title: 'Open SBA helper',
  },
  permissions: ['identity', 'identity.email', 'sidePanel', 'storage'],
  // Tighten host_permissions to Kindoo's actual origin once the operator
  // confirms it. Empty array here means the extension does NOT touch any
  // tab content by default — the side panel pulls from the SBA API and
  // displays in its own UI region; no content script is required for the
  // bridge flow.
  host_permissions: [],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  // OAuth client ID gets configured per-build via .env.local; the chrome
  // identity flow exchanges this for a Google access token and then for
  // a Firebase ID token used to call SBA's callables.
  oauth2: {
    client_id: '__VITE_GOOGLE_OAUTH_CLIENT_ID__',
    scopes: ['openid', 'email', 'profile'],
  },
});
