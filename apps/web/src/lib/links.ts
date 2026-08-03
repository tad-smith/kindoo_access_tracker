// Outbound links shared across features. Single source of truth so the
// same URL isn't redeclared per-feature (which would violate the
// no-cross-feature-internal-imports rule when one feature needs
// another's constant).

import { REQUESTER_GUIDE_PATH } from '@kindoo/shared';

/**
 * Chrome Web Store listing for the Stake Building Access extension. Used
 * by the sign-in page footer and the manager queue's read-only note
 * (the actionable complete / reject workflow lives in the extension).
 */
export const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/stake-building-access-%E2%80%94-k/klkkpfdafbjebccodmgkogdklachelpb';

/**
 * Static end-user help guides, served by Firebase Hosting from
 * `public/help/` (synced from `docs/user-guide/` by `sync-help.mjs`).
 * These are real files outside the SPA router — link to them with a
 * plain `<a href>`, NOT TanStack `<Link>`. The PWA service worker
 * denylists `/help/` so navigations resolve to the static HTML rather
 * than the cached SPA shell (see `vite.config.ts`).
 *
 * The requester guide path is sourced from `@kindoo/shared` because the
 * welcome email links it too and the two must not drift.
 */
export const REQUESTER_GUIDE_URL = REQUESTER_GUIDE_PATH;
export const MANAGER_GUIDE_URL = '/help/kindoo-manager-guide.html';
