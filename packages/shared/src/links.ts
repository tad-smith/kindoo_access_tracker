// App-relative paths that both the SPA and Cloud Functions link to.
// Functions can't import from `apps/web/`, so any path that appears in
// an email body AND in the UI lives here.

/**
 * Static end-user requester guide, served by Firebase Hosting from
 * `public/help/` (synced out of `docs/user-guide/`). Outside the SPA
 * router. `apps/web/src/lib/links.ts` re-exports this as
 * `REQUESTER_GUIDE_URL`.
 */
export const REQUESTER_GUIDE_PATH = '/help/requesting-access.html';
