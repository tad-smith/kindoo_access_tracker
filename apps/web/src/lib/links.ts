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
