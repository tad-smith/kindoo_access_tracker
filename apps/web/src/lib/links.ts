// Outbound links shared across features. Single source of truth so the
// same URL isn't redeclared per-feature (which would violate the
// no-cross-feature-internal-imports rule when one feature needs
// another's constant).

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
 */
export const REQUESTER_GUIDE_URL = '/help/requesting-access.html';
export const MANAGER_GUIDE_URL = '/help/kindoo-manager-guide.html';
